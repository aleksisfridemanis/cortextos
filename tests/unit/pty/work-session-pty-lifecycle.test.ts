import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkSessionPTY, buildClaudeWorkSessionLaunch, claudeInitIsIsolated, claudeIsolatedReporterAuthSupported } from '../../../src/pty/work-session-pty.js';
import type { WorkSessionRecord } from '../../../src/work-sessions/types.js';

const native = vi.hoisted(() => ({
  exit: undefined as undefined | ((event: { exitCode: number; signal?: number }) => void),
  kill: vi.fn<(signal?: string) => void>(),
  write: vi.fn(),
}));

describe('WorkSessionPTY owned lifecycle', () => {
  let cwd: string;
  let adapter: WorkSessionPTY;
  let record: WorkSessionRecord;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'work-session-pty-')));
    native.exit = undefined;
    native.kill.mockReset();
    native.write.mockReset();
    record = {
      schema_version: 1, kind: 'work_session', id: 'ws-one', display_name: 'One', org: 'platform',
      harness: 'codex-app-server', model: null, requested_cwd: cwd, canonical_cwd: cwd, room_id: 'room-one',
      lifecycle: 'active', resume_handle: null, mutation_id: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z', last_error: null,
      promoted_employee: null, created_by: 'owner:test',
    };
    adapter = new WorkSessionPTY({ ctxRoot: join(cwd, 'ctx'), frameworkRoot: cwd, instanceId: 'test', record, timeoutMs: 5 });
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function attachNativeProcess(): void {
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve; });
    const state = adapter as unknown as {
      pty: { pid: number; write(data: string): void; kill(signal?: string): void } | null;
      exitPromise: Promise<void>;
      resolveExit: (() => void) | null;
    };
    state.pty = { pid: 123, write: native.write, kill: native.kill };
    state.exitPromise = exitPromise;
    state.resolveExit = resolveExit;
    native.exit = () => {
      state.pty = null;
      state.resolveExit?.();
      state.resolveExit = null;
    };
  }

  it('requires Claude safe mode and rejects every ambient init source', () => {
    const launch = buildClaudeWorkSessionLaunch({ cwd, sessionId: '11111111-1111-4111-8111-111111111111', resume: false });
    expect(launch.args).toContain('--safe-mode');
    expect(claudeInitIsIsolated({ memory_paths: {}, agents: [], plugins: [] })).toBe(true);
    for (const field of ['memory_paths', 'agents', 'plugins', 'skills', 'commands', 'mcp_servers']) {
      expect(claudeInitIsIsolated({ [field]: field === 'memory_paths' ? { auto: '/private/memory' } : ['ambient'] })).toBe(false);
    }
    expect(claudeIsolatedReporterAuthSupported({ loggedIn: true, authMethod: 'claude.ai' })).toBe(false);
    expect(claudeIsolatedReporterAuthSupported({ loggedIn: true, authMethod: 'api_key' })).toBe(true);
  });

  it('fails Claude exact resume before spawning an unacknowledged process', async () => {
    record.harness = 'claude-code';
    adapter = new WorkSessionPTY({ ctxRoot: join(cwd, 'ctx'), frameworkRoot: cwd, instanceId: 'test', record, timeoutMs: 1_000 });
    const spawn = vi.spyOn(adapter as never, 'spawn' as never);
    await expect(adapter.resumeExact(
      { runtime: 'claude-code', session_id: '11111111-1111-4111-8111-111111111111' },
      { id: record.id, mutation_id: record.mutation_id, cwd },
    )).rejects.toThrow(/RUNTIME_AUTH_UNAVAILABLE|RUNTIME_UNSUPPORTED|RESUME_HANDLE_UNAVAILABLE/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not resolve stop or release process ownership until exit is observed', async () => {
    attachNativeProcess();
    let settled = false;
    const stopping = adapter.stop().then(() => { settled = true; });
    await Promise.resolve();
    expect(native.kill).toHaveBeenCalledWith('SIGTERM');
    expect(settled).toBe(false);
    native.exit?.({ exitCode: 0 });
    await stopping;
    expect(adapter.status().running).toBe(false);
  });

  it('escalates to a hard kill and still requires the exit acknowledgement', async () => {
    attachNativeProcess();
    native.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') queueMicrotask(() => native.exit?.({ exitCode: 137, signal: 9 }));
    });
    await adapter.stop();
    expect(native.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('owns the launch handle immediately and confirms termination when initial context injection fails', async () => {
    const handle = { runtime: 'codex-app-server' as const, thread_id: 'thread-exact' };
    vi.spyOn(adapter as never, 'startCodex' as never).mockResolvedValue({ resume_handle: handle } as never);
    (adapter as unknown as { currentOwner: unknown }).currentOwner = {
      pid: process.pid, started_at: 'test-generation', process_group_id: null,
      mutation_id: '11111111-1111-4111-8111-111111111111',
    };
    const persist = vi.spyOn(adapter as never, 'persistRuntimeReceipt' as never).mockImplementation(() => undefined);
    const send = vi.spyOn(adapter, 'send').mockRejectedValue(new Error('injection failed'));
    const stop = vi.spyOn(adapter, 'stop').mockResolvedValue();
    await expect(adapter.startFresh({ id: 'ws-one', mutation_id: '11111111-1111-4111-8111-111111111111', cwd, context: 'initial context' })).rejects.toThrow('injection failed');
    expect(adapter.getResumeHandle()).toEqual(handle);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ mutation_id: '11111111-1111-4111-8111-111111111111' }), handle);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('normalizes completed output events from Codex, Claude, and OpenCode', () => {
    const parser = (adapter as unknown as { completedOutput(value: Record<string, unknown>): { id: string; text: string } | null }).completedOutput.bind(adapter);
    expect(parser({ method: 'item/completed', params: { item: { id: 'codex-1', type: 'agentMessage', text: 'Codex answer' } } }))
      .toEqual({ id: 'codex-1', text: 'Codex answer' });
    expect(parser({ type: 'assistant', uuid: 'claude-1', message: { content: [{ type: 'text', text: 'Claude answer' }] } }))
      .toEqual({ id: 'claude-1', text: 'Claude answer' });
    expect(parser({ type: 'message.part.completed', properties: { part: { id: 'open-1', type: 'text', text: 'OpenCode answer' } } }))
      .toEqual({ id: 'open-1', text: 'OpenCode answer' });
    expect(parser({ type: 'message.part.updated', properties: { part: { id: 'open-1', type: 'text', text: 'Open' } } }))
      .toBeNull();
  });

  it('fails closed on prompt echo, redraws, and arbitrary TUI output', () => {
    const output = vi.fn();
    const internals = adapter as unknown as {
      ready: boolean;
      options: { onOutput?: (value: unknown) => void };
      capture(value: string): void;
    };
    internals.ready = true;
    internals.options.onOutput = output;
    internals.capture('> prompt echo\rstatus redraw\rtool chrome\n');
    expect(output).not.toHaveBeenCalled();
  });

  it('correlates Codex completion by exact thread, turn, and successful status', () => {
    const internals = adapter as unknown as {
      currentThreadId: string;
      codexTurnCompletions: Array<{ threadId: string; turnId: string } | Error>;
      capture(value: string): void;
    };
    internals.currentThreadId = 'thread-exact';
    internals.capture(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn-exact', status: 'completed' } } })}\n`);
    expect(internals.codexTurnCompletions).toEqual([{ threadId: 'other', turnId: 'turn-exact' }]);
    internals.codexTurnCompletions.length = 0;
    internals.capture(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-exact', turn: { id: 'turn-exact', status: 'failed', error: { code: 'model_not_found' } } } })}\n`);
    expect(internals.codexTurnCompletions[0]).toMatchObject({ message: 'MODEL_UNSUPPORTED' });
    internals.codexTurnCompletions.length = 0;
    internals.capture(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-exact', turn: { id: 'turn-exact' } } })}\n`);
    expect(internals.codexTurnCompletions[0]).toMatchObject({ message: 'RUNTIME_REQUEST_REJECTED' });
  });

  it('detects an ACP command catalog instead of accepting ambient OpenCode configuration', () => {
    const internals = adapter as unknown as { ambientOpenCodeCommands: boolean; capture(value: string): void };
    internals.capture(`${JSON.stringify({
      jsonrpc: '2.0', method: 'session/update', params: { update: {
        sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'private-skill' }],
      } },
    })}\n`);
    expect(internals.ambientOpenCodeCommands).toBe(true);
  });

  it('replays a durably spooled completion after room publication fails and the daemon restarts', () => {
    const publish = vi.fn(() => { throw new Error('room unavailable'); });
    const internals = adapter as unknown as {
      options: { onOutput?: (value: { id: string; text: string }) => void };
      emitOutput(value: { id: string; text: string }): void;
    };
    internals.options.onOutput = publish;
    internals.emitOutput({ id: 'native-completion-z', text: 'first durable answer' });
    internals.emitOutput({ id: 'native-completion-a', text: 'second durable answer' });

    const state = join(cwd, 'ctx', 'state', 'work-sessions', record.id);
    expect(readdirSync(join(state, 'output-inbox')).filter(name => /^\d/.test(name))).toHaveLength(2);
    expect(existsSync(join(state, 'output-recovery-required.json'))).toBe(true);

    const recovered = vi.fn();
    const restarted = new WorkSessionPTY({
      ctxRoot: join(cwd, 'ctx'), frameworkRoot: cwd, instanceId: 'test', record,
      onOutput: recovered,
    });
    expect(restarted.reconcileOutputInbox()).toBe(2);
    expect(recovered.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ id: 'native-completion-z', text: 'first durable answer', completed_at: expect.any(String) }),
      expect.objectContaining({ id: 'native-completion-a', text: 'second durable answer', completed_at: expect.any(String) }),
    ]);
    expect(readdirSync(join(state, 'output-inbox')).filter(name => /^\d/.test(name))).toEqual([]);
    expect(existsSync(join(state, 'output-recovery-required.json'))).toBe(false);
  });
});

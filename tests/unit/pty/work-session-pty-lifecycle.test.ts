import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkSessionPTY } from '../../../src/pty/work-session-pty.js';
import type { WorkSessionRecord } from '../../../src/work-sessions/types.js';

const native = vi.hoisted(() => ({
  exit: undefined as undefined | ((event: { exitCode: number; signal?: number }) => void),
  kill: vi.fn<(signal?: string) => void>(),
  write: vi.fn(),
}));

describe('WorkSessionPTY owned lifecycle', () => {
  let cwd: string;
  let adapter: WorkSessionPTY;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'work-session-pty-')));
    native.exit = undefined;
    native.kill.mockReset();
    native.write.mockReset();
    const record: WorkSessionRecord = {
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
  });
});

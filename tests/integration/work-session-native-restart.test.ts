import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkSessionPTY } from '../../src/pty/work-session-pty.js';
import { createWorkSessionRecord } from '../../src/work-sessions/registry.js';
import { WorkSessionManager } from '../../src/work-sessions/manager.js';
import { commitCrewMutationState, prepareCrewMutation, startCrewMutationEffect } from '../../src/audit/crew-mutation-journal.js';
import { digestCrewAuditValue } from '../../src/audit/crew-lifecycle-audit.js';

describe('native Work Session process restart ownership', () => {
  const roots: string[] = [];
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cortext-native-restart-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const cwd = join(root, 'project');
    const ctxRoot = join(root, 'ctx');
    mkdirSync(bin, { recursive: true });
    mkdirSync(cwd);
    const executable = join(bin, 'codex');
    writeFileSync(executable, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const result = request.method === 'thread/start' ? { thread: { id: 'native-thread' } } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    return { root, cwd, ctxRoot };
  }

  it('persists ownership at native spawn and lets a fresh adapter terminate the exact child', async () => {
    const { root, cwd, ctxRoot } = fixture();
    const mutationId = 'd1111111-1111-4111-8111-111111111111';
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: 'Native', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd,
      room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: 'owner:test',
    });
    const adapter = new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record, timeoutMs: 3_000 });
    const started = await adapter.startFresh({ id: record.id, mutation_id: mutationId, cwd });
    expect(started).toMatchObject({
      resume_handle: { runtime: 'codex-app-server', thread_id: 'native-thread' },
      runtime_owner: { mutation_id: mutationId, pid: expect.any(Number), started_at: expect.any(String) },
    });

    const restarted = new WorkSessionPTY({
      ctxRoot, frameworkRoot: root, instanceId: 'test',
      record: { ...record, lifecycle: 'active', resume_handle: started.resume_handle, runtime_owner: started.runtime_owner },
      timeoutMs: 3_000,
    });
    expect(restarted.status()).toMatchObject({ running: true, ownership: 'detached', pid: started.runtime_owner.pid });
    await restarted.stop();
    expect(restarted.status()).toMatchObject({ running: false, ownership: 'dead' });
  }, 10_000);

  it('converges an effect_started create from the durable native spawn receipt without launching twice', async () => {
    const { root, cwd, ctxRoot } = fixture();
    const mutationId = 'd2111111-1111-4111-8111-111111111111';
    const input = {
      display_name: 'Crash boundary', org: 'platform', harness: 'codex-app-server' as const,
      requested_cwd: cwd, actor: 'owner:test',
    };
    const record = createWorkSessionRecord(ctxRoot, {
      id: `ws-${mutationId}`, display_name: input.display_name, org: input.org, harness: input.harness,
      requested_cwd: cwd, room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: input.actor,
    });
    prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: input.actor,
      target: { kind: 'work_session', id: record.id }, action: 'create',
      request_digest: digestCrewAuditValue({ ...input, actor: undefined }),
      before_digest: digestCrewAuditValue(null), intended_after_digest: '1'.repeat(64),
    });
    commitCrewMutationState(ctxRoot, mutationId, '2'.repeat(64));
    startCrewMutationEffect(ctxRoot, mutationId);
    const firstAdapter = new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record, timeoutMs: 3_000 });
    const spawned = await firstAdapter.startFresh({ id: record.id, mutation_id: mutationId, cwd });

    const manager = new WorkSessionManager({
      ctxRoot,
      adapterFactory: current => new WorkSessionPTY({ ctxRoot, frameworkRoot: root, instanceId: 'test', record: current, timeoutMs: 3_000 }),
    });
    const recovered = await manager.create(input, mutationId);
    expect(recovered).toMatchObject({
      lifecycle: 'active', resume_handle: spawned.resume_handle,
      runtime_owner: spawned.runtime_owner,
    });
    await manager.stop(recovered.id, input.actor, 'd2222222-2222-4222-8222-222222222222');
  }, 10_000);
});

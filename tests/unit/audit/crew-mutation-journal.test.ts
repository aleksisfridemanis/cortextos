import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { once } from 'events';
import {
  commitCrewMutationState,
  finalizeCrewMutationAudit,
  getCrewMutation,
  listPendingCrewMutations,
  prepareCrewMutation,
  reconcileCrewMutationJournal,
  recordCrewMutationEffect,
  startCrewMutationEffect,
} from '../../../src/audit/crew-mutation-journal';
import { digestCrewAuditValue } from '../../../src/audit/crew-lifecycle-audit.js';
import { createWorkSessionRecord, readWorkSessions, transitionWorkSession } from '../../../src/work-sessions/registry.js';
import { upsertRoom } from '../../../src/rooms/registry.js';

describe('Crew mutation journal', () => {
  it('persists prepare before state/effect/audit and converges idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-'));
    try {
      const mutationId = '33333333-3333-4333-8333-333333333333';
      const prepared = prepareCrewMutation(root, {
        mutation_id: mutationId,
        idempotency_key: mutationId,
        actor: 'owner:1',
        target: { kind: 'employee', id: 'sam' },
        action: 'create',
        request_digest: 'a'.repeat(64),
        before_digest: 'b'.repeat(64),
        intended_after_digest: 'c'.repeat(64),
      });
      expect(prepared.entry.stage).toBe('prepared');
      expect(prepareCrewMutation(root, prepared.entry).reused).toBe(true);
      expect(() => prepareCrewMutation(root, { ...prepared.entry, request_digest: 'd'.repeat(64) }))
        .toThrow(/conflict/i);

      commitCrewMutationState(root, mutationId, 'e'.repeat(64));
      startCrewMutationEffect(root, mutationId);
      recordCrewMutationEffect(root, mutationId, { receipt_digest: 'f'.repeat(64) });
      finalizeCrewMutationAudit(root, mutationId, {
        result: 'success',
        after_digest: 'e'.repeat(64),
      });
      expect(getCrewMutation(root, mutationId)?.stage).toBe('finalized');
      expect(listPendingCrewMutations(root)).toEqual([]);
      expect(readFileSync(join(root, 'state', 'crew-mutation-journal.json'), 'utf8'))
        .not.toContain('sentinel-secret-value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sanitizes journal structure without rejecting legitimate values containing sensitive words', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-structural-'));
    try {
      const mutationId = '34333333-3333-4333-8333-333333333333';
      expect(() => prepareCrewMutation(root, {
        mutation_id: mutationId,
        idempotency_key: mutationId,
        actor: 'owner:Token migration',
        target: { kind: 'employee', id: 'token-migration-worker' },
        action: 'create',
        request_digest: 'a'.repeat(64),
        before_digest: 'b'.repeat(64),
        intended_after_digest: 'c'.repeat(64),
      })).not.toThrow();
      commitCrewMutationState(root, mutationId, 'c'.repeat(64));
      startCrewMutationEffect(root, mutationId);
      expect(() => recordCrewMutationEffect(root, mutationId, {
        authorization: 'must-never-be-journaled',
      })).toThrow(/forbidden field authorization/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles prepared-without-state as failure and leaves unverified durable state pending', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-reconcile-'));
    try {
      const first = '44444444-4444-4444-8444-444444444444';
      const second = '55555555-5555-4555-8555-555555555555';
      for (const id of [first, second]) {
        prepareCrewMutation(root, {
          mutation_id: id,
          idempotency_key: id,
          actor: 'owner:1',
          target: { kind: 'employee', id: id === first ? 'one' : 'two' },
          action: 'create',
          request_digest: '1'.repeat(64),
          before_digest: '2'.repeat(64),
          intended_after_digest: '3'.repeat(64),
        });
      }
      commitCrewMutationState(root, second, '4'.repeat(64));
      const result = reconcileCrewMutationJournal(root);
      expect(result).toEqual({ finalized: 1, pending: 1 });
      expect(getCrewMutation(root, first)?.final_result?.result).toBe('failure');
      expect(getCrewMutation(root, second)?.final_result).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reclaim a prepared mutation while its owning OS process is alive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-process-lease-'));
    const mutationId = '45444444-4444-4444-8444-444444444444';
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'audit', 'crew-mutation-journal.ts')).href;
    const script = `
      import journal from ${JSON.stringify(moduleUrl)};
      journal.prepareCrewMutation(process.argv[1], {
        mutation_id: ${JSON.stringify(mutationId)}, idempotency_key: ${JSON.stringify(mutationId)},
        actor: 'owner:child', target: { kind: 'employee', id: 'leased' }, action: 'create',
        request_digest: '1'.repeat(64), before_digest: '2'.repeat(64), intended_after_digest: '3'.repeat(64),
      });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const [chunk] = await Promise.race([
        once(child.stdout!, 'data'),
        once(child, 'exit').then(() => { throw new Error('child lease owner exited before readiness'); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('child lease setup timed out')), 5_000)),
      ]);
      expect(String(chunk)).toContain('ready');
      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 0, pending: 1 });
      expect(getCrewMutation(root, mutationId)?.stage).toBe('prepared');
      expect(() => commitCrewMutationState(root, mutationId, '4'.repeat(64))).toThrow('MUTATION_PENDING');
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5_000))]);
      }
      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 1, pending: 0 });
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('certifies an effect only when its receipt matches durable lifecycle state', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-effect-'));
    try {
      const id = '66666666-6666-4666-8666-666666666666';
      const target = `ws-${id}`;
      const handle = { runtime: 'codex-app-server', thread_id: 'thread-exact' };
      prepareCrewMutation(root, {
        mutation_id: id, idempotency_key: id, actor: 'owner:1', target: { kind: 'work_session', id: target }, action: 'create',
        request_digest: '1'.repeat(64), before_digest: '2'.repeat(64), intended_after_digest: '3'.repeat(64),
      });
      commitCrewMutationState(root, id, '4'.repeat(64));
      startCrewMutationEffect(root, id);
      recordCrewMutationEffect(root, id, { mutation_id: id, runtime_started: true, handle_digest: digestCrewAuditValue(handle) });
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, 'config', 'work-sessions.json'), JSON.stringify([{
        schema_version: 1, kind: 'work_session', id: target, display_name: 'One', org: 'platform', harness: 'codex-app-server',
        model: null, requested_cwd: '/project', canonical_cwd: '/project', room_id: `work-${id}`, lifecycle: 'active',
        resume_handle: handle, mutation_id: id, created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z',
        last_error: null, promoted_employee: null, created_by: 'owner:1',
      }]));
      writeFileSync(join(root, 'config', 'rooms.json'), JSON.stringify([{ id: `work-${id}`, work_session_id: target }]));
      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 1, pending: 0 });
      expect(getCrewMutation(root, id)?.final_result).toMatchObject({
        result: 'success',
        result_snapshot: {
          id: target,
          lifecycle: 'active',
          continuation_digest: digestCrewAuditValue(handle),
        },
      });

      const missing = '77777777-7777-4777-8777-777777777777';
      prepareCrewMutation(root, {
        mutation_id: missing, idempotency_key: missing, actor: 'owner:1', target: { kind: 'work_session', id: `ws-${missing}` }, action: 'create',
        request_digest: '5'.repeat(64), before_digest: '6'.repeat(64), intended_after_digest: '7'.repeat(64),
      });
      commitCrewMutationState(root, missing, '8'.repeat(64));
      startCrewMutationEffect(root, missing);
      recordCrewMutationEffect(root, missing, { mutation_id: missing, runtime_started: true, handle_digest: digestCrewAuditValue(handle) });
      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 0, pending: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back mutation-owned Employee files left by process death during publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-employee-crash-'));
    const frameworkRoot = join(root, 'framework');
    const ctxRoot = join(root, 'ctx');
    try {
      const id = '88888888-8888-4888-8888-888888888888';
      prepareCrewMutation(ctxRoot, {
        mutation_id: id, idempotency_key: id, actor: 'owner:1', target: { kind: 'employee', id: 'ada' }, action: 'create',
        request_digest: '1'.repeat(64), before_digest: digestCrewAuditValue(null), intended_after_digest: '3'.repeat(64),
      });
      const agentDir = join(frameworkRoot, 'orgs', 'platform', 'agents', 'ada');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ mutation_id: id }));
      mkdirSync(join(ctxRoot, 'config'), { recursive: true });
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ ada: {
        org: 'platform', room_id: 'agent-ada', mutation_id: id,
      } }));
      writeFileSync(join(ctxRoot, 'config', 'rooms.json'), '[]');

      expect(reconcileCrewMutationJournal(ctxRoot, { frameworkRoot })).toEqual({ finalized: 1, pending: 0 });
      expect(existsSync(agentDir)).toBe(false);
      expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'))).toEqual({});
      expect(getCrewMutation(ctxRoot, id)?.final_result).toMatchObject({ result: 'failure', error_code: 'INTERRUPTED_PUBLICATION' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases a mutation-owned Work Session cwd lease left before room publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-work-crash-'));
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    try {
      const id = '99999999-9999-4999-8999-999999999999';
      const target = `ws-${id}`;
      prepareCrewMutation(root, {
        mutation_id: id, idempotency_key: id, actor: 'owner:1', target: { kind: 'work_session', id: target }, action: 'create',
        request_digest: '1'.repeat(64), before_digest: digestCrewAuditValue(null), intended_after_digest: '3'.repeat(64),
      });
      createWorkSessionRecord(root, {
        id: target, display_name: 'Crashed', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd,
        room_id: `work-${id}`, mutation_id: id, created_by: 'owner:1',
      });

      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 1, pending: 0 });
      expect(readWorkSessions(root)).toEqual([]);
      expect(getCrewMutation(root, id)?.final_result).toMatchObject({ result: 'failure', error_code: 'INTERRUPTED_PUBLICATION' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not certify an old lifecycle receipt against state owned by a later mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-stale-receipt-'));
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    try {
      const createId = 'a1111111-1111-4111-8111-111111111111';
      const stopId = 'a2222222-2222-4222-8222-222222222222';
      const laterId = 'a3333333-3333-4333-8333-333333333333';
      const target = `ws-${createId}`;
      createWorkSessionRecord(root, {
        id: target, display_name: 'Owned', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd,
        room_id: `work-${createId}`, mutation_id: createId, created_by: 'owner:1',
      });
      prepareCrewMutation(root, {
        mutation_id: stopId, idempotency_key: stopId, actor: 'owner:1', target: { kind: 'work_session', id: target }, action: 'stop',
        request_digest: '1'.repeat(64), before_digest: '2'.repeat(64), intended_after_digest: '3'.repeat(64),
      });
      commitCrewMutationState(root, stopId, '4'.repeat(64));
      startCrewMutationEffect(root, stopId);
      recordCrewMutationEffect(root, stopId, { mutation_id: stopId, stopped: true });
      const records = readWorkSessions(root);
      records[0].lifecycle = 'archived';
      records[0].mutation_id = laterId;
      writeFileSync(join(root, 'config', 'work-sessions.json'), JSON.stringify(records));

      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 0, pending: 1 });
      expect(getCrewMutation(root, stopId)?.stage).toBe('effect_recorded');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('advances exact prepared Work Session publications and transitions after process death', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-prepared-state-'));
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    try {
      const createId = 'b1111111-1111-4111-8111-111111111111';
      const target = `ws-${createId}`;
      prepareCrewMutation(root, {
        mutation_id: createId, idempotency_key: createId, actor: 'owner:1', target: { kind: 'work_session', id: target }, action: 'create',
        request_digest: '1'.repeat(64), before_digest: '2'.repeat(64), intended_after_digest: '3'.repeat(64),
      });
      const created = createWorkSessionRecord(root, {
        id: target, display_name: 'Published', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd,
        room_id: `work-${createId}`, mutation_id: createId, created_by: 'owner:1',
      });
      upsertRoom(root, {
        id: created.room_id, kind: 'work_session', title: created.display_name, members: [], work_session_id: target,
        created_at: created.created_at, created_by: created.created_by, mutation_id: createId,
      });
      expect(reconcileCrewMutationJournal(root)).toEqual({ finalized: 0, pending: 1 });
      expect(getCrewMutation(root, createId)?.stage).toBe('state_committed');

      const stopId = 'b2222222-2222-4222-8222-222222222222';
      prepareCrewMutation(root, {
        mutation_id: stopId, idempotency_key: stopId, actor: 'owner:1', target: { kind: 'work_session', id: target }, action: 'stop',
        request_digest: '4'.repeat(64), before_digest: '5'.repeat(64), intended_after_digest: '6'.repeat(64),
      });
      transitionWorkSession(root, target, ['starting'], 'stopping', {}, stopId);
      reconcileCrewMutationJournal(root);
      expect(getCrewMutation(root, stopId)?.stage).toBe('state_committed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

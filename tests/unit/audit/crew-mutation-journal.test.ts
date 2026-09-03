import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
      expect(getCrewMutation(root, id)?.final_result?.result).toBe('success');

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
});

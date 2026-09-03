import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
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

  it('reconciles prepared-without-state as failure and state-without-audit as indeterminate', () => {
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
      expect(result.finalized).toBe(2);
      expect(getCrewMutation(root, first)?.final_result?.result).toBe('failure');
      expect(getCrewMutation(root, second)?.final_result?.result).toBe('indeterminate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

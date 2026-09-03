import { describe, expect, it } from 'vitest';
import { contextDecisionKey, loadPendingContextBinding, pendingContextStorageKey, retainedContextMutationId, storePendingContextBinding } from '../context-ownership-panel';

describe('context decision mutation binding', () => {
  const review = { rule_id: 'employee-core', proposal_digest: 'a'.repeat(64) };

  it('retains an id only for the exact proposal, decision, and replacement', () => {
    const requestKey = contextDecisionKey(review, 'approve_merge');
    const pending = { mutationId: 'original', requestKey };
    expect(retainedContextMutationId(pending, requestKey, () => 'new')).toBe('original');
    expect(retainedContextMutationId(pending, contextDecisionKey(review, 'disable_default'), () => 'new')).toBe('new');
    expect(retainedContextMutationId(pending, contextDecisionKey(review, 'replace_default', 'replacement'), () => 'new')).toBe('new');
  });

  it('persists pending decisions per Employee across a remount', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    const binding = { mutationId: 'durable-id', requestKey: 'exact-request' };
    storePendingContextBinding(storage, 'ada', binding);
    expect(pendingContextStorageKey('ada')).not.toBe(pendingContextStorageKey('grace'));
    expect(loadPendingContextBinding(storage, 'ada')).toEqual(binding);
    expect(loadPendingContextBinding(storage, 'grace')).toBeNull();
  });
});

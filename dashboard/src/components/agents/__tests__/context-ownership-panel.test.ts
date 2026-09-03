import { describe, expect, it } from 'vitest';
import { contextDecisionKey, retainedContextMutationId } from '../context-ownership-panel';

describe('context decision mutation binding', () => {
  const review = { rule_id: 'employee-core', proposal_digest: 'a'.repeat(64) };

  it('retains an id only for the exact proposal, decision, and replacement', () => {
    const requestKey = contextDecisionKey(review, 'approve_merge');
    const pending = { mutationId: 'original', requestKey };
    expect(retainedContextMutationId(pending, requestKey, () => 'new')).toBe('original');
    expect(retainedContextMutationId(pending, contextDecisionKey(review, 'disable_default'), () => 'new')).toBe('new');
    expect(retainedContextMutationId(pending, contextDecisionKey(review, 'replace_default', 'replacement'), () => 'new')).toBe('new');
  });
});

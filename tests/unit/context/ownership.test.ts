import { describe, expect, it } from 'vitest';
import { digestCrewAuditValue } from '../../../src/audit/crew-lifecycle-audit.js';
import { classifyContextOwnership, proposeContextMerge } from '../../../src/context/ownership.js';

describe('context ownership classification', () => {
  it('classifies known framework bytes and permanent instance-owned categories', () => {
    const framework = 'current safe default\n';
    expect(classifyContextOwnership({
      source_ref: 'templates/context/employee-core.md',
      content: framework,
      current_framework_content: framework,
      known_framework_digests: [digestCrewAuditValue(framework)],
      category: 'framework_rule',
    }).owner).toBe('framework');
    for (const category of ['identity', 'goals', 'memory', 'user_rules', 'custom'] as const) {
      expect(classifyContextOwnership({
        source_ref: category,
        content: 'owner bytes',
        current_framework_content: framework,
        known_framework_digests: [],
        category,
      }).owner).toBe('instance');
    }
  });

  it('preserves changed former-framework material as ambiguous and proposes a reviewable merge', () => {
    const classification = classifyContextOwnership({
      source_ref: 'context/employee-core.md',
      content: 'locally changed legacy rule',
      current_framework_content: 'current safe default',
      known_framework_digests: [digestCrewAuditValue('old untouched default')],
      category: 'framework_rule',
    });
    expect(classification.owner).toBe('ambiguous');
    const proposal = proposeContextMerge('current safe default', 'locally changed legacy rule');
    expect(proposal.explanation).toMatch(/owner approval/i);
    expect(proposal.content).toContain('current safe default');
    expect(proposal.content).toContain('locally changed legacy rule');
  });
});

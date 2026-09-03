import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileCrewMutationJournal } from '../../../src/audit/crew-mutation-journal.js';
import { readCrewLifecycleAuditEvents } from '../../../src/audit/crew-lifecycle-audit.js';
import { applyContextOwnerDecision, getContextOwnershipReview } from '../../../src/context/owner-controls.js';

describe('owner context controls', () => {
  let root: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'context-owner-'));
    ctxRoot = join(root, 'ctx');
    frameworkRoot = join(root, 'framework');
    agentDir = join(frameworkRoot, 'orgs', 'platform', 'agents', 'ada');
    mkdirSync(join(frameworkRoot, 'templates', 'context'), { recursive: true });
    mkdirSync(join(agentDir, 'context'), { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'employee-core.md'), 'current safe default\n');
    writeFileSync(join(agentDir, 'context', 'employee-core.md'), 'preserved local addition\n');
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ ada: { org: 'platform' } }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('requires explicit digest-bound owner approval and records one mutation-bound audit', () => {
    const review = getContextOwnershipReview({ ctxRoot, frameworkRoot, agentDir, agentName: 'ada', rule_id: 'employee-core' });
    expect(review.classification).toBe('ambiguous');
    const mutationId = 'b3d8bbcb-9345-450a-bda1-4d8d59cb42a0';
    const result = applyContextOwnerDecision({
      ctxRoot, frameworkRoot, agentDir, agentName: 'ada', actor: 'owner:1',
      decision: 'approve_merge', rule_id: 'employee-core', proposal_digest: review.proposal_digest,
      mutation_id: mutationId,
    });
    expect(result.status).toBe('applied');
    const overrides = JSON.parse(readFileSync(join(ctxRoot, 'config', 'context-overrides.json'), 'utf8'));
    expect(overrides.employees.ada.rules['employee-core']).toMatchObject({ mutation_id: mutationId, decision: 'approve_merge', agent_name: 'ada' });
    expect(readCrewLifecycleAuditEvents(ctxRoot, 'context-override-audit.jsonl')).toEqual([
      expect.objectContaining({ event_id: mutationId, action: 'approve_merge', result: 'success' }),
    ]);
  });

  it('rejects stale proposals and drift-only requests without state mutation', () => {
    expect(() => applyContextOwnerDecision({
      ctxRoot, frameworkRoot, agentDir, agentName: 'ada', actor: 'owner:1',
      decision: 'disable_default', rule_id: 'employee-core', proposal_digest: '0'.repeat(64),
      mutation_id: 'c877d14d-e86f-48ef-9176-0bb1e0570dd6',
    })).toThrow(/STALE_PROPOSAL/);
    expect(() => readFileSync(join(ctxRoot, 'config', 'context-overrides.json'), 'utf8')).toThrow();
  });

  it('leaves a post-state audit failure recoverable and reconciliation completes it once', () => {
    const review = getContextOwnershipReview({ ctxRoot, frameworkRoot, agentDir, agentName: 'ada', rule_id: 'employee-core' });
    const mutationId = '266a6742-b72e-41d3-944e-3fdd54b32d75';
    expect(() => applyContextOwnerDecision({
      ctxRoot, frameworkRoot, agentDir, agentName: 'ada', actor: 'owner:1',
      decision: 'replace_default', replacement: 'owner replacement', rule_id: 'employee-core',
      proposal_digest: review.proposal_digest, mutation_id: mutationId, failAt: 'after-state',
    })).toThrow(/MUTATION_PENDING/);
    const overrides = JSON.parse(readFileSync(join(ctxRoot, 'config', 'context-overrides.json'), 'utf8'));
    expect(overrides.employees.ada.rules['employee-core'].mutation_id).toBe(mutationId);
    reconcileCrewMutationJournal(ctxRoot);
    expect(readCrewLifecycleAuditEvents(ctxRoot, 'context-override-audit.jsonl')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(ctxRoot, 'state', 'crew-mutation-journal.json'), 'utf8'))[0])
      .toMatchObject({ stage: 'finalized', final_result: { result: 'success' } });
  });

  it('scopes owner decisions to the reviewed Employee', () => {
    const graceDir = join(frameworkRoot, 'orgs', 'platform', 'agents', 'grace');
    mkdirSync(join(graceDir, 'context'), { recursive: true });
    writeFileSync(join(graceDir, 'context', 'employee-core.md'), 'grace local addition\n');
    const review = getContextOwnershipReview({ ctxRoot, frameworkRoot, agentDir, agentName: 'ada', rule_id: 'employee-core' });
    applyContextOwnerDecision({
      ctxRoot, frameworkRoot, agentDir, agentName: 'ada', actor: 'owner:1', decision: 'disable_default',
      rule_id: 'employee-core', proposal_digest: review.proposal_digest,
      mutation_id: '866a6742-b72e-41d3-944e-3fdd54b32d75',
    });
    expect(getContextOwnershipReview({ ctxRoot, frameworkRoot, agentDir, agentName: 'ada', rule_id: 'employee-core' }).audit_status).toBe('applied');
    expect(getContextOwnershipReview({ ctxRoot, frameworkRoot, agentDir: graceDir, agentName: 'grace', rule_id: 'employee-core' }).audit_status).toBe('none');
  });
});

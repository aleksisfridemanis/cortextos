import { randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import {
  commitCrewMutationState,
  finalizeCrewMutationAudit,
  getCrewMutation,
  prepareCrewMutation,
} from '../audit/crew-mutation-journal.js';
import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';
import { withFileLockSync } from '../utils/lock.js';
import { classifyContextOwnership, proposeContextMerge } from './ownership.js';

export type ContextOwnerDecision = 'approve_merge' | 'replace_default' | 'disable_default';

interface ContextOverrideRule {
  agent_name: string;
  rule_id: string;
  decision: ContextOwnerDecision;
  content: string | null;
  disabled: boolean;
  prior_digest: string;
  effective_digest: string;
  proposal_digest: string;
  actor: string;
  timestamp: string;
  mutation_id: string;
}

interface ContextOverridesState {
  schema_version: 2;
  employees: Record<string, { rules: Record<string, ContextOverrideRule> }>;
  history?: Record<string, ContextOverrideRule>;
}

export interface ContextOwnershipReview {
  rule_id: string;
  classification: 'framework' | 'ambiguous';
  explanation: string;
  current_default_digest: string;
  preserved_instance_digest: string | null;
  effective_digest: string;
  proposal: string;
  proposal_digest: string;
  available_actions: ContextOwnerDecision[];
  audit_status: 'none' | 'applied';
}

export interface ContextOwnerPaths {
  ctxRoot: string;
  frameworkRoot: string;
  agentDir: string;
  agentName: string;
  rule_id: string;
}

function overridesPath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'context-overrides.json');
}

function readOverrides(ctxRoot: string): ContextOverridesState {
  const path = overridesPath(ctxRoot);
  if (!existsSync(path)) return { schema_version: 2, employees: {}, history: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ContextOverridesState;
    if (parsed.schema_version !== 2 || !parsed.employees || typeof parsed.employees !== 'object') throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error('CONTEXT_OVERRIDES_CORRUPT');
  }
}

function durableWrite(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.context-overrides-${process.pid}-${randomBytes(5).toString('hex')}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(temp, path);
    chmodSync(path, 0o600);
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function assertRuleId(ruleId: string): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(ruleId)) throw new Error('INVALID_RULE_ID');
}

function assertAgentName(agentName: string): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(agentName)) throw new Error('INVALID_AGENT_NAME');
}

function employeeRule(state: ContextOverridesState, agentName: string, ruleId: string): ContextOverrideRule | undefined {
  return state.employees[agentName]?.rules[ruleId];
}

export function getContextOwnershipReview(input: ContextOwnerPaths): ContextOwnershipReview {
  assertRuleId(input.rule_id);
  assertAgentName(input.agentName);
  const frameworkPath = join(input.frameworkRoot, 'templates', 'context', `${input.rule_id}.md`);
  if (!existsSync(frameworkPath)) throw new Error('CONTEXT_RULE_NOT_FOUND');
  const current = readFileSync(frameworkPath, 'utf8');
  const instancePath = join(input.agentDir, 'context', `${input.rule_id}.md`);
  const preserved = existsSync(instancePath) ? readFileSync(instancePath, 'utf8') : null;
  const classification = preserved === null
    ? 'framework'
    : classifyContextOwnership({
      source_ref: instancePath,
      content: preserved,
      current_framework_content: current,
      known_framework_digests: [digestCrewAuditValue(current)],
      category: 'framework_rule',
    }).owner === 'ambiguous' ? 'ambiguous' : 'framework';
  const proposal = preserved === null || classification === 'framework'
    ? { content: current, digest: digestCrewAuditValue(current), explanation: 'Current framework bytes remain effective until an explicit owner decision.' }
    : proposeContextMerge(current, preserved);
  const applied = employeeRule(readOverrides(input.ctxRoot), input.agentName, input.rule_id);
  return {
    rule_id: input.rule_id,
    classification,
    explanation: proposal.explanation,
    current_default_digest: digestCrewAuditValue(current),
    preserved_instance_digest: preserved === null ? null : digestCrewAuditValue(preserved),
    effective_digest: applied?.effective_digest ?? digestCrewAuditValue(current),
    proposal: proposal.content,
    proposal_digest: proposal.digest,
    available_actions: ['approve_merge', 'replace_default', 'disable_default'],
    audit_status: applied ? 'applied' : 'none',
  };
}

export function applyContextOwnerDecision(input: ContextOwnerPaths & {
  actor: string;
  decision: ContextOwnerDecision;
  proposal_digest: string;
  mutation_id: string;
  replacement?: string;
  failAt?: 'before-state' | 'after-state' | 'after-audit';
}) {
  if (!input.actor || /[\r\n\0]/.test(input.actor)) throw new Error('UNAUTHENTICATED');
  if (!['approve_merge', 'replace_default', 'disable_default'].includes(input.decision)) throw new Error('INVALID_DECISION');
  if (!/^[0-9a-f-]{36}$/i.test(input.mutation_id)) throw new Error('INVALID_MUTATION_ID');
  if (input.decision === 'replace_default'
    && (!input.replacement?.trim() || Buffer.byteLength(input.replacement, 'utf8') > 24_576)) {
    throw new Error('INVALID_REPLACEMENT');
  }
  const requestDigest = digestCrewAuditValue({
    agent_name: input.agentName,
    decision: input.decision,
    rule_id: input.rule_id,
    proposal_digest: input.proposal_digest,
    replacement_digest: input.replacement ? digestCrewAuditValue(input.replacement) : null,
  });
  const priorMutation = getCrewMutation(input.ctxRoot, input.mutation_id);
  if (priorMutation) {
    if (priorMutation.request_digest !== requestDigest || priorMutation.actor !== input.actor
      || priorMutation.target.kind !== 'employee' || priorMutation.target.id !== input.agentName) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    if (priorMutation.stage === 'finalized' && priorMutation.final_result?.result === 'success') {
      const state = readOverrides(input.ctxRoot);
      const historical = state.history?.[input.mutation_id];
      const snapshot = priorMutation.final_result.result_snapshot;
      if (!historical || snapshot?.rule_digest !== digestCrewAuditValue(historical)) throw new Error('MUTATION_PENDING');
      return { status: 'applied' as const, rule: historical };
    }
    throw new Error('MUTATION_PENDING');
  }
  const review = getContextOwnershipReview(input);
  if (review.proposal_digest !== input.proposal_digest) throw new Error('STALE_PROPOSAL');
  const effectiveContent = input.decision === 'approve_merge' ? review.proposal
    : input.decision === 'replace_default' ? input.replacement!
      : '';
  const effectiveDigest = digestCrewAuditValue(effectiveContent);
  const stateBefore = readOverrides(input.ctxRoot);
  const beforeDigest = digestCrewAuditValue(employeeRule(stateBefore, input.agentName, input.rule_id) ?? null);
  const record: ContextOverrideRule = {
    agent_name: input.agentName,
    rule_id: input.rule_id,
    decision: input.decision,
    content: input.decision === 'disable_default' ? null : effectiveContent,
    disabled: input.decision === 'disable_default',
    prior_digest: review.current_default_digest,
    effective_digest: effectiveDigest,
    proposal_digest: input.proposal_digest,
    actor: input.actor,
    timestamp: new Date().toISOString(),
    mutation_id: input.mutation_id,
  };
  const intendedDigest = digestCrewAuditValue(record);
  prepareCrewMutation(input.ctxRoot, {
    mutation_id: input.mutation_id,
    idempotency_key: input.mutation_id,
    actor: input.actor,
    target: { kind: 'employee', id: input.agentName },
    action: input.decision,
    request_digest: requestDigest,
    before_digest: beforeDigest,
    intended_after_digest: intendedDigest,
  });
  let stateCommitted = false;
  try {
    if (input.failAt === 'before-state') throw new Error('injected');
    const configDir = join(input.ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    withFileLockSync(configDir, () => {
      const freshReview = getContextOwnershipReview(input);
      if (freshReview.proposal_digest !== input.proposal_digest) throw new Error('STALE_PROPOSAL');
      const current = readOverrides(input.ctxRoot);
      const employee = current.employees[input.agentName] ?? { rules: {} };
      employee.rules[input.rule_id] = record;
      current.employees[input.agentName] = employee;
      current.history = current.history ?? {};
      current.history[input.mutation_id] = record;
      durableWrite(overridesPath(input.ctxRoot), current);
    });
    stateCommitted = true;
    commitCrewMutationState(input.ctxRoot, input.mutation_id, intendedDigest);
    if (input.failAt === 'after-state') throw new Error('injected');
    finalizeCrewMutationAudit(input.ctxRoot, input.mutation_id, {
      result: 'success',
      after_digest: intendedDigest,
      result_snapshot: { rule_digest: intendedDigest, mutation_id: input.mutation_id },
    }, { failAfterAppend: input.failAt === 'after-audit' });
    return { status: 'applied' as const, rule: record };
  } catch (error) {
    if (!stateCommitted) {
      finalizeCrewMutationAudit(input.ctxRoot, input.mutation_id, {
        result: 'failure', after_digest: beforeDigest,
        error_code: 'CONTEXT_DECISION_FAILED', sanitized_error: 'Context decision failed',
      });
      throw error;
    }
    throw new Error('MUTATION_PENDING');
  }
}

export function resolveEmployeeContextPaths(ctxRoot: string, frameworkRoot: string, agentName: string, ruleId = 'employee-core') {
  const registryPath = join(ctxRoot, 'config', 'enabled-agents.json');
  let org: string | undefined;
  try { org = JSON.parse(readFileSync(registryPath, 'utf8'))[agentName]?.org; } catch { throw new Error('EMPLOYEE_NOT_FOUND'); }
  if (!org || !/^[a-z0-9_-]+$/.test(org) || !/^[a-z0-9_-]+$/.test(agentName)) throw new Error('EMPLOYEE_NOT_FOUND');
  return { ctxRoot, frameworkRoot, agentDir: join(frameworkRoot, 'orgs', org, 'agents', agentName), agentName, rule_id: ruleId };
}

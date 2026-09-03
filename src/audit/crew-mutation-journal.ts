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
import { randomBytes } from 'crypto';
import {
  appendCrewLifecycleAuditEvent,
  digestCrewAuditValue,
  type CrewAuditResult,
  type CrewLifecycleAction,
  type CrewTarget,
} from './crew-lifecycle-audit.js';
import { withFileLockSync } from '../utils/lock.js';

export type CrewMutationStage =
  | 'prepared'
  | 'state_committed'
  | 'effect_started'
  | 'effect_recorded'
  | 'audit_written'
  | 'finalized';

export interface CrewMutationFinalResult {
  result: CrewAuditResult;
  after_digest: string;
  error_code?: string | null;
  sanitized_error?: string | null;
  result_snapshot?: Record<string, unknown>;
}

export interface CrewMutationJournalEntry {
  schema_version: 1;
  mutation_id: string;
  idempotency_key: string;
  actor: string;
  target: CrewTarget;
  action: CrewLifecycleAction;
  request_digest: string;
  before_digest: string;
  intended_after_digest: string;
  state_digest: string | null;
  stage: CrewMutationStage;
  pending_audit: {
    actor: string;
    target: CrewTarget;
    action: CrewLifecycleAction;
    request_digest: string;
    before_digest: string;
  };
  effect_receipt: Record<string, unknown> | null;
  final_result?: CrewMutationFinalResult;
  created_at: string;
  updated_at: string;
}

export type PrepareCrewMutationInput = Pick<CrewMutationJournalEntry,
  'mutation_id' | 'idempotency_key' | 'actor' | 'target' | 'action' |
  'request_digest' | 'before_digest' | 'intended_after_digest'> &
  Partial<Pick<CrewMutationJournalEntry, 'stage' | 'state_digest' | 'pending_audit' |
  'effect_receipt' | 'created_at' | 'updated_at' | 'schema_version' | 'final_result'>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function journalPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'crew-mutation-journal.json');
}

function lockPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'crew-mutation-journal-lock');
}

function durableWrite(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.crew-journal-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

function assertEntry(entry: CrewMutationJournalEntry): void {
  if (entry.schema_version !== 1 || !UUID_PATTERN.test(entry.mutation_id)
    || entry.idempotency_key !== entry.mutation_id) {
    throw new Error('Invalid Crew mutation identity');
  }
  for (const digest of [entry.request_digest, entry.before_digest, entry.intended_after_digest]) {
    if (!DIGEST_PATTERN.test(digest)) throw new Error('Invalid Crew mutation digest');
  }
  if (entry.state_digest !== null && !DIGEST_PATTERN.test(entry.state_digest)) {
    throw new Error('Invalid Crew mutation state digest');
  }
  const raw = JSON.stringify(entry);
  if (/(?:secret|token|password|credential|authorization|resume_handle|api_key|private_key|sentinel-secret-value)/i.test(raw)) {
    throw new Error('Crew mutation journal contains sensitive material');
  }
}

export function readCrewMutationJournal(ctxRoot: string): CrewMutationJournalEntry[] {
  const path = journalPath(ctxRoot);
  if (!existsSync(path)) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new Error('Crew mutation journal is corrupt');
  }
  if (!Array.isArray(value)) throw new Error('Crew mutation journal is corrupt');
  for (const item of value) assertEntry(item as CrewMutationJournalEntry);
  return value as CrewMutationJournalEntry[];
}

function locked<T>(ctxRoot: string, callback: (entries: CrewMutationJournalEntry[]) => T): T {
  mkdirSync(lockPath(ctxRoot), { recursive: true, mode: 0o700 });
  return withFileLockSync(lockPath(ctxRoot), () => callback(readCrewMutationJournal(ctxRoot)));
}

function sameBinding(entry: CrewMutationJournalEntry, input: PrepareCrewMutationInput): boolean {
  return entry.idempotency_key === input.idempotency_key
    && entry.actor === input.actor
    && JSON.stringify(entry.target) === JSON.stringify(input.target)
    && entry.action === input.action
    && entry.request_digest === input.request_digest
    && entry.before_digest === input.before_digest
    && entry.intended_after_digest === input.intended_after_digest;
}

export function prepareCrewMutation(
  ctxRoot: string,
  input: PrepareCrewMutationInput,
  now = () => new Date().toISOString(),
): { entry: CrewMutationJournalEntry; reused: boolean } {
  return locked(ctxRoot, entries => {
    const existing = entries.find(item => item.mutation_id === input.mutation_id);
    if (existing) {
      if (!sameBinding(existing, input)) throw new Error('Crew mutation idempotency conflict');
      return { entry: existing, reused: true };
    }
    const timestamp = now();
    const entry: CrewMutationJournalEntry = {
      schema_version: 1,
      mutation_id: input.mutation_id,
      idempotency_key: input.idempotency_key,
      actor: input.actor,
      target: input.target,
      action: input.action,
      request_digest: input.request_digest,
      before_digest: input.before_digest,
      intended_after_digest: input.intended_after_digest,
      state_digest: null,
      stage: 'prepared',
      pending_audit: {
        actor: input.actor,
        target: input.target,
        action: input.action,
        request_digest: input.request_digest,
        before_digest: input.before_digest,
      },
      effect_receipt: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    assertEntry(entry);
    entries.push(entry);
    durableWrite(journalPath(ctxRoot), entries);
    return { entry, reused: false };
  });
}

function updateEntry(
  ctxRoot: string,
  mutationId: string,
  update: (entry: CrewMutationJournalEntry) => void,
): CrewMutationJournalEntry {
  return locked(ctxRoot, entries => {
    const entry = entries.find(item => item.mutation_id === mutationId);
    if (!entry) throw new Error(`Unknown Crew mutation ${mutationId}`);
    update(entry);
    entry.updated_at = new Date().toISOString();
    assertEntry(entry);
    durableWrite(journalPath(ctxRoot), entries);
    return entry;
  });
}

export function getCrewMutation(ctxRoot: string, mutationId: string): CrewMutationJournalEntry | null {
  return readCrewMutationJournal(ctxRoot).find(item => item.mutation_id === mutationId) ?? null;
}

export function listPendingCrewMutations(ctxRoot: string): CrewMutationJournalEntry[] {
  return readCrewMutationJournal(ctxRoot).filter(item => item.stage !== 'finalized');
}

export function commitCrewMutationState(ctxRoot: string, mutationId: string, stateDigest: string): CrewMutationJournalEntry {
  if (!DIGEST_PATTERN.test(stateDigest)) throw new Error('Invalid state digest');
  return updateEntry(ctxRoot, mutationId, entry => {
    if (entry.stage !== 'prepared' && entry.state_digest !== stateDigest) throw new Error('Crew mutation stage conflict');
    entry.state_digest = stateDigest;
    entry.stage = 'state_committed';
  });
}

export function startCrewMutationEffect(ctxRoot: string, mutationId: string): CrewMutationJournalEntry {
  return updateEntry(ctxRoot, mutationId, entry => {
    if (!['state_committed', 'effect_started'].includes(entry.stage)) throw new Error('Crew mutation stage conflict');
    entry.stage = 'effect_started';
  });
}

export function recordCrewMutationEffect(
  ctxRoot: string,
  mutationId: string,
  receipt: Record<string, unknown>,
): CrewMutationJournalEntry {
  return updateEntry(ctxRoot, mutationId, entry => {
    if (entry.stage !== 'effect_started' && entry.stage !== 'effect_recorded') throw new Error('Crew mutation stage conflict');
    if (entry.effect_receipt && JSON.stringify(entry.effect_receipt) !== JSON.stringify(receipt)) {
      throw new Error('Crew mutation effect receipt conflict');
    }
    entry.effect_receipt = receipt;
    entry.stage = 'effect_recorded';
  });
}

export function finalizeCrewMutationAudit(
  ctxRoot: string,
  mutationId: string,
  finalResult: CrewMutationFinalResult,
  options: { failAfterAppend?: boolean } = {},
): CrewMutationJournalEntry {
  const entry = getCrewMutation(ctxRoot, mutationId);
  if (!entry) throw new Error(`Unknown Crew mutation ${mutationId}`);
  if (entry.stage === 'finalized') return entry;
  const auditFile = ['approve_merge', 'replace_default', 'disable_default'].includes(entry.action)
    ? 'context-override-audit.jsonl'
    : 'crew-lifecycle-audit.jsonl';
  appendCrewLifecycleAuditEvent(ctxRoot, {
    schema_version: 1,
    event_id: entry.mutation_id,
    actor: entry.actor,
    target: entry.target,
    action: entry.action,
    request_digest: entry.request_digest,
    before_digest: entry.before_digest,
    after_digest: finalResult.after_digest,
    timestamp: entry.updated_at,
    result: finalResult.result,
    error_code: finalResult.error_code ?? null,
    sanitized_error: finalResult.sanitized_error ?? null,
  }, auditFile);
  updateEntry(ctxRoot, mutationId, current => {
    current.stage = 'audit_written';
    current.final_result = finalResult;
  });
  if (options.failAfterAppend) throw new Error('Injected failure after audit append');
  return updateEntry(ctxRoot, mutationId, current => {
    current.stage = 'finalized';
    current.final_result = finalResult;
  });
}

export function reconcileCrewMutationJournal(ctxRoot: string): { finalized: number; pending: number } {
  let finalized = 0;
  for (const entry of listPendingCrewMutations(ctxRoot)) {
    if (entry.stage === 'audit_written' && entry.final_result) {
      updateEntry(ctxRoot, entry.mutation_id, current => { current.stage = 'finalized'; });
      finalized += 1;
      continue;
    }
    if (entry.target.kind === 'employee'
      && ['approve_merge', 'replace_default', 'disable_default'].includes(entry.action)
      && ['prepared', 'state_committed'].includes(entry.stage)) {
      let storedDigest: string | null = null;
      try {
        const state = JSON.parse(readFileSync(join(ctxRoot, 'config', 'context-overrides.json'), 'utf8'));
        const rule = state?.schema_version === 2
          ? state.employees?.[entry.target.id]?.rules?.['employee-core']
          : null;
        if (rule?.mutation_id === entry.mutation_id) storedDigest = digestCrewAuditValue(rule);
      } catch { /* corrupt or absent state cannot be certified */ }
      if (storedDigest === entry.intended_after_digest) {
        if (entry.stage === 'prepared') commitCrewMutationState(ctxRoot, entry.mutation_id, storedDigest);
        finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, { result: 'success', after_digest: storedDigest });
        finalized += 1;
      }
      continue;
    }
    const result: CrewMutationFinalResult = entry.stage === 'prepared'
      ? { result: 'failure', after_digest: entry.before_digest, error_code: 'INTERRUPTED_BEFORE_STATE', sanitized_error: 'Interrupted before durable state' }
      : entry.stage === 'effect_recorded'
        ? { result: 'success', after_digest: entry.state_digest ?? entry.intended_after_digest }
        : { result: 'indeterminate', after_digest: entry.state_digest ?? entry.intended_after_digest, error_code: 'RECOVERY_REQUIRED', sanitized_error: 'Operator recovery required' };
    finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, result);
    finalized += 1;
  }
  return { finalized, pending: listPendingCrewMutations(ctxRoot).length };
}

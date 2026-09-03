import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import {
  appendCrewLifecycleAuditEvent,
  digestCrewAuditValue,
  type CrewAuditResult,
  type CrewLifecycleAction,
  type CrewTarget,
} from './crew-lifecycle-audit.js';
import { withFileLockSync } from '../utils/lock.js';
import { removeStartingWorkSessionRecord } from '../work-sessions/registry.js';

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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function workSessionDigest(record: Record<string, unknown>): string {
  return digestCrewAuditValue({
    ...record,
    resume_handle: record.resume_handle ? digestCrewAuditValue(record.resume_handle) : null,
  });
}

function workSessionSnapshot(record: Record<string, unknown>): Record<string, unknown> {
  const { resume_handle: handle, ...snapshot } = record;
  return { ...snapshot, continuation_digest: handle ? digestCrewAuditValue(handle) : null };
}

type ReconciliationCertification = CrewMutationFinalResult | 'pending' | null;

function certifyEmployeeCreate(
  ctxRoot: string,
  entry: CrewMutationJournalEntry,
  frameworkRoot?: string,
): ReconciliationCertification {
  try {
    const registry = readJson(join(ctxRoot, 'config', 'enabled-agents.json')) as Record<string, Record<string, unknown>>;
    const rooms = readJson(join(ctxRoot, 'config', 'rooms.json')) as Array<Record<string, unknown>>;
    const employee = registry?.[entry.target.id];
    const room = Array.isArray(rooms) && employee
      ? rooms.find(item => item.id === employee.room_id && item.kind === 'agent' && item.agent === entry.target.id)
      : null;
    if (!employee || employee.mutation_id !== entry.mutation_id || !room || !frameworkRoot
      || typeof employee.org !== 'string'
      || !existsSync(join(frameworkRoot, 'orgs', employee.org, 'agents', entry.target.id))
      || digestCrewAuditValue(employee) !== entry.intended_after_digest) return null;
    if (entry.stage === 'prepared') commitCrewMutationState(ctxRoot, entry.mutation_id, entry.intended_after_digest);
    if (entry.stage !== 'effect_recorded') return 'pending';
    const receipt = entry.effect_receipt;
    if (receipt?.mutation_id !== entry.mutation_id || typeof receipt.started !== 'boolean'
      || receipt.receipt_digest !== digestCrewAuditValue({ mutation_id: entry.mutation_id, started: receipt.started })) return null;
    return { result: 'success', after_digest: entry.intended_after_digest };
  } catch { return null; }
}

function reconcilePartialEmployeeCreate(
  ctxRoot: string,
  entry: CrewMutationJournalEntry,
  frameworkRoot?: string,
): 'rolled_back' | 'pending' | null {
  if (entry.stage !== 'prepared' || !frameworkRoot) return null;
  const configDir = join(ctxRoot, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(configDir, () => {
    let registry: Record<string, Record<string, unknown>> = {};
    let rooms: Array<Record<string, unknown>> = [];
    try {
      const registryPath = join(configDir, 'enabled-agents.json');
      const roomsPath = join(configDir, 'rooms.json');
      if (existsSync(registryPath)) registry = readJson(registryPath) as Record<string, Record<string, unknown>>;
      if (existsSync(roomsPath)) rooms = readJson(roomsPath) as Array<Record<string, unknown>>;
      if (!registry || typeof registry !== 'object' || Array.isArray(registry) || !Array.isArray(rooms)) return 'pending';
    } catch { return 'pending'; }

    const employee = registry[entry.target.id];
    if (employee && employee.mutation_id !== entry.mutation_id) return 'pending';
    const matchingRooms = rooms.filter(room => room.id === employee?.room_id || room.mutation_id === entry.mutation_id);
    if (matchingRooms.some(room => room.mutation_id !== entry.mutation_id)) return 'pending';

    const orgsDir = join(frameworkRoot, 'orgs');
    const finalDirs: string[] = [];
    const stageDirs: string[] = [];
    try {
      for (const org of readdirSync(orgsDir, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const agentsDir = join(orgsDir, org.name, 'agents');
        const finalDir = join(agentsDir, entry.target.id);
        const stageDir = join(agentsDir, `.creating-${entry.target.id}-${entry.mutation_id}`);
        if (existsSync(stageDir)) stageDirs.push(stageDir);
        if (!existsSync(finalDir)) continue;
        let config: Record<string, unknown>;
        try { config = readJson(join(finalDir, 'config.json')) as Record<string, unknown>; } catch { return 'pending'; }
        if (config.mutation_id !== entry.mutation_id) return 'pending';
        finalDirs.push(finalDir);
      }
    } catch { return 'pending'; }
    if (finalDirs.length > 1) return 'pending';

    const ownedRoomIndexes = rooms
      .map((room, index) => room.mutation_id === entry.mutation_id ? index : -1)
      .filter(index => index >= 0);
    const hasOwnedArtifacts = !!employee || finalDirs.length > 0 || stageDirs.length > 0 || ownedRoomIndexes.length > 0;
    if (!hasOwnedArtifacts) return null;

    if (employee) delete registry[entry.target.id];
    const sessionsPath = join(configDir, 'work-sessions.json');
    let sessions: Array<Record<string, unknown>> = [];
    try {
      if (existsSync(sessionsPath)) sessions = readJson(sessionsPath) as Array<Record<string, unknown>>;
    } catch { return 'pending'; }
    rooms = rooms.flatMap(room => {
      if (room.mutation_id !== entry.mutation_id) return [room];
      if (typeof room.work_session_id === 'string') {
        const source = sessions.find(session => session.id === room.work_session_id);
        if (!source || source.room_id !== room.id || typeof source.display_name !== 'string') return [];
        return [{
          ...room,
          kind: 'work_session',
          title: source.display_name,
          members: (Array.isArray(room.members) ? room.members : []).filter(member => member !== entry.target.id),
          agent: undefined,
          mutation_id: source.mutation_id,
        }];
      }
      return [];
    });
    durableWrite(join(configDir, 'enabled-agents.json'), registry);
    durableWrite(join(configDir, 'rooms.json'), rooms);
    const finalTargets = new Set(finalDirs);
    for (const stageDir of stageDirs) finalTargets.add(join(dirname(stageDir), entry.target.id));
    const hostSkillsDir = join(homedir(), '.codex', 'skills');
    if (existsSync(hostSkillsDir)) {
      for (const item of readdirSync(hostSkillsDir, { withFileTypes: true })) {
        if (!item.name.startsWith(`${entry.target.id}__`)) continue;
        const link = join(hostSkillsDir, item.name);
        let target: string;
        try {
          if (!lstatSync(link).isSymbolicLink()) continue;
          target = resolve(dirname(link), readlinkSync(link));
        } catch { continue; }
        if ([...finalTargets].some(finalDir => target === finalDir || target.startsWith(`${finalDir}/`))) unlinkSync(link);
      }
    }
    for (const dir of [...finalDirs, ...stageDirs]) rmSync(dir, { recursive: true, force: true });
    return 'rolled_back';
  });
}

function reconcilePreparedWorkSessionCreate(ctxRoot: string, entry: CrewMutationJournalEntry): 'rolled_back' | 'pending' | null {
  if (entry.stage !== 'prepared' || entry.action !== 'create') return null;
  let records: Array<Record<string, unknown>>;
  let rooms: Array<Record<string, unknown>>;
  try {
    records = readJson(join(ctxRoot, 'config', 'work-sessions.json')) as Array<Record<string, unknown>>;
    rooms = existsSync(join(ctxRoot, 'config', 'rooms.json'))
      ? readJson(join(ctxRoot, 'config', 'rooms.json')) as Array<Record<string, unknown>>
      : [];
    if (!Array.isArray(records) || !Array.isArray(rooms)) return 'pending';
  } catch { return 'pending'; }
  const record = records.find(item => item.id === entry.target.id);
  if (!record) return null;
  if (record.mutation_id !== entry.mutation_id || record.lifecycle !== 'starting') return 'pending';
  const room = rooms.find(item => item.id === record.room_id);
  if (room) return room.mutation_id === entry.mutation_id && room.work_session_id === record.id ? null : 'pending';
  removeStartingWorkSessionRecord(ctxRoot, entry.target.id, entry.mutation_id);
  return 'rolled_back';
}

function certifyWorkSession(ctxRoot: string, entry: CrewMutationJournalEntry): ReconciliationCertification {
  let record: Record<string, unknown> | undefined;
  try {
    const records = readJson(join(ctxRoot, 'config', 'work-sessions.json')) as Array<Record<string, unknown>>;
    record = Array.isArray(records) ? records.find(item => item.id === entry.target.id) : undefined;
  } catch { return null; }
  if (!record) return null;
  if (['create', 'stop', 'resume', 'promote'].includes(entry.action)
    && record.mutation_id !== entry.mutation_id) return null;
  const receipt = entry.effect_receipt;
  if (entry.stage !== 'effect_recorded' || !receipt) return 'pending';
  const afterDigest = workSessionDigest(record);
  if (entry.action === 'create') {
    if (receipt.mutation_id !== entry.mutation_id || typeof receipt.runtime_started !== 'boolean') return null;
    if (receipt.runtime_started) {
      if (record.lifecycle !== 'active' || !record.resume_handle
        || receipt.handle_digest !== digestCrewAuditValue(record.resume_handle)) return null;
      try {
        const rooms = readJson(join(ctxRoot, 'config', 'rooms.json')) as Array<Record<string, unknown>>;
        if (!Array.isArray(rooms) || !rooms.some(room => room.id === record!.room_id && room.work_session_id === record!.id)) return null;
      } catch { return null; }
      return { result: 'success', after_digest: afterDigest };
    }
    return record.lifecycle === 'failed'
      ? { result: 'failure', after_digest: afterDigest, error_code: 'RUNTIME_START_FAILED', sanitized_error: 'Runtime start failed' }
      : null;
  }
  if (entry.action === 'stop') {
    if (receipt.mutation_id !== entry.mutation_id || typeof receipt.stopped !== 'boolean') return null;
    if (receipt.stopped && record.lifecycle === 'archived') {
      return { result: 'success', after_digest: afterDigest, result_snapshot: workSessionSnapshot(record) };
    }
    return !receipt.stopped && record.lifecycle === 'failed'
      ? { result: 'failure', after_digest: afterDigest, error_code: 'RUNTIME_STOP_FAILED', sanitized_error: 'Runtime stop failed' }
      : null;
  }
  if (entry.action === 'resume') {
    if (receipt.mutation_id !== entry.mutation_id || typeof receipt.resumed !== 'boolean') return null;
    if (receipt.resumed && record.lifecycle === 'active'
      && receipt.handle_digest === digestCrewAuditValue(record.resume_handle)) {
      return { result: 'success', after_digest: afterDigest, result_snapshot: workSessionSnapshot(record) };
    }
    return !receipt.resumed && record.lifecycle === 'failed'
      ? { result: 'failure', after_digest: afterDigest, error_code: 'RESUME_HANDLE_UNAVAILABLE', sanitized_error: 'Exact runtime resume failed' }
      : null;
  }
  if (entry.action === 'message') {
    if (receipt.mutation_id !== entry.mutation_id || receipt.delivered !== true || typeof record.room_id !== 'string') return null;
    if (entry.state_digest !== afterDigest) return null;
    try {
      const lines = readFileSync(join(ctxRoot, 'rooms', record.room_id, 'log.jsonl'), 'utf8').split('\n');
      if (!lines.some(line => {
        try { return JSON.parse(line)?.id === entry.mutation_id; } catch { return false; }
      })) return null;
    } catch { return null; }
    return { result: 'success', after_digest: afterDigest };
  }
  if (entry.action === 'promote') {
    if (receipt.mutation_id !== entry.mutation_id || typeof receipt.employee_created !== 'boolean') return null;
    if (receipt.employee_created && record.lifecycle === 'archived' && typeof record.promoted_employee === 'string') {
      return { result: 'success', after_digest: afterDigest };
    }
    return !receipt.employee_created
      ? { result: 'failure', after_digest: afterDigest, error_code: 'PROMOTION_FAILED', sanitized_error: 'Employee promotion failed' }
      : null;
  }
  return null;
}

export function reconcileCrewMutationJournal(
  ctxRoot: string,
  options: { frameworkRoot?: string } = {},
): { finalized: number; pending: number } {
  let finalized = 0;
  for (const entry of listPendingCrewMutations(ctxRoot)) {
    if (entry.stage === 'audit_written' && entry.final_result) {
      updateEntry(ctxRoot, entry.mutation_id, current => { current.stage = 'finalized'; });
      finalized += 1;
      continue;
    }
    if (entry.target.kind === 'work_session' && entry.action === 'message'
      && entry.stage === 'effect_started' && !entry.effect_receipt) {
      finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, {
        result: 'indeterminate', after_digest: entry.state_digest ?? entry.before_digest,
        error_code: 'DELIVERY_RETRY_REQUIRED', sanitized_error: 'Delivery outcome requires owner retry',
      });
      finalized += 1;
      continue;
    }
    if (entry.target.kind === 'employee'
      && ['approve_merge', 'replace_default', 'disable_default'].includes(entry.action)
      && ['prepared', 'state_committed'].includes(entry.stage)) {
      let storedDigest: string | null = null;
      try {
        const state = JSON.parse(readFileSync(join(ctxRoot, 'config', 'context-overrides.json'), 'utf8'));
        const historical = state?.schema_version === 2 ? state.history?.[entry.mutation_id] : null;
        const rules = state?.schema_version === 2 ? state.employees?.[entry.target.id]?.rules : null;
        const rule = historical ?? (rules && typeof rules === 'object'
          ? Object.values(rules as Record<string, { mutation_id?: string }>).find(item => item?.mutation_id === entry.mutation_id)
          : null);
        if (rule?.mutation_id === entry.mutation_id) storedDigest = digestCrewAuditValue(rule);
      } catch { /* corrupt or absent state cannot be certified */ }
      if (storedDigest === entry.intended_after_digest) {
        if (entry.stage === 'prepared') commitCrewMutationState(ctxRoot, entry.mutation_id, storedDigest);
        finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, {
          result: 'success', after_digest: storedDigest,
          result_snapshot: { rule_digest: storedDigest, mutation_id: entry.mutation_id },
        });
        finalized += 1;
      }
      continue;
    }
    if (entry.target.kind === 'employee' && entry.action === 'create') {
      const partial = reconcilePartialEmployeeCreate(
        ctxRoot,
        entry,
        options.frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT ?? process.env.CTX_PROJECT_ROOT,
      );
      if (partial === 'pending') continue;
      if (partial === 'rolled_back') {
        finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, {
          result: 'failure', after_digest: entry.before_digest,
          error_code: 'INTERRUPTED_PUBLICATION', sanitized_error: 'Interrupted Employee publication was rolled back',
        });
        finalized += 1;
        continue;
      }
    }
    if (entry.target.kind === 'work_session' && entry.action === 'create') {
      const partial = reconcilePreparedWorkSessionCreate(ctxRoot, entry);
      if (partial === 'pending') continue;
      if (partial === 'rolled_back') {
        finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, {
          result: 'failure', after_digest: entry.before_digest,
          error_code: 'INTERRUPTED_PUBLICATION', sanitized_error: 'Interrupted Work Session publication was rolled back',
        });
        finalized += 1;
        continue;
      }
    }
    const certified = entry.target.kind === 'employee' && entry.action === 'create'
      ? certifyEmployeeCreate(ctxRoot, entry, options.frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT ?? process.env.CTX_PROJECT_ROOT)
      : entry.target.kind === 'work_session'
        ? certifyWorkSession(ctxRoot, entry)
        : null;
    if (certified === 'pending') continue;
    if (certified) {
      finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, certified);
      finalized += 1;
      continue;
    }
    if (entry.stage === 'prepared' && entry.action === 'create') {
      finalizeCrewMutationAudit(ctxRoot, entry.mutation_id, {
        result: 'failure', after_digest: entry.before_digest,
        error_code: 'INTERRUPTED_BEFORE_STATE', sanitized_error: 'Interrupted before durable state',
      });
      finalized += 1;
    }
  }
  return { finalized, pending: listPendingCrewMutations(ctxRoot).length };
}

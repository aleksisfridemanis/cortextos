import { randomBytes } from 'crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeSync,
} from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { withFileLockSync } from '../utils/lock.js';
import { WORK_SESSION_HARNESSES, type WorkSessionLifecycle, type WorkSessionRecord } from './types.js';

const SAFE_ID = /^[a-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkSessionRegistryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorkSessionRegistryError';
  }
}

function pathFor(ctxRoot: string): string { return join(ctxRoot, 'config', 'work-sessions.json'); }
function lockFor(ctxRoot: string): string { return join(ctxRoot, 'config', 'work-sessions-lock'); }

function assertRecord(value: unknown): asserts value is WorkSessionRecord {
  const row = value as WorkSessionRecord;
  if (!row || row.schema_version !== 1 || !SAFE_ID.test(row.id) || !SAFE_ID.test(row.room_id)
    || row.kind !== 'work_session' || !WORK_SESSION_HARNESSES.includes(row.harness) || !isAbsolute(row.requested_cwd)
    || !isAbsolute(row.canonical_cwd) || !UUID.test(row.mutation_id)
    || typeof row.created_by !== 'string' || !row.created_by || typeof row.display_name !== 'string'
    || typeof row.org !== 'string' || !SAFE_ID.test(row.org)
    || !['starting', 'active', 'stopping', 'archived', 'failed'].includes(row.lifecycle)) {
    throw new WorkSessionRegistryError('REGISTRY_CORRUPT', 'Work Session registry requires operator recovery');
  }
  if (row.runtime_owner && (!Number.isSafeInteger(row.runtime_owner.pid) || row.runtime_owner.pid < 1
    || typeof row.runtime_owner.started_at !== 'string' || !row.runtime_owner.started_at
    || !UUID.test(row.runtime_owner.mutation_id))) {
    throw new WorkSessionRegistryError('REGISTRY_CORRUPT', 'Work Session registry requires operator recovery');
  }
  const handle = row.resume_handle;
  if (handle && !(
    (row.harness === 'claude-code' && handle.runtime === 'claude-code' && typeof handle.session_id === 'string' && UUID.test(handle.session_id))
    || (row.harness === 'codex-app-server' && handle.runtime === 'codex-app-server' && typeof handle.thread_id === 'string' && handle.thread_id.length > 0)
    || (row.harness === 'opencode' && handle.runtime === 'opencode' && typeof handle.session_id === 'string' && handle.session_id.length > 0)
  )) throw new WorkSessionRegistryError('REGISTRY_CORRUPT', 'Work Session registry requires operator recovery');
}

export function readWorkSessions(ctxRoot: string): WorkSessionRecord[] {
  const path = pathFor(ctxRoot);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new WorkSessionRegistryError('REGISTRY_CORRUPT', 'Work Session registry requires operator recovery');
  }
  if (!Array.isArray(parsed)) throw new WorkSessionRegistryError('REGISTRY_CORRUPT', 'Work Session registry requires operator recovery');
  parsed.forEach(assertRecord);
  return parsed;
}

export const listWorkSessions = readWorkSessions;

function durableWrite(ctxRoot: string, records: WorkSessionRecord[]): void {
  const path = pathFor(ctxRoot);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.work-sessions-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(records, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temp, path);
    chmodSync(path, 0o600);
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

function locked<T>(ctxRoot: string, fn: (records: WorkSessionRecord[]) => T): T {
  mkdirSync(lockFor(ctxRoot), { recursive: true, mode: 0o700 });
  return withFileLockSync(lockFor(ctxRoot), () => fn(readWorkSessions(ctxRoot)));
}

export function createWorkSessionRecord(
  ctxRoot: string,
  input: Pick<WorkSessionRecord, 'id' | 'display_name' | 'org' | 'harness' | 'requested_cwd' | 'room_id' | 'mutation_id' | 'created_by'> & { model?: string },
  now = () => new Date().toISOString(),
): WorkSessionRecord {
  if (!SAFE_ID.test(input.id) || !SAFE_ID.test(input.room_id) || !UUID.test(input.mutation_id)
    || typeof input.display_name !== 'string' || input.display_name.length < 1 || input.display_name.length > 64
    || typeof input.org !== 'string' || !SAFE_ID.test(input.org)
    || !WORK_SESSION_HARNESSES.includes(input.harness) || !isAbsolute(input.requested_cwd)) {
    throw new WorkSessionRegistryError('INVALID_INPUT', 'Invalid Work Session request');
  }
  let canonical: string;
  try { canonical = realpathSync(input.requested_cwd); } catch {
    throw new WorkSessionRegistryError('CWD_NOT_FOUND', 'Working directory does not exist');
  }
  return locked(ctxRoot, records => {
    const sameMutation = records.find(row => row.mutation_id === input.mutation_id);
    if (sameMutation) {
      const sameRequest = sameMutation.id === input.id
        && sameMutation.display_name === input.display_name.trim()
        && sameMutation.org === input.org
        && sameMutation.harness === input.harness
        && sameMutation.model === (input.model ?? null)
        && sameMutation.canonical_cwd === canonical
        && sameMutation.room_id === input.room_id
        && sameMutation.created_by === input.created_by;
      if (!sameRequest) throw new WorkSessionRegistryError('IDEMPOTENCY_CONFLICT', 'Mutation id is already bound to another Work Session');
      return sameMutation;
    }
    if (records.some(row => row.id === input.id)) throw new WorkSessionRegistryError('DUPLICATE_ID', 'Work Session already exists');
    if (records.some(row => ['starting', 'active', 'stopping'].includes(row.lifecycle) && row.canonical_cwd === canonical)) {
      throw new WorkSessionRegistryError('CWD_LEASE_CONFLICT', 'Working directory already has an active Work Session');
    }
    const timestamp = now();
    const record: WorkSessionRecord = {
      schema_version: 1, kind: 'work_session', id: input.id, display_name: input.display_name.trim(), org: input.org, harness: input.harness,
      model: input.model ?? null, requested_cwd: input.requested_cwd, canonical_cwd: canonical, room_id: input.room_id,
      lifecycle: 'starting', resume_handle: null, runtime_owner: null, mutation_id: input.mutation_id,
      created_at: timestamp, updated_at: timestamp, last_error: null, promoted_employee: null, created_by: input.created_by,
    };
    records.push(record);
    durableWrite(ctxRoot, records);
    return record;
  });
}

export function transitionWorkSession(
  ctxRoot: string, id: string, from: WorkSessionLifecycle[], to: WorkSessionLifecycle,
  patch: Partial<Pick<WorkSessionRecord, 'resume_handle' | 'runtime_owner' | 'last_error' | 'promoted_employee'>>,
  mutationId: string,
): WorkSessionRecord {
  return locked(ctxRoot, records => {
    const record = records.find(row => row.id === id);
    if (!record) throw new WorkSessionRegistryError('NOT_FOUND', 'Work Session not found');
    if (!from.includes(record.lifecycle)) throw new WorkSessionRegistryError('INVALID_TRANSITION', `Cannot transition Work Session from ${record.lifecycle}`);
    Object.assign(record, patch, { lifecycle: to, mutation_id: mutationId, updated_at: new Date().toISOString() });
    assertRecord(record);
    durableWrite(ctxRoot, records);
    return record;
  });
}

/** Compensate a create that failed before its room relation was published. */
export function removeStartingWorkSessionRecord(ctxRoot: string, id: string, mutationId: string): void {
  locked(ctxRoot, records => {
    const index = records.findIndex(row => row.id === id);
    if (index < 0) return;
    const record = records[index];
    if (record.lifecycle !== 'starting' || record.mutation_id !== mutationId) {
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session create compensation requires recovery');
    }
    records.splice(index, 1);
    durableWrite(ctxRoot, records);
  });
}


export function setWorkSessionResumeHandle(ctxRoot: string, id: string, handle: WorkSessionRecord['resume_handle'], mutationId: string) {
  return transitionWorkSession(ctxRoot, id, ['starting'], 'active', { resume_handle: handle }, mutationId);
}
export function archiveWorkSession(ctxRoot: string, id: string, mutationId: string) {
  return transitionWorkSession(ctxRoot, id, ['starting', 'active', 'stopping'], 'archived', {}, mutationId);
}
export function recordPromotion(ctxRoot: string, id: string, employee: string, mutationId: string) {
  return transitionWorkSession(ctxRoot, id, ['archived'], 'archived', { promoted_employee: employee }, mutationId);
}

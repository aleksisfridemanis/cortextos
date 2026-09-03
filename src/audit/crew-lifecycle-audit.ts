import { createHash } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'fs';
import { join } from 'path';
import { withFileLockSync } from '../utils/lock.js';

export type CrewTarget =
  | { kind: 'employee'; id: string }
  | { kind: 'work_session'; id: string };

export type CrewLifecycleAction =
  | 'create'
  | 'stop'
  | 'resume'
  | 'promote'
  | 'message'
  | 'approve_merge'
  | 'replace_default'
  | 'disable_default';

export type CrewAuditResult = 'success' | 'failure' | 'denied' | 'indeterminate';

export interface CrewLifecycleAuditEvent {
  schema_version: 1;
  event_id: string;
  actor: string;
  target: CrewTarget;
  action: CrewLifecycleAction;
  request_digest: string;
  before_digest: string;
  after_digest: string;
  timestamp: string;
  result: CrewAuditResult;
  error_code: string | null;
  sanitized_error: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9_-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const SENSITIVE_PATTERN = /(?:secret|token|password|credential|authorization|resume[_ -]?handle|api[_ -]?key|private[_ -]?key|sentinel|\/(?:Users|home)\/|[A-Za-z]:\\)/i;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function canonicalCrewAuditJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function digestCrewAuditValue(value: unknown): string {
  return createHash('sha256').update(canonicalCrewAuditJson(value), 'utf8').digest('hex');
}

function auditPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'crew-lifecycle-audit.jsonl');
}

function assertAuditEvent(event: CrewLifecycleAuditEvent): void {
  if (event.schema_version !== 1 || !UUID_PATTERN.test(event.event_id)) {
    throw new Error('Invalid Crew audit event id or schema version');
  }
  if (!event.actor || event.actor.length > 160 || /[\r\n\0]/.test(event.actor)) {
    throw new Error('Invalid Crew audit actor');
  }
  if (!ID_PATTERN.test(event.target.id)) throw new Error('Invalid Crew audit target');
  for (const digest of [event.request_digest, event.before_digest, event.after_digest]) {
    if (!DIGEST_PATTERN.test(digest)) throw new Error('Invalid Crew audit digest');
  }
  if (!Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid Crew audit timestamp');
  if (event.error_code !== null && !ERROR_CODE_PATTERN.test(event.error_code)) {
    throw new Error('Invalid Crew audit error code');
  }
  if (event.sanitized_error !== null) {
    if (event.sanitized_error.length > 160 || /[\r\n\0]/.test(event.sanitized_error)
      || SENSITIVE_PATTERN.test(event.sanitized_error)) {
      throw new Error('Unsafe sanitized Crew audit error');
    }
  }
  const serialized = canonicalCrewAuditJson(event);
  if (SENSITIVE_PATTERN.test(serialized.replace(event.actor, 'actor'))) {
    throw new Error('Crew audit event contains a sensitive field or value');
  }
}

export function readCrewLifecycleAuditEvents(ctxRoot: string): CrewLifecycleAuditEvent[] {
  const path = auditPath(ctxRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return [];
  return raw.trimEnd().split('\n').map((line, index) => {
    try {
      const event = JSON.parse(line) as CrewLifecycleAuditEvent;
      assertAuditEvent(event);
      return event;
    } catch (error) {
      throw new Error(`Corrupt Crew lifecycle audit at line ${index + 1}: ${(error as Error).message}`);
    }
  });
}

export function appendCrewLifecycleAuditEvent(
  ctxRoot: string,
  event: CrewLifecycleAuditEvent,
): { appended: boolean } {
  assertAuditEvent(event);
  const stateDir = join(ctxRoot, 'state');
  const lockDir = join(stateDir, 'crew-lifecycle-audit-lock');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(lockDir, () => {
    const equivalent = canonicalCrewAuditJson(event);
    const existing = readCrewLifecycleAuditEvents(ctxRoot).find(item => item.event_id === event.event_id);
    if (existing) {
      if (canonicalCrewAuditJson(existing) !== equivalent) {
        throw new Error(`Conflicting audit event for mutation ${event.event_id}`);
      }
      return { appended: false };
    }

    const path = auditPath(ctxRoot);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'a', 0o600);
    try {
      chmodSync(path, 0o600);
      writeSync(fd, `${equivalent}\n`, undefined, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { appended: true };
  });
}

import { randomUUID } from 'crypto';
import { isAbsolute, join } from 'path';
import { existsSync, lstatSync, mkdirSync } from 'fs';
import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';
import {
  commitCrewMutationState, finalizeCrewMutationAudit, getCrewMutation, prepareCrewMutation,
  recordCrewMutationEffect, startCrewMutationEffect,
} from '../audit/crew-mutation-journal.js';
import { createEmployee as createEmployeeService, type CreateEmployeeInput } from '../agents/create-employee.js';
import { createWorkSessionRecord, readWorkSessions, removeStartingWorkSessionRecord, transitionWorkSession, WorkSessionRegistryError } from './registry.js';
import { appendRoomMessage } from '../rooms/log.js';
import { RoomRegistryError, upsertRoom } from '../rooms/registry.js';
import { withFileLockSync } from '../utils/lock.js';
import type {
  CreateWorkSessionInput, WorkSessionEmployeeInput, WorkSessionRecord,
  WorkSessionResumeHandle, WorkSessionRuntimeAdapter,
} from './types.js';
import { composeWorkSessionContext } from '../context/composer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateMutationActor(mutationId: string, actor: unknown): asserts actor is string {
  if (!UUID.test(mutationId)) throw new WorkSessionRegistryError('INVALID_MUTATION_ID', 'A valid mutation id is required');
  if (typeof actor !== 'string' || !actor || actor.length > 160 || /[\r\n\0]/.test(actor)) {
    throw new WorkSessionRegistryError('UNAUTHENTICATED', 'Authenticated actor required');
  }
}

interface Dependencies {
  ctxRoot: string;
  adapterFactory: (record: WorkSessionRecord) => WorkSessionRuntimeAdapter;
  frameworkRoot?: string;
  createEmployee?: (input: CreateEmployeeInput, mutationId: string) => Promise<unknown>;
  now?: () => string;
  failAt?: 'after-session-record';
}

function safeId(mutationId: string): string { return `ws-${mutationId}`; }
function stateDigest(record: WorkSessionRecord): string {
  return digestCrewAuditValue({ ...record, resume_handle: record.resume_handle ? digestCrewAuditValue(record.resume_handle) : null });
}

function resultSnapshot(record: WorkSessionRecord): Record<string, unknown> {
  const { resume_handle: handle, ...snapshot } = record;
  return { ...snapshot, continuation_digest: handle ? digestCrewAuditValue(handle) : null };
}

export class WorkSessionManager {
  private readonly adapters = new Map<string, WorkSessionRuntimeAdapter>();
  private readonly now: () => string;
  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? (() => new Date().toISOString()); }

  list(): WorkSessionRecord[] { return readWorkSessions(this.dependencies.ctxRoot); }
  get(id: string): WorkSessionRecord | undefined { return this.list().find(row => row.id === id); }

  private adapter(record: WorkSessionRecord): WorkSessionRuntimeAdapter {
    const existing = this.adapters.get(record.id);
    if (existing) return existing;
    const created = this.dependencies.adapterFactory(record);
    this.adapters.set(record.id, created);
    return created;
  }

  private prepare(record: WorkSessionRecord, actor: string, action: 'stop' | 'resume' | 'promote' | 'message', mutationId: string, request: unknown) {
    const before = stateDigest(record);
    return prepareCrewMutation(this.dependencies.ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor,
      target: { kind: 'work_session', id: record.id }, action,
      request_digest: digestCrewAuditValue(request), before_digest: before, intended_after_digest: digestCrewAuditValue({ id: record.id, action }),
    }, this.now);
  }

  private priorMutation(
    mutationId: string,
    actor: string,
    action: 'stop' | 'resume' | 'promote' | 'message',
    targetId: string,
    request: unknown,
  ) {
    const prior = getCrewMutation(this.dependencies.ctxRoot, mutationId);
    if (!prior) return null;
    const sameRequest = prior.actor === actor
      && prior.action === action
      && prior.target.kind === 'work_session'
      && prior.target.id === targetId
      && prior.request_digest === digestCrewAuditValue(request);
    if (!sameRequest) throw new WorkSessionRegistryError('IDEMPOTENCY_CONFLICT', 'Mutation id is already bound to another request');
    if (prior.stage === 'finalized' && prior.final_result?.result === 'success') return prior;
    throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session mutation requires reconciliation');
  }

  private originalResult(prior: NonNullable<ReturnType<typeof getCrewMutation>>): WorkSessionRecord {
    const snapshot = prior.final_result?.result_snapshot;
    const current = this.get(prior.target.id);
    if (!snapshot || !current) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Original Work Session result is unavailable');
    const { continuation_digest: continuationDigest, ...record } = snapshot;
    const currentDigest = current.resume_handle ? digestCrewAuditValue(current.resume_handle) : null;
    if (continuationDigest !== currentDigest) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Original Work Session continuation changed');
    return { ...record, resume_handle: current.resume_handle } as unknown as WorkSessionRecord;
  }

  async create(input: CreateWorkSessionInput, mutationId: string = randomUUID()): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, input?.actor);
    if (!input || typeof input.display_name !== 'string' || input.display_name.length < 1 || input.display_name.length > 64
      || typeof input.requested_cwd !== 'string' || !isAbsolute(input.requested_cwd)
      || typeof input.org !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(input.org)
      || !['claude-code', 'codex-app-server', 'opencode'].includes(input.harness)
      || (input.initial_request !== undefined && typeof input.initial_request !== 'string')) {
      throw new WorkSessionRegistryError('INVALID_INPUT', 'Invalid Work Session request');
    }
    if (!/^[\x20-\x7e]{1,64}$/.test(input.display_name)) throw new WorkSessionRegistryError('INVALID_INPUT', 'Invalid Work Session display name');
    if (this.dependencies.frameworkRoot) {
      const orgPath = join(this.dependencies.frameworkRoot, 'orgs', input.org);
      if (!existsSync(orgPath) || !lstatSync(orgPath).isDirectory()) throw new WorkSessionRegistryError('ORG_NOT_FOUND', 'Organization not found');
    }
    if (input.model !== undefined) {
      if (typeof input.model !== 'string') throw new WorkSessionRegistryError('MODEL_UNSUPPORTED', 'Unsupported Work Session model');
      const pattern = input.harness === 'opencode' ? /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/ : /^[A-Za-z0-9._:-]+$/;
      if (input.model.length > 128 || !pattern.test(input.model)) throw new WorkSessionRegistryError('MODEL_UNSUPPORTED', 'Unsupported Work Session model');
    }
    const id = safeId(mutationId);
    const roomId = `work-${id.slice(3)}`;
    const intended = digestCrewAuditValue({ id, display_name: input.display_name, org: input.org, harness: input.harness, requested_cwd: input.requested_cwd, model: input.model ?? null, room_id: roomId });
    const requestDigest = digestCrewAuditValue({ ...input, actor: undefined });
    const prior = getCrewMutation(this.dependencies.ctxRoot, mutationId);
    if (prior) {
      const sameRequest = prior.actor === input.actor
        && prior.action === 'create'
        && prior.target.kind === 'work_session'
        && prior.target.id === id
        && prior.request_digest === requestDigest;
      if (!sameRequest) throw new WorkSessionRegistryError('IDEMPOTENCY_CONFLICT', 'Mutation id is already bound to another request');
      if (prior.stage === 'finalized' && prior.final_result?.result === 'success') return this.originalResult(prior);
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session mutation requires reconciliation');
    }
    const prepared = prepareCrewMutation(this.dependencies.ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: input.actor,
      target: { kind: 'work_session', id }, action: 'create',
      request_digest: requestDigest, before_digest: digestCrewAuditValue(null), intended_after_digest: intended,
    }, this.now);
    if (prepared.reused) {
      const existing = this.list().find(row => row.id === id);
      if (prepared.entry.stage === 'finalized') {
        if (!existing) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Finalized Work Session state is missing');
        return existing;
      }
      if (['effect_started', 'effect_recorded', 'audit_written'].includes(prepared.entry.stage)) {
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session mutation requires reconciliation');
      }
    }
    let record: WorkSessionRecord;
    const configDir = join(this.dependencies.ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    try {
      record = withFileLockSync(configDir, () => {
        const created = createWorkSessionRecord(this.dependencies.ctxRoot, {
          id, display_name: input.display_name, org: input.org, harness: input.harness, requested_cwd: input.requested_cwd, model: input.model,
          room_id: roomId, mutation_id: mutationId, created_by: input.actor,
        }, this.now);
        try {
          if (this.dependencies.failAt === 'after-session-record') throw new Error('injected after Work Session record');
          upsertRoom(this.dependencies.ctxRoot, {
            id: roomId, kind: 'work_session', title: input.display_name, members: [], work_session_id: id,
            created_at: created.created_at, created_by: input.actor, mutation_id: mutationId,
          }, { strict: true, alreadyLocked: true });
          return created;
        } catch (error) {
          removeStartingWorkSessionRecord(this.dependencies.ctxRoot, id, mutationId);
          throw error;
        }
      });
    } catch (error) {
      const registryError = error instanceof RoomRegistryError
        ? new WorkSessionRegistryError('REGISTRY_CORRUPT', error.message)
        : error;
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'failure', after_digest: digestCrewAuditValue(null),
        error_code: registryError instanceof WorkSessionRegistryError ? registryError.code : 'CREATE_FAILED',
        sanitized_error: 'Work Session publication failed',
      });
      throw registryError;
    }
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    try {
      startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
      const context = this.dependencies.frameworkRoot
        ? composeWorkSessionContext({ frameworkRoot: this.dependencies.frameworkRoot, projectRoot: record.canonical_cwd, initialRequest: input.initial_request }).text
        : input.initial_request;
      const result = await this.adapter(record).startFresh({ id, cwd: record.canonical_cwd, model: input.model, context });
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'active', { resume_handle: result.resume_handle }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { runtime_started: true, handle_digest: digestCrewAuditValue(result.resume_handle), mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      return record;
    } catch (error) {
      if (this.adapter(record).status().running) {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'starting', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime ownership could not be released');
      }
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'failed', { last_error: 'RUNTIME_START_FAILED' }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { runtime_started: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'RUNTIME_START_FAILED', sanitized_error: 'Runtime start failed' });
      throw error;
    }
  }

  async send(id: string, text: string, actor: string, mutationId: string = randomUUID()): Promise<void> {
    validateMutationActor(mutationId, actor);
    if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 65_536) throw new WorkSessionRegistryError('INVALID_MESSAGE', 'Invalid Work Session message');
    const request = { text_digest: digestCrewAuditValue(text) };
    if (this.priorMutation(mutationId, actor, 'message', id, request)) return;
    const record = this.require(id, ['active']);
    const prepared = this.prepare(record, actor, 'message', mutationId, request);
    if (prepared.reused) {
      if (prepared.entry.stage === 'finalized') return;
      if (['effect_started', 'effect_recorded', 'audit_written'].includes(prepared.entry.stage)) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Message delivery requires reconciliation');
    }
    appendRoomMessage(this.dependencies.ctxRoot, {
      id: mutationId, room_id: record.room_id, from: actor, to: record.id,
      timestamp: this.now(), text, reply_to: null, thread_id: mutationId,
      source: 'bus', attachments: [],
    });
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    try {
      await this.adapter(record).send(text);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { delivered: true, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'success', after_digest: stateDigest(record) });
    } catch {
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'indeterminate', after_digest: stateDigest(record), error_code: 'DELIVERY_RETRY_REQUIRED', sanitized_error: 'Delivery outcome requires owner retry' });
      throw new WorkSessionRegistryError('DELIVERY_RETRY_REQUIRED', 'Message delivery outcome is uncertain');
    }
  }

  async stop(id: string, actor: string, mutationId: string = randomUUID()): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, actor);
    const prior = this.priorMutation(mutationId, actor, 'stop', id, { id });
    if (prior) return this.originalResult(prior);
    let record = this.require(id, ['starting', 'active', 'archived']);
    const prepared = this.prepare(record, actor, 'stop', mutationId, { id });
    if (prepared.reused && prepared.entry.stage === 'finalized') return record;
    if (record.lifecycle === 'archived') {
      commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
      startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: true, already_archived: true, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      return record;
    }
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active'], 'stopping', {}, mutationId);
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    try {
      await this.adapter(record).stop();
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'archived', {}, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: true, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      this.adapters.delete(id);
      return record;
    } catch (error) {
      if (this.adapter(record).status().running) {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'stopping', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime stop could not be confirmed');
      }
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'failed', { last_error: 'RUNTIME_STOP_FAILED' }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'RUNTIME_STOP_FAILED', sanitized_error: 'Runtime stop failed' });
      throw error;
    }
  }

  async resume(id: string, actor: string, mutationId: string = randomUUID()): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, actor);
    let record = this.get(id);
    if (!record) throw new WorkSessionRegistryError('NOT_FOUND', 'Work Session not found');
    const handle = record.resume_handle;
    if (!handle) throw new WorkSessionRegistryError('RESUME_HANDLE_MISSING', 'Exact Work Session resume handle is missing');
    const request = { id, handle_digest: digestCrewAuditValue(handle) };
    const prior = this.priorMutation(mutationId, actor, 'resume', id, request);
    if (prior) return this.originalResult(prior);
    record = this.require(id, ['archived', 'failed']);
    const prepared = this.prepare(record, actor, 'resume', mutationId, request);
    if (prepared.reused && prepared.entry.stage === 'finalized') return record;
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['archived', 'failed'], 'starting', {}, mutationId);
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    try {
      await this.adapter(record).resumeExact(handle, { id, cwd: record.canonical_cwd, model: record.model ?? undefined });
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'active', {}, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { resumed: true, handle_digest: digestCrewAuditValue(handle), mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      return record;
    } catch (error) {
      try { await this.adapter(record).stop(); } catch { /* status below is authoritative */ }
      if (this.adapter(record).status().running) {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'starting', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime ownership could not be released');
      }
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'failed', { last_error: 'RESUME_HANDLE_UNAVAILABLE' }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { resumed: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'RESUME_HANDLE_UNAVAILABLE', sanitized_error: 'Exact runtime resume failed' });
      throw error;
    }
  }

  async promote(id: string, input: WorkSessionEmployeeInput, mutationId: string = randomUUID()): Promise<void> {
    validateMutationActor(mutationId, input?.actor);
    const request = { id, employee: input.name };
    if (this.priorMutation(mutationId, input.actor, 'promote', id, request)) return;
    let record = this.require(id, ['active']);
    const prepared = this.prepare(record, input.actor, 'promote', mutationId, request);
    if (prepared.reused && prepared.entry.stage === 'finalized') return;
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['active'], 'stopping', {}, mutationId);
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    await this.adapter(record).stop();
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'archived', {}, mutationId);
    const employeeMutationId = randomUUID();
    const createEmployee = this.dependencies.createEmployee
      ?? ((employeeInput, employeeMutationId) => createEmployeeService(employeeInput, employeeMutationId, {
        ctxRoot: this.dependencies.ctxRoot,
        frameworkRoot: this.dependencies.frameworkRoot,
      }));
    try {
      await createEmployee({
        ...input,
        working_directory: record.canonical_cwd,
        room_id: record.room_id,
        source_work_session_id: record.id,
        telegram_polling: false,
      }, employeeMutationId);
    } catch (error) {
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: true, employee_created: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'PROMOTION_FAILED', sanitized_error: 'Employee promotion failed' });
      throw error;
    }
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['archived'], 'archived', { promoted_employee: input.name }, mutationId);
    recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: true, employee_created: true, employee_mutation_digest: digestCrewAuditValue(employeeMutationId), mutation_id: mutationId });
    finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'success', after_digest: stateDigest(record) });
    this.adapters.delete(id);
  }

  private require(id: string, lifecycles: WorkSessionRecord['lifecycle'][]): WorkSessionRecord {
    const record = this.get(id);
    if (!record) throw new WorkSessionRegistryError('NOT_FOUND', 'Work Session not found');
    if (!lifecycles.includes(record.lifecycle)) throw new WorkSessionRegistryError('INVALID_TRANSITION', `Work Session is ${record.lifecycle}`);
    return record;
  }

  handleRuntimeExit(id: string): void {
    const record = this.get(id);
    if (!record || !['starting', 'active', 'stopping'].includes(record.lifecycle)) return;
    const mutationId = randomUUID();
    const prepared = this.prepare(record, 'system:pty-exit', 'stop', mutationId, { id, reason: 'pty_exit' });
    if (prepared.entry.stage === 'finalized') return;
    const archived = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active', 'stopping'], 'archived', {}, mutationId);
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(archived));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { process_exited: true });
    finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'success', after_digest: stateDigest(archived) });
    this.adapters.delete(id);
  }
}

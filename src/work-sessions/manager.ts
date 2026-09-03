import { randomUUID } from 'crypto';
import { isAbsolute, join } from 'path';
import { existsSync, lstatSync, mkdirSync } from 'fs';
import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';
import {
  beginCrewMutationOperation, claimCrewMutationLease, commitCrewMutationState, currentCrewMutationOperationToken, finalizeCrewMutationAudit, getCrewMutation, prepareCrewMutation,
  listPendingCrewMutations, readCrewMutationJournal, reconcileCrewMutationJournal, recordCrewMutationEffect, startCrewMutationEffect,
  releaseCrewMutationOperation,
} from '../audit/crew-mutation-journal.js';
import {
  createPromotedEmployee,
  type CreateEmployeeInput,
  type EmployeeStartReceipt,
  type EmployeeStartRequest,
} from '../agents/create-employee.js';
import { createWorkSessionRecord, readWorkSessions, removeStartingWorkSessionRecord, transitionWorkSession, updateWorkSessionError, WorkSessionRegistryError } from './registry.js';
import { appendRoomMessage, readRoomLog } from '../rooms/log.js';
import { getRoom, RoomRegistryError, upsertRoom } from '../rooms/registry.js';
import { withFileLockSync } from '../utils/lock.js';
import type {
  CreateWorkSessionInput, WorkSessionEmployeeInput, WorkSessionRecord,
  WorkSessionResumeHandle, WorkSessionRuntimeAdapter,
  WorkSessionRuntimeOutput,
} from './types.js';
import { composeWorkSessionContext, WORK_SESSION_CONTEXT_MAX_BYTES } from '../context/composer.js';
import { promotionEmployeeMutationId } from './promotion.js';
import { probeProcessIdentity } from '../utils/process-identity.js';

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
  startEmployee?: (request: EmployeeStartRequest) => Promise<EmployeeStartReceipt>;
  queryEmployeeStart?: (request: EmployeeStartRequest) => Promise<EmployeeStartReceipt | null>;
  now?: () => string;
  failAt?: 'after-session-record' | 'after-runtime-exit-prepare' | 'after-runtime-exit-state'
    | 'after-runtime-exit-state-commit' | 'after-runtime-exit-effect-start'
    | 'after-runtime-exit-receipt' | 'after-runtime-exit-audit' | 'after-message-effect-receipt';
}

function safeId(mutationId: string): string { return `ws-${mutationId}`; }
function stateDigest(record: WorkSessionRecord): string {
  return digestCrewAuditValue({ ...record, resume_handle: record.resume_handle ? digestCrewAuditValue(record.resume_handle) : null });
}

function resultSnapshot(record: WorkSessionRecord): Record<string, unknown> {
  const { resume_handle: handle, ...snapshot } = record;
  return { ...snapshot, continuation_digest: handle ? digestCrewAuditValue(handle) : null };
}

interface WorkSessionMutationRun {
  actor: string;
  action: string;
  target: string;
  requestDigest: string;
  promise: Promise<unknown>;
}
const workSessionMutationRuns = new Map<string, WorkSessionMutationRun>();

export class WorkSessionManager {
  private readonly adapters = new Map<string, WorkSessionRuntimeAdapter>();
  private readonly runtimeExitRuns = new Map<string, Promise<void>>();
  private readonly now: () => string;
  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? (() => new Date().toISOString()); }

  list(actor?: string): WorkSessionRecord[] {
    const records = readWorkSessions(this.dependencies.ctxRoot);
    return actor === undefined ? records : records.filter(record => record.created_by === actor);
  }
  get(id: string): WorkSessionRecord | undefined { return this.list().find(row => row.id === id); }

  private authorize(id: string, actor: string): void {
    const record = this.get(id);
    if (!record) throw new WorkSessionRegistryError('NOT_FOUND', 'Work Session not found');
    if (record.created_by !== actor) throw new WorkSessionRegistryError('FORBIDDEN', 'Work Session is owned by another actor');
  }

  /** Drive durable Work Session mutations during daemon startup, before IPC opens. */
  async reconcilePending(): Promise<{ finalized: number; pending: number }> {
    reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot });
    for (const record of this.list()) {
      if (!['starting', 'active', 'stopping'].includes(record.lifecycle)) continue;
      const mutation = getCrewMutation(this.dependencies.ctxRoot, record.mutation_id);
      if (mutation?.stage !== 'finalized') continue;
      const runtime = this.adapter(record).status();
      if (runtime.ownership === 'detached') {
        const adapter = this.adapter(record);
        await adapter.stop();
        this.assertRuntimeStopped(adapter);
        await this.handleRuntimeExit(record.id);
        continue;
      }
      if (runtime.running) {
        if (record.lifecycle === 'active' && runtime.ownership === 'attached') continue;
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', `Runtime ownership for ${record.id} is ${runtime.ownership ?? 'unknown'}`);
      }
      this.handleRuntimeExit(record.id);
    }
    for (const snapshot of listPendingCrewMutations(this.dependencies.ctxRoot)) {
      if (snapshot.target.kind !== 'work_session') continue;
      const entry = getCrewMutation(this.dependencies.ctxRoot, snapshot.mutation_id);
      if (!entry || entry.stage === 'prepared' || entry.stage === 'finalized') continue;
      try {
        if (entry.action === 'stop') {
          await this.stop(entry.target.id, entry.actor, entry.mutation_id);
        } else if (entry.action === 'resume') {
          await this.resume(entry.target.id, entry.actor, entry.mutation_id);
        } else if (entry.action === 'create' && ['state_committed', 'effect_started'].includes(entry.stage)) {
          let record = this.require(entry.target.id, ['starting', 'active']);
          if (record.mutation_id !== entry.mutation_id) continue;
          if (entry.stage === 'state_committed') startCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id);
          const adapter = this.adapter(record);
          const runtime = adapter.status();
          if (runtime.ownership === 'detached') {
            const handle = adapter.getResumeHandle();
            await adapter.stop();
            this.assertRuntimeStopped(adapter);
            record = transitionWorkSession(this.dependencies.ctxRoot, record.id, ['starting', 'active'], 'failed', {
              resume_handle: handle, runtime_owner: null, last_error: handle ? 'DAEMON_RESTART_DETACHED_RUNTIME' : 'RESUME_HANDLE_MISSING',
            }, entry.mutation_id);
            recordCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id, {
              mutation_id: entry.mutation_id, runtime_started: false, recovered: true, orphan_terminated: true,
            });
            finalizeCrewMutationAudit(this.dependencies.ctxRoot, entry.mutation_id, {
              result: 'failure', after_digest: stateDigest(record), error_code: handle ? 'DAEMON_RESTART_DETACHED_RUNTIME' : 'RESUME_HANDLE_MISSING',
              sanitized_error: handle ? 'Detached runtime was terminated; exact continuation remains resumable' : 'Detached runtime lacked a continuation handle and was terminated',
            });
            continue;
          }
          if (runtime.running) {
            if (!adapter.getResumeHandle()) {
              this.validateRuntimeOwner(adapter.getRuntimeOwner?.() ?? null, entry.mutation_id);
              await adapter.stop();
              this.assertRuntimeStopped(adapter);
              record = transitionWorkSession(this.dependencies.ctxRoot, record.id, ['starting', 'active'], 'failed', {
                last_error: 'RESUME_HANDLE_MISSING', runtime_owner: null,
              }, entry.mutation_id);
              recordCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id, {
                mutation_id: entry.mutation_id, runtime_started: false, recovered: true, orphan_terminated: true,
              });
              finalizeCrewMutationAudit(this.dependencies.ctxRoot, entry.mutation_id, {
                result: 'failure', after_digest: stateDigest(record), error_code: 'RESUME_HANDLE_MISSING',
                sanitized_error: 'Runtime was terminated because continuation discovery did not complete',
              });
              continue;
            }
            record = this.recoverOwnedRuntime(record, adapter, entry.mutation_id);
            recordCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id, {
              mutation_id: entry.mutation_id, runtime_started: true, recovered: true,
              handle_digest: digestCrewAuditValue(record.resume_handle),
            });
            finalizeCrewMutationAudit(this.dependencies.ctxRoot, entry.mutation_id, {
              result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
            });
            continue;
          }
          if (runtime.ownership === 'unknown') continue;
          record = transitionWorkSession(this.dependencies.ctxRoot, record.id, ['starting', 'active'], 'failed', { last_error: 'DAEMON_RESTART_DURING_START', runtime_owner: null }, entry.mutation_id);
          recordCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id, { mutation_id: entry.mutation_id, runtime_started: false, recovered: true });
          finalizeCrewMutationAudit(this.dependencies.ctxRoot, entry.mutation_id, {
            result: 'failure', after_digest: stateDigest(record), error_code: 'DAEMON_RESTART_DURING_START', sanitized_error: 'Daemon restarted before runtime readiness',
          });
        } else if (entry.action === 'promote' && ['state_committed', 'effect_started'].includes(entry.stage)) {
          let record = this.require(entry.target.id, ['stopping', 'archived']);
          if (record.mutation_id !== entry.mutation_id) continue;
          if (entry.stage === 'state_committed') startCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id);
          if (record.lifecycle === 'stopping') {
            const adapter = this.adapter(record);
            try { await adapter.stop(); this.assertRuntimeStopped(adapter); } catch { continue; }
            record = transitionWorkSession(this.dependencies.ctxRoot, record.id, ['stopping'], 'archived', { runtime_owner: null }, entry.mutation_id);
          }
          const childId = promotionEmployeeMutationId(entry.mutation_id);
          const child = getCrewMutation(this.dependencies.ctxRoot, childId);
          const room = getRoom(this.dependencies.ctxRoot, record.room_id);
          if (child?.stage === 'finalized' && child.final_result?.result === 'success'
            && room?.kind === 'agent' && typeof room.agent === 'string') {
            record = transitionWorkSession(this.dependencies.ctxRoot, record.id, ['archived'], 'archived', { promoted_employee: room.agent }, entry.mutation_id);
            recordCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id, {
              mutation_id: entry.mutation_id, stopped: true, employee_created: true,
              employee_mutation_digest: digestCrewAuditValue(childId), recovered: true,
            });
            finalizeCrewMutationAudit(this.dependencies.ctxRoot, entry.mutation_id, { result: 'success', after_digest: stateDigest(record) });
          } else if (!child || child.stage === 'finalized') {
            recordCrewMutationEffect(this.dependencies.ctxRoot, entry.mutation_id, {
              mutation_id: entry.mutation_id, stopped: true, employee_created: false, recovered: true,
            });
            finalizeCrewMutationAudit(this.dependencies.ctxRoot, entry.mutation_id, {
              result: 'failure', after_digest: stateDigest(record), error_code: 'PROMOTION_FAILED', sanitized_error: 'Employee promotion did not complete',
            });
          }
        }
      } catch { /* unresolved ownership remains pending and lease-owning */ }
      reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot });
    }
    return {
      finalized: readCrewMutationJournal(this.dependencies.ctxRoot).filter(entry => entry.stage === 'finalized').length,
      pending: listPendingCrewMutations(this.dependencies.ctxRoot).length,
    };
  }

  private adapter(record: WorkSessionRecord): WorkSessionRuntimeAdapter {
    const existing = this.adapters.get(record.id);
    if (existing) return existing;
    const created = this.dependencies.adapterFactory(record);
    this.adapters.set(record.id, created);
    return created;
  }

  private assertTargetAvailable(targetId: string, mutationId: string): void {
    reconcileCrewMutationJournal(this.dependencies.ctxRoot, {
      frameworkRoot: this.dependencies.frameworkRoot,
      ownerToken: currentCrewMutationOperationToken(mutationId),
    });
    const pending = listPendingCrewMutations(this.dependencies.ctxRoot)
      .find(entry => entry.target.kind === 'work_session' && entry.target.id === targetId && entry.mutation_id !== mutationId);
    if (pending) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session has a pending mutation');
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
    if (prior.stage !== 'finalized') {
      try { return claimCrewMutationLease(this.dependencies.ctxRoot, mutationId); } catch (error) {
        if ((error as Error).message === 'MUTATION_PENDING') {
          throw new WorkSessionRegistryError('MUTATION_PENDING', 'Mutation is owned by another live process');
        }
        throw error;
      }
    }
    if (prior.stage === 'finalized' && prior.final_result?.result !== 'success') {
      throw new WorkSessionRegistryError(
        prior.final_result?.error_code ?? 'RECOVERY_REQUIRED',
        prior.final_result?.sanitized_error ?? 'Work Session mutation did not succeed',
      );
    }
    return prior;
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

  private validateRuntimeOwner(owner: WorkSessionRecord['runtime_owner'], mutationId: string): NonNullable<WorkSessionRecord['runtime_owner']> {
    if (!owner || owner.mutation_id !== mutationId || probeProcessIdentity(owner) !== 'alive') {
      throw new WorkSessionRegistryError('PROCESS_IDENTITY_UNAVAILABLE', 'Runtime readiness lacks exact process ownership');
    }
    return owner;
  }

  private assertRuntimeStopped(adapter: WorkSessionRuntimeAdapter): void {
    const status = adapter.status();
    if (status.running || status.ownership === 'unknown') {
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime stop could not be confirmed');
    }
  }

  private recoverOwnedRuntime(
    record: WorkSessionRecord,
    adapter: WorkSessionRuntimeAdapter,
    mutationId: string,
  ): WorkSessionRecord {
    const owner = this.validateRuntimeOwner(adapter.getRuntimeOwner?.() ?? null, mutationId);
    const handle = adapter.getResumeHandle();
    if (!handle) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Recovered Work Session handle is unavailable');
    return transitionWorkSession(this.dependencies.ctxRoot, record.id, ['starting', 'active'], 'active', {
      resume_handle: handle,
      runtime_owner: owner,
      last_error: null,
    }, mutationId);
  }

  private runMutation<T>(
    mutationId: string,
    binding: { actor: string; action: string; target: string; requestDigest: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${this.dependencies.ctxRoot}\0${mutationId}`;
    const current = workSessionMutationRuns.get(key);
    if (current) {
      if (current.actor !== binding.actor || current.action !== binding.action
        || current.target !== binding.target || current.requestDigest !== binding.requestDigest) {
        return Promise.reject(new WorkSessionRegistryError('IDEMPOTENCY_CONFLICT', 'Mutation id is already bound to another request'));
      }
      return current.promise as Promise<T>;
    }
    const leaseToken = beginCrewMutationOperation(mutationId);
    const promise = Promise.resolve().then(operation);
    const descriptor = { ...binding, promise: promise as Promise<unknown> };
    workSessionMutationRuns.set(key, descriptor);
    void promise.then(
      () => { if (workSessionMutationRuns.get(key) === descriptor) workSessionMutationRuns.delete(key); releaseCrewMutationOperation(mutationId, leaseToken); },
      () => { if (workSessionMutationRuns.get(key) === descriptor) workSessionMutationRuns.delete(key); releaseCrewMutationOperation(mutationId, leaseToken); },
    );
    return promise;
  }

  create(input: CreateWorkSessionInput, mutationId: string = randomUUID()): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, input?.actor);
    return this.runMutation(mutationId, {
      actor: input.actor,
      action: 'create',
      target: safeId(mutationId),
      requestDigest: digestCrewAuditValue({ ...input, actor: undefined }),
    }, () => this.createOnce(input, mutationId));
  }

  private async createOnce(input: CreateWorkSessionInput, mutationId: string): Promise<WorkSessionRecord> {
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
    let launchContext = input.initial_request;
    try {
      if (this.dependencies.frameworkRoot) {
        launchContext = composeWorkSessionContext({
          frameworkRoot: this.dependencies.frameworkRoot,
          projectRoot: input.requested_cwd,
          initialRequest: input.initial_request,
        }).text;
      } else if (launchContext && Buffer.byteLength(launchContext, 'utf8') > WORK_SESSION_CONTEXT_MAX_BYTES) {
        throw new Error('CONTEXT_BUDGET_EXCEEDED');
      }
    } catch (error) {
      if ((error as Error).message.includes('CONTEXT_BUDGET_EXCEEDED')) {
        throw new WorkSessionRegistryError('CONTEXT_BUDGET_EXCEEDED', 'Work Session context exceeds the allowed budget');
      }
      throw error;
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
      if (prior.stage !== 'finalized') {
        try { claimCrewMutationLease(this.dependencies.ctxRoot, mutationId); } catch (error) {
          if ((error as Error).message === 'MUTATION_PENDING') {
            throw new WorkSessionRegistryError('MUTATION_PENDING', 'Mutation is owned by another live process');
          }
          throw error;
        }
      }
      if (prior.stage === 'finalized' && prior.final_result?.result === 'success') return this.originalResult(prior);
      if (prior.stage === 'finalized') {
        throw new WorkSessionRegistryError(prior.final_result?.error_code ?? 'RECOVERY_REQUIRED', prior.final_result?.sanitized_error ?? 'Work Session creation failed');
      }
      if (['effect_recorded', 'audit_written'].includes(prior.stage)) {
        reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot, ownerToken: currentCrewMutationOperationToken(mutationId) });
        const reconciled = getCrewMutation(this.dependencies.ctxRoot, mutationId);
        if (reconciled?.stage === 'finalized' && reconciled.final_result?.result === 'success') return this.originalResult(reconciled);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session creation requires reconciliation');
      }
      if (['state_committed', 'effect_started'].includes(prior.stage)) {
        let recoveryRecord = this.require(id, ['starting', 'active']);
        if (recoveryRecord.mutation_id !== mutationId) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session state is owned by another mutation');
        if (prior.stage === 'state_committed') startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
        try {
          const runtime = this.adapter(recoveryRecord).status();
          if (!runtime.running && runtime.ownership !== 'unknown') {
            const context = this.dependencies.frameworkRoot
              ? composeWorkSessionContext({ frameworkRoot: this.dependencies.frameworkRoot, projectRoot: recoveryRecord.canonical_cwd, initialRequest: input.initial_request }).text
              : input.initial_request;
            if (recoveryRecord.lifecycle === 'active' && recoveryRecord.resume_handle) {
              const resumed = await this.adapter(recoveryRecord).resumeExact(
                recoveryRecord.resume_handle,
                { id, mutation_id: mutationId, cwd: recoveryRecord.canonical_cwd, model: input.model, context },
              );
              recoveryRecord = transitionWorkSession(this.dependencies.ctxRoot, id, ['active'], 'active', {
                runtime_owner: this.validateRuntimeOwner(resumed.runtime_owner, mutationId),
              }, mutationId);
            } else {
              const result = await this.adapter(recoveryRecord).startFresh({ id, mutation_id: mutationId, cwd: recoveryRecord.canonical_cwd, model: input.model, context });
              recoveryRecord = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'active', {
                resume_handle: result.resume_handle,
                runtime_owner: this.validateRuntimeOwner(result.runtime_owner, mutationId),
              }, mutationId);
            }
          } else {
            if (!this.adapter(recoveryRecord).getResumeHandle()) {
              const adapter = this.adapter(recoveryRecord);
              this.validateRuntimeOwner(adapter.getRuntimeOwner?.() ?? null, mutationId);
              await adapter.stop();
              this.assertRuntimeStopped(adapter);
              const failed = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active'], 'failed', {
                last_error: 'RESUME_HANDLE_MISSING', runtime_owner: null,
              }, mutationId);
              recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, {
                runtime_started: false, recovered: true, orphan_terminated: true, mutation_id: mutationId,
              });
              finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
                result: 'failure', after_digest: stateDigest(failed), error_code: 'RESUME_HANDLE_MISSING',
                sanitized_error: 'Runtime was terminated because continuation discovery did not complete',
              });
              throw new WorkSessionRegistryError('RESUME_HANDLE_MISSING', 'Runtime continuation discovery did not complete');
            }
            recoveryRecord = this.recoverOwnedRuntime(recoveryRecord, this.adapter(recoveryRecord), mutationId);
          }
          if (!recoveryRecord.resume_handle) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Recovered Work Session handle is unavailable');
          recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, {
            runtime_started: true, recovered: true,
            handle_digest: digestCrewAuditValue(recoveryRecord.resume_handle), mutation_id: mutationId,
          });
          finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
            result: 'success', after_digest: stateDigest(recoveryRecord), result_snapshot: resultSnapshot(recoveryRecord),
          });
          return recoveryRecord;
        } catch (error) {
          if (getCrewMutation(this.dependencies.ctxRoot, mutationId)?.stage === 'finalized') throw error;
          if (this.adapter(recoveryRecord).status().running || this.adapter(recoveryRecord).status().ownership === 'unknown') {
            transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active'], 'starting', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
            throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime ownership could not be released');
          }
          const failed = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active'], 'failed', { last_error: 'RUNTIME_START_FAILED', runtime_owner: null }, mutationId);
          recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { runtime_started: false, recovered: true, mutation_id: mutationId });
          finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
            result: 'failure', after_digest: stateDigest(failed), error_code: 'RUNTIME_START_FAILED', sanitized_error: 'Runtime start failed',
          });
          throw error;
        }
      }
    }
    this.assertTargetAvailable(id, mutationId);
    const prepared = prior ? { entry: prior, reused: true } : prepareCrewMutation(this.dependencies.ctxRoot, {
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
      const result = await this.adapter(record).startFresh({ id, mutation_id: mutationId, cwd: record.canonical_cwd, model: input.model, context: launchContext });
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'active', {
        resume_handle: result.resume_handle,
        runtime_owner: this.validateRuntimeOwner(result.runtime_owner, mutationId),
      }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { runtime_started: true, handle_digest: digestCrewAuditValue(result.resume_handle), mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      return record;
    } catch (error) {
      if (this.adapter(record).status().running || this.adapter(record).status().ownership === 'unknown') {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'starting', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime ownership could not be released');
      }
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'failed', { last_error: 'RUNTIME_START_FAILED', runtime_owner: null }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { runtime_started: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'RUNTIME_START_FAILED', sanitized_error: 'Runtime start failed' });
      throw error;
    }
  }

  send(id: string, text: string, actor: string, mutationId: string = randomUUID()): Promise<void> {
    validateMutationActor(mutationId, actor);
    try { this.authorize(id, actor); } catch (error) { return Promise.reject(error); }
    return this.runMutation(mutationId, {
      actor,
      action: 'message',
      target: id,
      requestDigest: digestCrewAuditValue({ text_digest: digestCrewAuditValue(text) }),
    }, () => this.sendOnce(id, text, actor, mutationId));
  }

  private async sendOnce(id: string, text: string, actor: string, mutationId: string): Promise<void> {
    validateMutationActor(mutationId, actor);
    if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 65_536) throw new WorkSessionRegistryError('INVALID_MESSAGE', 'Invalid Work Session message');
    const request = { text_digest: digestCrewAuditValue(text) };
    const prior = this.priorMutation(mutationId, actor, 'message', id, request);
    if (prior?.stage === 'finalized') return;
    if (prior?.stage === 'effect_started') {
      const record = this.require(id, ['active']);
      this.appendDelivery(record, actor, mutationId, text, 'indeterminate');
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'indeterminate', after_digest: prior.state_digest ?? prior.before_digest,
        error_code: 'DELIVERY_RETRY_REQUIRED', sanitized_error: 'Delivery outcome requires owner retry',
      });
      throw new WorkSessionRegistryError('DELIVERY_RETRY_REQUIRED', 'Message delivery outcome is uncertain');
    }
    if (prior && ['effect_recorded', 'audit_written'].includes(prior.stage)) {
      reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot, ownerToken: currentCrewMutationOperationToken(mutationId) });
      const reconciled = getCrewMutation(this.dependencies.ctxRoot, mutationId);
      if (reconciled?.stage === 'finalized' && reconciled.final_result?.result === 'success') return;
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Message delivery requires reconciliation');
    }
    this.assertTargetAvailable(id, mutationId);
    const record = this.require(id, ['active']);
    if (!prior) this.prepare(record, actor, 'message', mutationId, request);
    if (!prior || prior.stage === 'prepared') {
      appendRoomMessage(this.dependencies.ctxRoot, {
        id: mutationId, room_id: record.room_id, from: actor, to: record.id,
        timestamp: this.now(), text, reply_to: null, thread_id: mutationId,
        source: 'bus', attachments: [], delivery_state: 'pending',
      });
      commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    }
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    try {
      await this.adapter(record).send(text);
    } catch {
      this.appendDelivery(record, actor, mutationId, text, 'indeterminate');
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'indeterminate', after_digest: stateDigest(record), error_code: 'DELIVERY_RETRY_REQUIRED', sanitized_error: 'Delivery outcome requires owner retry' });
      throw new WorkSessionRegistryError('DELIVERY_RETRY_REQUIRED', 'Message delivery outcome is uncertain');
    }
    try {
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { delivered: true, mutation_id: mutationId });
      if (this.dependencies.failAt === 'after-message-effect-receipt') throw new Error('injected after message effect receipt');
      this.appendDelivery(record, actor, mutationId, text, 'delivered');
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'success', after_digest: stateDigest(record) });
    } catch {
      const durable = getCrewMutation(this.dependencies.ctxRoot, mutationId);
      if (durable?.effect_receipt?.delivered === true) {
        try { this.appendDelivery(record, actor, mutationId, text, 'delivered'); } catch { /* recovery will retry the projection */ }
        reconcileCrewMutationJournal(this.dependencies.ctxRoot, {
          frameworkRoot: this.dependencies.frameworkRoot,
          ownerToken: currentCrewMutationOperationToken(mutationId),
        });
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Delivery succeeded; durable finalization requires recovery');
      }
      this.appendDelivery(record, actor, mutationId, text, 'indeterminate');
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'indeterminate', after_digest: stateDigest(record), error_code: 'DELIVERY_RETRY_REQUIRED', sanitized_error: 'Delivery outcome requires owner retry' });
      throw new WorkSessionRegistryError('DELIVERY_RETRY_REQUIRED', 'Message delivery outcome is uncertain');
    }
  }

  private appendDelivery(record: WorkSessionRecord, actor: string, mutationId: string, text: string, deliveryState: 'delivered' | 'indeterminate'): void {
    appendRoomMessage(this.dependencies.ctxRoot, {
      id: mutationId, room_id: record.room_id, from: actor, to: record.id,
      timestamp: this.now(), text, reply_to: null, thread_id: mutationId,
      source: 'bus', attachments: [], delivery_state: deliveryState,
    });
  }

  /** Persist one completed runtime response with immutable Work Session identity. */
  recordRuntimeOutput(id: string, output: WorkSessionRuntimeOutput): void {
    const record = this.get(id);
    if (!record || !output.text.trim()) return;
    const outputId = `wsout-${digestCrewAuditValue({ session: record.id, output: output.id }).slice(0, 48)}`;
    // Native harnesses can repeat their completion event during redraw or
    // reconnect. Keep the append-only room physically idempotent as well as
    // reader-idempotent so one completed response has one durable record.
    if (readRoomLog(this.dependencies.ctxRoot, record.room_id).some(message => message.id === outputId)) return;
    appendRoomMessage(this.dependencies.ctxRoot, {
      id: outputId, room_id: record.room_id, from: record.id, to: record.created_by,
      timestamp: this.now(), text: output.text.trim(), reply_to: null, thread_id: outputId,
      source: 'work_session', attachments: [], delivery_state: 'delivered',
    });
  }

  stop(id: string, actor: string, mutationId: string = randomUUID()): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, actor);
    try { this.authorize(id, actor); } catch (error) { return Promise.reject(error); }
    return this.runMutation(mutationId, {
      actor,
      action: 'stop',
      target: id,
      requestDigest: digestCrewAuditValue({ id }),
    }, () => this.stopOnce(id, actor, mutationId));
  }

  private async stopOnce(id: string, actor: string, mutationId: string): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, actor);
    const prior = this.priorMutation(mutationId, actor, 'stop', id, { id });
    if (prior?.stage === 'finalized') return this.originalResult(prior);
    if (prior && ['effect_recorded', 'audit_written'].includes(prior.stage)) {
      reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot, ownerToken: currentCrewMutationOperationToken(mutationId) });
      const reconciled = getCrewMutation(this.dependencies.ctxRoot, mutationId);
      if (reconciled?.stage === 'finalized' && reconciled.final_result?.result === 'success') return this.originalResult(reconciled);
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session stop requires reconciliation');
    }
    if (prior && ['state_committed', 'effect_started'].includes(prior.stage)) {
      let recoveryRecord = this.require(id, ['stopping', 'archived']);
      if (recoveryRecord.mutation_id !== mutationId) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session state is owned by another mutation');
      if (prior.stage === 'state_committed') startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
      if (recoveryRecord.lifecycle === 'stopping') {
        try { await this.adapter(recoveryRecord).stop(); } catch {
          if (this.adapter(recoveryRecord).status().running || this.adapter(recoveryRecord).status().ownership === 'unknown') {
            transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'stopping', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
            throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime stop could not be confirmed');
          }
        }
        this.assertRuntimeStopped(this.adapter(recoveryRecord));
        recoveryRecord = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'archived', { runtime_owner: null }, mutationId);
      }
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: true, recovered: true, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(recoveryRecord), result_snapshot: resultSnapshot(recoveryRecord),
      });
      this.adapters.delete(id);
      return recoveryRecord;
    }
    this.assertTargetAvailable(id, mutationId);
    let record = this.require(id, ['starting', 'active', 'archived']);
    const prepared = prior ? { entry: prior, reused: true } : this.prepare(record, actor, 'stop', mutationId, { id });
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
      this.assertRuntimeStopped(this.adapter(record));
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'archived', { runtime_owner: null }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: true, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      this.adapters.delete(id);
      return record;
    } catch (error) {
      if (this.adapter(record).status().running || this.adapter(record).status().ownership === 'unknown') {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'stopping', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime stop could not be confirmed');
      }
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'failed', { last_error: 'RUNTIME_STOP_FAILED', runtime_owner: null }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { stopped: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'RUNTIME_STOP_FAILED', sanitized_error: 'Runtime stop failed' });
      throw error;
    }
  }

  resume(id: string, actor: string, mutationId: string = randomUUID()): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, actor);
    try { this.authorize(id, actor); } catch (error) { return Promise.reject(error); }
    const handle = this.get(id)?.resume_handle ?? null;
    return this.runMutation(mutationId, {
      actor,
      action: 'resume',
      target: id,
      requestDigest: digestCrewAuditValue({ id, handle_digest: digestCrewAuditValue(handle) }),
    }, () => this.resumeOnce(id, actor, mutationId));
  }

  private async resumeOnce(id: string, actor: string, mutationId: string): Promise<WorkSessionRecord> {
    validateMutationActor(mutationId, actor);
    let record = this.get(id);
    if (!record) throw new WorkSessionRegistryError('NOT_FOUND', 'Work Session not found');
    const handle = record.resume_handle;
    if (!handle) throw new WorkSessionRegistryError('RESUME_HANDLE_MISSING', 'Exact Work Session resume handle is missing');
    const request = { id, handle_digest: digestCrewAuditValue(handle) };
    const prior = this.priorMutation(mutationId, actor, 'resume', id, request);
    if (prior?.stage === 'finalized') return this.originalResult(prior);
    if (prior && ['effect_recorded', 'audit_written'].includes(prior.stage)) {
      reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot, ownerToken: currentCrewMutationOperationToken(mutationId) });
      const reconciled = getCrewMutation(this.dependencies.ctxRoot, mutationId);
      if (reconciled?.stage === 'finalized' && reconciled.final_result?.result === 'success') return this.originalResult(reconciled);
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session resume requires reconciliation');
    }
    if (prior && ['state_committed', 'effect_started'].includes(prior.stage)) {
      let recoveryRecord = this.require(id, ['starting', 'active']);
      if (recoveryRecord.mutation_id !== mutationId) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session state is owned by another mutation');
      if (prior.stage === 'state_committed') startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
      try {
        const runtime = this.adapter(recoveryRecord).status();
        if (runtime.running || runtime.ownership === 'unknown') {
          throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime resume readiness is not mutation-bound');
        }
        const resumed = await this.adapter(recoveryRecord).resumeExact(handle, { id, mutation_id: mutationId, cwd: recoveryRecord.canonical_cwd, model: recoveryRecord.model ?? undefined });
        if (recoveryRecord.lifecycle === 'starting') {
          recoveryRecord = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'active', {
            runtime_owner: this.validateRuntimeOwner(resumed.runtime_owner, mutationId),
          }, mutationId);
        }
        recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, {
          resumed: true, recovered: true, handle_digest: digestCrewAuditValue(handle), mutation_id: mutationId,
        });
        finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
          result: 'success', after_digest: stateDigest(recoveryRecord), result_snapshot: resultSnapshot(recoveryRecord),
        });
        return recoveryRecord;
      } catch (error) {
        try { await this.adapter(recoveryRecord).stop(); } catch { /* status below is authoritative */ }
        if (this.adapter(recoveryRecord).status().running || this.adapter(recoveryRecord).status().ownership === 'unknown') {
          transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active'], 'starting', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
          throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime ownership could not be released');
        }
        const failed = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active'], 'failed', { last_error: 'RESUME_HANDLE_UNAVAILABLE', runtime_owner: null }, mutationId);
        recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { resumed: false, recovered: true, mutation_id: mutationId });
        finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
          result: 'failure', after_digest: stateDigest(failed), error_code: 'RESUME_HANDLE_UNAVAILABLE', sanitized_error: 'Exact runtime resume failed',
        });
        throw error;
      }
    }
    this.assertTargetAvailable(id, mutationId);
    record = this.require(id, ['archived', 'failed']);
    const prepared = prior ? { entry: prior, reused: true } : this.prepare(record, actor, 'resume', mutationId, request);
    if (prepared.reused && prepared.entry.stage === 'finalized') return record;
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['archived', 'failed'], 'starting', {}, mutationId);
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    try {
      const resumed = await this.adapter(record).resumeExact(handle, { id, mutation_id: mutationId, cwd: record.canonical_cwd, model: record.model ?? undefined });
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'active', {
        runtime_owner: this.validateRuntimeOwner(resumed.runtime_owner, mutationId),
      }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { resumed: true, handle_digest: digestCrewAuditValue(handle), mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
        result: 'success', after_digest: stateDigest(record), result_snapshot: resultSnapshot(record),
      });
      return record;
    } catch (error) {
      try { await this.adapter(record).stop(); } catch { /* status below is authoritative */ }
      if (this.adapter(record).status().running || this.adapter(record).status().ownership === 'unknown') {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'starting', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime ownership could not be released');
      }
      record = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting'], 'failed', { last_error: 'RESUME_HANDLE_UNAVAILABLE', runtime_owner: null }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { resumed: false, mutation_id: mutationId });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'failure', after_digest: stateDigest(record), error_code: 'RESUME_HANDLE_UNAVAILABLE', sanitized_error: 'Exact runtime resume failed' });
      throw error;
    }
  }

  promote(id: string, input: WorkSessionEmployeeInput, mutationId: string = randomUUID()): Promise<void> {
    validateMutationActor(mutationId, input?.actor);
    try { this.authorize(id, input.actor); } catch (error) { return Promise.reject(error); }
    return this.runMutation(mutationId, {
      actor: input.actor,
      action: 'promote',
      target: id,
      requestDigest: digestCrewAuditValue({ id, employee: { ...input, actor: undefined } }),
    }, () => this.promoteOnce(id, input, mutationId));
  }

  private async promoteOnce(id: string, input: WorkSessionEmployeeInput, mutationId: string): Promise<void> {
    validateMutationActor(mutationId, input?.actor);
    const request = { id, employee: { ...input, actor: undefined } };
    const prior = this.priorMutation(mutationId, input.actor, 'promote', id, request);
    if (prior?.stage === 'finalized') return;
    if (prior && ['effect_recorded', 'audit_written'].includes(prior.stage)) {
      reconcileCrewMutationJournal(this.dependencies.ctxRoot, { frameworkRoot: this.dependencies.frameworkRoot, ownerToken: currentCrewMutationOperationToken(mutationId) });
      const reconciled = getCrewMutation(this.dependencies.ctxRoot, mutationId);
      if (reconciled?.stage === 'finalized' && reconciled.final_result?.result === 'success') return;
      throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session promotion requires reconciliation');
    }
    if (prior && ['state_committed', 'effect_started'].includes(prior.stage)) {
      let recoveryRecord = this.require(id, ['stopping', 'archived']);
      if (recoveryRecord.mutation_id !== mutationId) throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Work Session state is owned by another mutation');
      if (prior.stage === 'state_committed') startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
      if (recoveryRecord.lifecycle === 'stopping') {
        try { await this.adapter(recoveryRecord).stop(); } catch {
          if (this.adapter(recoveryRecord).status().running || this.adapter(recoveryRecord).status().ownership === 'unknown') {
            transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'stopping', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
            throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime stop could not be confirmed');
          }
        }
        this.assertRuntimeStopped(this.adapter(recoveryRecord));
        recoveryRecord = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'archived', { runtime_owner: null }, mutationId);
      }
      const createEmployee = this.dependencies.createEmployee
        ?? ((employeeInput, employeeMutationId) => createPromotedEmployee(
          employeeInput,
          employeeMutationId,
          { sourceWorkSessionId: recoveryRecord.id, parentMutationId: mutationId },
          {
            ctxRoot: this.dependencies.ctxRoot,
            frameworkRoot: this.dependencies.frameworkRoot,
            startEmployee: this.dependencies.startEmployee,
            queryEmployeeStart: this.dependencies.queryEmployeeStart,
          },
        ));
      const employeeMutationId = promotionEmployeeMutationId(mutationId);
      await createEmployee({
        ...input, working_directory: recoveryRecord.canonical_cwd, room_id: recoveryRecord.room_id, telegram_polling: false,
      }, employeeMutationId);
      recoveryRecord = transitionWorkSession(this.dependencies.ctxRoot, id, ['archived'], 'archived', { promoted_employee: input.name }, mutationId);
      recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, {
        stopped: true, employee_created: true, recovered: true,
        employee_mutation_digest: digestCrewAuditValue(employeeMutationId), mutation_id: mutationId,
      });
      finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, { result: 'success', after_digest: stateDigest(recoveryRecord) });
      this.adapters.delete(id);
      return;
    }
    this.assertTargetAvailable(id, mutationId);
    let record = this.require(id, ['active']);
    const prepared = prior ? { entry: prior, reused: true } : this.prepare(record, input.actor, 'promote', mutationId, request);
    if (prepared.reused && prepared.entry.stage === 'finalized') return;
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['active'], 'stopping', {}, mutationId);
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(record));
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    try { await this.adapter(record).stop(); this.assertRuntimeStopped(this.adapter(record)); } catch (error) {
      if (this.adapter(record).status().running || this.adapter(record).status().ownership === 'unknown') {
        transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'stopping', { last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' }, mutationId);
        throw new WorkSessionRegistryError('RECOVERY_REQUIRED', 'Runtime stop could not be confirmed');
      }
    }
    record = transitionWorkSession(this.dependencies.ctxRoot, id, ['stopping'], 'archived', { runtime_owner: null }, mutationId);
    const employeeMutationId = promotionEmployeeMutationId(mutationId);
    const createEmployee = this.dependencies.createEmployee
      ?? ((employeeInput, employeeMutationId) => createPromotedEmployee(
        employeeInput,
        employeeMutationId,
        { sourceWorkSessionId: record.id, parentMutationId: mutationId },
        {
          ctxRoot: this.dependencies.ctxRoot,
          frameworkRoot: this.dependencies.frameworkRoot,
          startEmployee: this.dependencies.startEmployee,
          queryEmployeeStart: this.dependencies.queryEmployeeStart,
        },
      ));
    try {
      await createEmployee({
        ...input,
        working_directory: record.canonical_cwd,
        room_id: record.room_id,
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

  handleRuntimeExit(id: string): Promise<void> {
    const running = this.runtimeExitRuns.get(id);
    if (running) return running;
    const active = [...workSessionMutationRuns.entries()].find(([key, value]) =>
      key.startsWith(`${this.dependencies.ctxRoot}\0`) && value.target === id)?.[1].promise;
    const task = (active ? active.catch(() => undefined) : Promise.resolve())
      .then(() => this.handleRuntimeExitOnce(id))
      .catch(error => {
        const pending = listPendingCrewMutations(this.dependencies.ctxRoot)
          .some(entry => entry.target.kind === 'work_session' && entry.target.id === id);
        if (!pending) {
          try { updateWorkSessionError(this.dependencies.ctxRoot, id, 'RUNTIME_EXIT_RECOVERY_FAILED'); } catch { /* record may already be terminal */ }
        }
        console.error(`[work-session] exit recovery failed for ${id}: ${(error as Error).message}`);
      })
      .finally(() => { if (this.runtimeExitRuns.get(id) === task) this.runtimeExitRuns.delete(id); });
    this.runtimeExitRuns.set(id, task);
    return task;
  }

  private handleRuntimeExitOnce(id: string): void {
    const record = this.get(id);
    if (!record || !['starting', 'active', 'stopping'].includes(record.lifecycle)) return;
    const mutationId = randomUUID();
    const prepared = this.prepare(record, 'system:pty-exit', 'stop', mutationId, { id, reason: 'pty_exit' });
    if (prepared.entry.stage === 'finalized') return;
    if (this.dependencies.failAt === 'after-runtime-exit-prepare') throw new Error('injected after runtime exit prepare');
    const archived = transitionWorkSession(this.dependencies.ctxRoot, id, ['starting', 'active', 'stopping'], 'archived', { runtime_owner: null }, mutationId);
    if (this.dependencies.failAt === 'after-runtime-exit-state') throw new Error('injected after runtime exit state');
    commitCrewMutationState(this.dependencies.ctxRoot, mutationId, stateDigest(archived));
    if (this.dependencies.failAt === 'after-runtime-exit-state-commit') throw new Error('injected after runtime exit state commit');
    startCrewMutationEffect(this.dependencies.ctxRoot, mutationId);
    if (this.dependencies.failAt === 'after-runtime-exit-effect-start') throw new Error('injected after runtime exit effect start');
    recordCrewMutationEffect(this.dependencies.ctxRoot, mutationId, { mutation_id: mutationId, stopped: true, process_exited: true });
    if (this.dependencies.failAt === 'after-runtime-exit-receipt') throw new Error('injected after runtime exit receipt');
    finalizeCrewMutationAudit(this.dependencies.ctxRoot, mutationId, {
      result: 'success', after_digest: stateDigest(archived), result_snapshot: resultSnapshot(archived),
    }, { failAfterAppend: this.dependencies.failAt === 'after-runtime-exit-audit' });
    this.adapters.delete(id);
  }
}

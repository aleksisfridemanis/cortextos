import { randomBytes, randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  accessSync,
  constants,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { homedir } from 'os';
import {
  beginCrewMutationOperation,
  claimCrewMutationLease,
  commitCrewMutationState,
  currentCrewMutationOperationToken,
  finalizeCrewMutationAudit,
  getCrewMutation,
  listPendingCrewMutations,
  prepareCrewMutation,
  releaseCrewMutationOperation,
  reconcileCrewMutationJournal,
  recordCrewMutationEffect,
  startCrewMutationEffect,
} from '../audit/crew-mutation-journal.js';
import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';
import { agentRoomId, validateRoomId } from '../rooms/id.js';
import { validateAgentName, validateOrgName } from '../utils/validate.js';
import { withFileLockSync } from '../utils/lock.js';
import type { Room } from '../types/index.js';
import { promotionEmployeeMutationId } from '../work-sessions/promotion.js';
import { probeProcessIdentity } from '../utils/process-identity.js';

export const CREW_BODY_MAX_BYTES = 131_072;
export const CREW_NAME_MAX_CHARS = 64;
export const CREW_EMPLOYEE_RUNTIMES = ['claude-code', 'codex-app-server', 'opencode'] as const;
export type CrewEmployeeRuntime = typeof CREW_EMPLOYEE_RUNTIMES[number];

export interface CreateEmployeeInput {
  name: string;
  org: string;
  runtime: CrewEmployeeRuntime;
  model?: string;
  working_directory?: string;
  telegram_polling: false;
  room_id?: string;
  actor: string;
}

export interface EmployeeRegistryRecord {
  enabled: true;
  status: 'configured';
  org: string;
  runtime: CrewEmployeeRuntime;
  model: string | null;
  working_directory: string | null;
  room_id: string;
  mutation_id: string;
  created_at: string;
}

export interface CreateEmployeeResult {
  status: 'created' | 'configured';
  employee: EmployeeRegistryRecord & { name: string };
  audit: 'finalized';
}

export interface EmployeeStartRequest {
  name: string;
  org: string;
  agent_dir: string;
  mutation_id: string;
}

export interface EmployeeStartReceipt {
  mutation_id: string;
  name: string;
  started: boolean;
  pid: number | null;
  process_started_at: string | null;
  process_group_id?: number | null;
  disposition: 'running' | 'configured' | 'exited' | 'failed';
}

export interface CreateEmployeeDependencies {
  ctxRoot?: string;
  frameworkRoot?: string;
  instanceId?: string;
  now?: () => string;
  startEmployee?: (request: EmployeeStartRequest) => Promise<EmployeeStartReceipt>;
  queryEmployeeStart?: (request: EmployeeStartRequest) => Promise<EmployeeStartReceipt | null>;
  failAt?: 'before-state-commit' | 'after-directory-publish' | 'after-enabled-write' | 'after-publication'
    | 'after-state-commit' | 'after-effect-start' | 'after-effect' | 'after-audit';
}

interface PromotionGrant {
  source_work_session_id: string;
  parent_mutation_id: string;
}

const PROMOTION_GRANT = Symbol('cortext-promotion-grant');
type InternalCreateEmployeeInput = CreateEmployeeInput & Partial<PromotionGrant>;
type InternalCreateEmployeeDependencies = CreateEmployeeDependencies & { [PROMOTION_GRANT]?: PromotionGrant };

interface EmployeeMutationRun {
  actor: string;
  target: string;
  requestDigest: string;
  promise: Promise<CreateEmployeeResult>;
}
const employeeMutationRuns = new Map<string, EmployeeMutationRun>();

export class CrewServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CrewServiceError';
  }
}

function readObject(path: string): Record<string, EmployeeRegistryRecord> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new CrewServiceError('REGISTRY_CORRUPT', 503, 'Employee registry requires operator recovery');
  }
}

function readRooms(path: string): Room[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch {
    throw new CrewServiceError('REGISTRY_CORRUPT', 503, 'Room registry requires operator recovery');
  }
}

function durableWriteJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.employee-${process.pid}-${randomBytes(6).toString('hex')}`);
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

function replaceTemplateTokens(dir: string, values: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) replaceTemplateTokens(path, values);
    else if (entry.isFile() && lstatSync(path).size <= 1_000_000) {
      let text: string;
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      for (const [key, value] of Object.entries(values)) {
        text = text.replaceAll(`{{${key}}}`, value);
      }
      writeFileSync(path, text, 'utf8');
    }
  }
}

function validateInputShape(input: CreateEmployeeInput): void {
  if (!input || typeof input !== 'object') throw new CrewServiceError('INVALID_INPUT', 400, 'Invalid Employee request');
  if (typeof input.name !== 'string' || input.name.length > CREW_NAME_MAX_CHARS) {
    throw new CrewServiceError('INVALID_NAME', 400, `Employee name must contain at most ${CREW_NAME_MAX_CHARS} characters`);
  }
  try { validateAgentName(input.name); } catch { throw new CrewServiceError('INVALID_NAME', 400, 'Invalid Employee name'); }
  if (typeof input.org !== 'string') throw new CrewServiceError('INVALID_ORG', 400, 'Organization is required');
  try { validateOrgName(input.org); } catch { throw new CrewServiceError('INVALID_ORG', 400, 'Invalid organization'); }
  if (!CREW_EMPLOYEE_RUNTIMES.includes(input.runtime)) {
    throw new CrewServiceError('RUNTIME_UNSUPPORTED', 400, 'Unsupported Employee harness');
  }
  if (input.telegram_polling !== false) throw new CrewServiceError('INVALID_INPUT', 400, 'Employee creation is tokenless');
  if (typeof input.actor !== 'string' || !input.actor || input.actor.length > 160 || /[\r\n\0]/.test(input.actor)) {
    throw new CrewServiceError('UNAUTHENTICATED', 401, 'Authenticated actor required');
  }
  if (input.model !== undefined) {
    const modelPattern = input.runtime === 'opencode'
      ? /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/
      : /^[A-Za-z0-9._:-]+$/;
    if (!modelPattern.test(input.model) || input.model.length > 128) {
      throw new CrewServiceError('MODEL_UNSUPPORTED', 400, 'Unsupported model identifier');
    }
  }
  if (input.working_directory !== undefined
    && (typeof input.working_directory !== 'string' || !isAbsolute(input.working_directory))) {
    throw new CrewServiceError('INVALID_WORKING_DIRECTORY', 400, 'Working directory must be absolute');
  }
  if (input.room_id !== undefined) {
    try { validateRoomId(input.room_id); } catch { throw new CrewServiceError('INVALID_ROOM', 400, 'Invalid room identifier'); }
  }
}

function validateInputEnvironment(input: CreateEmployeeInput, frameworkRoot: string): void {
  if (!existsSync(join(frameworkRoot, 'orgs', input.org)) || !lstatSync(join(frameworkRoot, 'orgs', input.org)).isDirectory()) {
    throw new CrewServiceError('ORG_NOT_FOUND', 404, 'Organization not found');
  }
}

function canonicalWorkingDirectory(requested: string | undefined): string | null {
  if (requested === undefined) return null;
  let canonical: string;
  try { canonical = realpathSync(requested); } catch {
    throw new CrewServiceError('CWD_NOT_FOUND', 404, 'Working directory does not exist');
  }
  if (!statSync(canonical).isDirectory()) {
    throw new CrewServiceError('CWD_NOT_DIRECTORY', 400, 'Working directory must be a directory');
  }
  try { accessSync(canonical, constants.R_OK | constants.X_OK); } catch {
    throw new CrewServiceError('CWD_UNREADABLE', 400, 'Working directory is not readable and searchable');
  }
  return canonical;
}

function templateName(runtime: CrewEmployeeRuntime): string {
  if (runtime === 'codex-app-server') return 'agent-codex';
  if (runtime === 'opencode') return 'agent-opencode';
  return 'agent';
}

function installRuntimeSkills(stageDir: string, finalDir: string, name: string, runtime: CrewEmployeeRuntime): string[] {
  const source = join(stageDir, 'plugins', 'cortextos-agent-skills', 'skills');
  if (!existsSync(source)) return [];
  const skills = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const created: string[] = [];
  if (runtime === 'codex-app-server') {
    const destination = join(homedir(), '.codex', 'skills');
    mkdirSync(destination, { recursive: true });
    for (const skill of skills) {
      const link = join(destination, `${name}__${skill}`);
      if (existsSync(link)) continue;
      symlinkSync(join(finalDir, 'plugins', 'cortextos-agent-skills', 'skills', skill), link, 'dir');
      created.push(link);
    }
  } else if (runtime === 'opencode') {
    const destination = join(stageDir, '.opencode', 'skills');
    mkdirSync(destination, { recursive: true });
    for (const skill of skills) {
      const link = join(destination, skill);
      if (existsSync(link)) continue;
      symlinkSync(relative(destination, join(stageDir, 'plugins', 'cortextos-agent-skills', 'skills', skill)), link, 'dir');
    }
  }
  return created;
}

async function defaultStart(instanceId: string, request: EmployeeStartRequest): Promise<EmployeeStartReceipt> {
  const { IPCClient } = await import('../daemon/ipc-server.js');
  const ipc = new IPCClient(instanceId);
  const response = await ipc.send({
    type: 'start-employee-mutation',
    agent: request.name,
    source: 'create-employee',
    mutation_id: request.mutation_id,
    data: { dir: request.agent_dir, org: request.org, mutation_id: request.mutation_id },
  });
  if (!response.success) {
    if (response.error?.includes('Daemon is not running')) {
      return { mutation_id: request.mutation_id, name: request.name, started: false, pid: null, process_started_at: null, disposition: 'configured' };
    }
    if (response.code === 'MUTATION_OUTCOME_UNKNOWN' || response.code === 'MUTATION_PENDING') {
      throw new CrewServiceError(response.code, 503, 'Employee start outcome is unresolved');
    }
    throw new Error(response.code ?? 'DAEMON_START_FAILED');
  }
  return response.data as EmployeeStartReceipt;
}

function resultFromRegistry(name: string, record: EmployeeRegistryRecord, started = true): CreateEmployeeResult {
  return { status: started ? 'created' : 'configured', employee: { name, ...record }, audit: 'finalized' };
}

function resultSnapshot(result: CreateEmployeeResult): Record<string, unknown> {
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

function resultFromSnapshot(value: Record<string, unknown> | undefined): CreateEmployeeResult | null {
  if (!value || (value.status !== 'created' && value.status !== 'configured') || value.audit !== 'finalized'
    || !value.employee || typeof value.employee !== 'object') return null;
  return JSON.parse(JSON.stringify(value)) as CreateEmployeeResult;
}

function employeeRequestDigest(input: InternalCreateEmployeeInput, dependencies: InternalCreateEmployeeDependencies): string {
  return digestCrewAuditValue({
    name: input?.name,
    org: input?.org,
    runtime: input?.runtime,
    model: input?.model ?? null,
    working_directory: input?.working_directory ?? null,
    telegram_polling: input?.telegram_polling,
    room_id: input?.room_id ?? null,
    source_work_session_id: dependencies[PROMOTION_GRANT]?.source_work_session_id ?? null,
    parent_mutation_id: dependencies[PROMOTION_GRANT]?.parent_mutation_id ?? null,
  });
}

export function employeeStartReceiptDigest(receipt: EmployeeStartReceipt): string {
  return digestCrewAuditValue({
    mutation_id: receipt.mutation_id,
    name: receipt.name,
    started: receipt.started,
    pid: receipt.pid,
    process_started_at: receipt.process_started_at,
    process_group_id: receipt.process_group_id ?? null,
    disposition: receipt.disposition,
  });
}

function validateStartReceipt(receipt: EmployeeStartReceipt, request: EmployeeStartRequest): void {
  const identityMatches = receipt.started
    && receipt.disposition === 'running'
    && Number.isSafeInteger(receipt.pid) && (receipt.pid ?? 0) > 0
    && typeof receipt.process_started_at === 'string' && receipt.process_started_at.length > 0
    && probeProcessIdentity({ pid: receipt.pid!, started_at: receipt.process_started_at!, process_group_id: receipt.process_group_id }) === 'alive';
  const configured = !receipt.started && receipt.disposition === 'configured'
    && receipt.pid === null && receipt.process_started_at === null;
  const exited = !receipt.started && receipt.disposition === 'exited'
    && Number.isSafeInteger(receipt.pid) && (receipt.pid ?? 0) > 0
    && typeof receipt.process_started_at === 'string'
    && probeProcessIdentity({ pid: receipt.pid!, started_at: receipt.process_started_at, process_group_id: receipt.process_group_id }) === 'dead';
  const failed = !receipt.started && receipt.disposition === 'failed'
    && receipt.pid === null && receipt.process_started_at === null;
  if (receipt.mutation_id !== request.mutation_id || receipt.name !== request.name || (!identityMatches && !configured && !exited && !failed)) {
    throw new Error('Invalid daemon mutation receipt');
  }
}

export function createEmployee(
  input: CreateEmployeeInput,
  mutationId: string = randomUUID(),
  dependencies: CreateEmployeeDependencies = {},
): Promise<CreateEmployeeResult> {
  if (input && typeof input === 'object'
    && (Object.prototype.hasOwnProperty.call(input, 'source_work_session_id')
      || Object.prototype.hasOwnProperty.call(input, 'parent_mutation_id'))) {
    return Promise.reject(new CrewServiceError('FORGED_SERVER_FIELD', 400, 'Promotion authority is server-owned'));
  }
  return runEmployeeMutation(input, mutationId, dependencies);
}

export function createPromotedEmployee(
  input: CreateEmployeeInput,
  mutationId: string,
  grant: { sourceWorkSessionId: string; parentMutationId: string },
  dependencies: CreateEmployeeDependencies = {},
): Promise<CreateEmployeeResult> {
  const authorization: PromotionGrant = {
    source_work_session_id: grant.sourceWorkSessionId,
    parent_mutation_id: grant.parentMutationId,
  };
  return runEmployeeMutation(
    { ...input, ...authorization },
    mutationId,
    Object.assign({}, dependencies, { [PROMOTION_GRANT]: authorization }),
  );
}

function runEmployeeMutation(
  input: InternalCreateEmployeeInput,
  mutationId: string,
  dependencies: InternalCreateEmployeeDependencies,
): Promise<CreateEmployeeResult> {
  const ctxRoot = dependencies.ctxRoot ?? process.env.CTX_ROOT ?? join(homedir(), '.cortextos', dependencies.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default');
  const key = `${ctxRoot}\0${mutationId}`;
  const target = input?.name ?? '';
  const requestDigest = employeeRequestDigest(input, dependencies);
  const current = employeeMutationRuns.get(key);
  if (current) {
    if (current.actor !== input?.actor || current.target !== target || current.requestDigest !== requestDigest) {
      return Promise.reject(new CrewServiceError('IDEMPOTENCY_CONFLICT', 409, 'Mutation id is already bound to another request'));
    }
    return current.promise;
  }
  const leaseToken = beginCrewMutationOperation(mutationId);
  const promise = Promise.resolve().then(() => createEmployeeInternal(input, mutationId, dependencies));
  const descriptor = { actor: input?.actor ?? '', target, requestDigest, promise };
  employeeMutationRuns.set(key, descriptor);
  void promise.then(
    () => { if (employeeMutationRuns.get(key) === descriptor) employeeMutationRuns.delete(key); releaseCrewMutationOperation(mutationId, leaseToken); },
    () => { if (employeeMutationRuns.get(key) === descriptor) employeeMutationRuns.delete(key); releaseCrewMutationOperation(mutationId, leaseToken); },
  );
  return promise;
}

async function createEmployeeInternal(
  input: InternalCreateEmployeeInput,
  mutationId: string = randomUUID(),
  dependencies: InternalCreateEmployeeDependencies = {},
): Promise<CreateEmployeeResult> {
  const ctxRoot = dependencies.ctxRoot ?? process.env.CTX_ROOT ?? join(homedir(), '.cortextos', dependencies.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default');
  const frameworkRoot = dependencies.frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT ?? process.env.CTX_PROJECT_ROOT ?? process.cwd();
  const instanceId = dependencies.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
  const now = dependencies.now ?? (() => new Date().toISOString());
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationId)) {
    throw new CrewServiceError('INVALID_MUTATION_ID', 400, 'A valid mutation id is required');
  }
  validateInputShape(input);

  reconcileCrewMutationJournal(ctxRoot, { frameworkRoot });
  const requestDigest = employeeRequestDigest(input, dependencies);
  const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
  const roomsPath = join(ctxRoot, 'config', 'rooms.json');
  const terminalMutation = getCrewMutation(ctxRoot, mutationId);
  if (terminalMutation) {
    const sameRequest = terminalMutation.actor === input.actor
      && terminalMutation.action === 'create'
      && terminalMutation.target.kind === 'employee'
      && terminalMutation.target.id === input.name
      && terminalMutation.request_digest === requestDigest;
    if (!sameRequest) throw new CrewServiceError('IDEMPOTENCY_CONFLICT', 409, 'Mutation id is already bound to another request');
    if (terminalMutation.stage === 'finalized') {
      const stored = resultFromSnapshot(terminalMutation.final_result?.result_snapshot);
      if (stored) return stored;
      if (terminalMutation.final_result?.result === 'failure') {
        const code = terminalMutation.final_result.error_code === 'EMPLOYEE_RUNTIME_EXITED'
          ? 'EMPLOYEE_RUNTIME_EXITED' : 'EMPLOYEE_START_FAILED';
        throw new CrewServiceError(code, 500, 'Employee runtime did not start');
      }
      const existing = readObject(enabledPath)[input.name];
      if (existing?.mutation_id === mutationId && terminalMutation.final_result?.error_code === 'EMPLOYEE_NOT_STARTED') {
        return resultFromRegistry(input.name, existing, false);
      }
    }
  }
  validateInputEnvironment(input, frameworkRoot);
  const workingDirectory = canonicalWorkingDirectory(input.working_directory);
  const existingRegistry = readObject(enabledPath);
  const beforeDigest = digestCrewAuditValue(existingRegistry[input.name] ?? null);
  const roomId = input.room_id ?? agentRoomId(input.name);
  const record: EmployeeRegistryRecord = {
    enabled: true,
    status: 'configured',
    org: input.org,
    runtime: input.runtime,
    model: input.model ?? null,
    working_directory: workingDirectory,
    room_id: roomId,
    mutation_id: mutationId,
    created_at: now(),
  };
  const priorMutation = getCrewMutation(ctxRoot, mutationId);
  if (priorMutation) {
    const sameRequest = priorMutation.actor === input.actor
      && priorMutation.action === 'create'
      && priorMutation.target.kind === 'employee'
      && priorMutation.target.id === input.name
      && priorMutation.request_digest === requestDigest;
    if (!sameRequest) {
      throw new CrewServiceError('IDEMPOTENCY_CONFLICT', 409, 'Mutation id is already bound to another request');
    }
    if (priorMutation.stage !== 'finalized') {
      try { claimCrewMutationLease(ctxRoot, mutationId); } catch (error) {
        if ((error as Error).message === 'MUTATION_PENDING') {
          throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation is owned by another live process');
        }
        throw error;
      }
    }
    if (priorMutation.stage === 'finalized' && priorMutation.final_result?.result === 'success') {
      const existing = readObject(enabledPath)[input.name];
      if (existing?.mutation_id === mutationId) return resultFromRegistry(input.name, existing);
    }
    if (priorMutation.stage === 'finalized' && priorMutation.final_result?.error_code === 'EMPLOYEE_NOT_STARTED') {
      const existing = readObject(enabledPath)[input.name];
      if (existing?.mutation_id === mutationId) return resultFromRegistry(input.name, existing, false);
    }
    if (['state_committed', 'effect_started', 'effect_recorded', 'audit_written'].includes(priorMutation.stage)) {
      const existing = readObject(enabledPath)[input.name];
      const exactState = existing?.mutation_id === mutationId
        && digestCrewAuditValue(existing) === priorMutation.intended_after_digest
        && existsSync(join(frameworkRoot, 'orgs', existing.org, 'agents', input.name));
      if (!exactState) throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
      if (priorMutation.stage === 'audit_written') {
        reconcileCrewMutationJournal(ctxRoot, { frameworkRoot, ownerToken: currentCrewMutationOperationToken(mutationId) });
        const reconciled = getCrewMutation(ctxRoot, mutationId);
        if (reconciled?.stage === 'finalized' && reconciled.final_result?.result === 'success') {
          return resultFromRegistry(input.name, existing);
        }
        throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
      }
      const startRequest = {
        name: input.name,
        org: existing.org,
        agent_dir: join(frameworkRoot, 'orgs', existing.org, 'agents', input.name),
        mutation_id: mutationId,
      };
      let receipt: EmployeeStartReceipt | null;
      if (priorMutation.stage === 'state_committed') {
        startCrewMutationEffect(ctxRoot, mutationId);
        receipt = await (dependencies.startEmployee ?? (request => defaultStart(instanceId, request)))(startRequest);
      } else {
        receipt = await dependencies.queryEmployeeStart?.(startRequest) ?? null;
      }
      if (!receipt) {
        throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee start recovery returned an invalid receipt');
      }
      try { validateStartReceipt(receipt, startRequest); } catch {
        throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee start recovery returned an invalid receipt');
      }
      if (priorMutation.stage !== 'effect_recorded') {
        recordCrewMutationEffect(ctxRoot, mutationId, {
          ...receipt,
          receipt_digest: employeeStartReceiptDigest(receipt),
        });
      }
      const recoveredResult = resultFromRegistry(input.name, existing, receipt.started);
      finalizeCrewMutationAudit(ctxRoot, mutationId, receipt.started
        ? { result: 'success', after_digest: priorMutation.intended_after_digest, result_snapshot: resultSnapshot(recoveredResult) }
        : receipt.disposition === 'exited' || receipt.disposition === 'failed'
          ? {
            result: 'failure', after_digest: priorMutation.intended_after_digest,
            error_code: receipt.disposition === 'failed' ? 'EMPLOYEE_START_FAILED' : 'EMPLOYEE_RUNTIME_EXITED',
            sanitized_error: receipt.disposition === 'failed' ? 'Employee runtime did not become ready' : 'Employee runtime exited before recovery',
          }
          : { result: 'indeterminate', after_digest: priorMutation.intended_after_digest, error_code: 'EMPLOYEE_NOT_STARTED', sanitized_error: 'Employee configured but runtime not started', result_snapshot: resultSnapshot(recoveredResult) });
      if (receipt.disposition === 'failed') throw new CrewServiceError('EMPLOYEE_START_FAILED', 500, 'Employee runtime did not become ready');
      if (receipt.disposition === 'exited') throw new CrewServiceError('EMPLOYEE_RUNTIME_EXITED', 500, 'Employee runtime exited before recovery');
      return recoveredResult;
    }
    throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
  }
  if (listPendingCrewMutations(ctxRoot).some(entry => entry.target.kind === 'employee' && entry.target.id === input.name)) {
    throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee has a pending mutation');
  }
  const intendedAfterDigest = digestCrewAuditValue(record);
  let prepared;
  try {
    prepared = prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId,
      idempotency_key: mutationId,
      actor: input.actor,
      target: { kind: 'employee', id: input.name },
      action: 'create',
      request_digest: requestDigest,
      before_digest: beforeDigest,
      intended_after_digest: intendedAfterDigest,
    }, now);
  } catch (error) {
    if ((error as Error).message.includes('conflict')) {
      throw new CrewServiceError('IDEMPOTENCY_CONFLICT', 409, 'Mutation id is already bound to another request');
    }
    throw error;
  }
  if (prepared.reused) {
    if (prepared.entry.stage === 'finalized' && prepared.entry.final_result?.result === 'success') {
      const existing = readObject(enabledPath)[input.name];
      if (existing?.mutation_id === mutationId) return resultFromRegistry(input.name, existing);
    }
    throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
  }

  const agentsDir = join(frameworkRoot, 'orgs', input.org, 'agents');
  const finalDir = join(agentsDir, input.name);
  const stageDir = join(agentsDir, `.creating-${input.name}-${mutationId}`);
  let stateCommitted = false;
  let publicationRestored = true;
  let hostSkillLinks: string[] = [];
  try {
    if (existsSync(finalDir)) throw new CrewServiceError('CONFLICT', 409, 'Employee already exists');
    mkdirSync(agentsDir, { recursive: true });
    const source = join(frameworkRoot, 'templates', templateName(input.runtime));
    if (!existsSync(source)) throw new CrewServiceError('TEMPLATE_UNAVAILABLE', 503, 'Employee template is unavailable');
    cpSync(source, stageDir, { recursive: true, errorOnExist: true });
    replaceTemplateTokens(stageDir, {
      agent_name: input.name,
      org: input.org,
      current_timestamp: record.created_at,
    });
    hostSkillLinks = installRuntimeSkills(stageDir, finalDir, input.name, input.runtime);
    const configPath = join(stageDir, 'config.json');
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
        throw new CrewServiceError('TEMPLATE_INVALID', 503, 'Employee template configuration is invalid');
      }
    }
    durableWriteJson(configPath, {
      ...config,
      agent_name: input.name,
      enabled: true,
      runtime: input.runtime,
      model: input.model ?? config.model ?? null,
      working_directory: record.working_directory,
      telegram_polling: false,
      mutation_id: mutationId,
    });
    writeFileSync(join(stageDir, '.env'), '# Tokenless Employee environment\n', { mode: 0o600 });
    if (dependencies.failAt === 'before-state-commit') throw new Error('injected before state commit');

    mkdirSync(join(ctxRoot, 'config'), { recursive: true, mode: 0o700 });
    withFileLockSync(join(ctxRoot, 'config'), () => {
      const registry = readObject(enabledPath);
      if (registry[input.name]) throw new CrewServiceError('CONFLICT', 409, 'Employee already exists');
      const rooms = readRooms(roomsPath);
      const matchingRoom = rooms.find(room => room.id === roomId);
      const grant = dependencies[PROMOTION_GRANT];
      let sourceRoom = false;
      if (matchingRoom?.kind === 'work_session' && grant) {
        let sessions: Array<Record<string, unknown>>;
        try { sessions = JSON.parse(readFileSync(join(ctxRoot, 'config', 'work-sessions.json'), 'utf8')); } catch {
          throw new CrewServiceError('PROMOTION_UNAUTHORIZED', 409, 'Source Work Session is unavailable');
        }
        const source = sessions.find(session => session.id === grant.source_work_session_id);
        const parent = getCrewMutation(ctxRoot, grant.parent_mutation_id);
        sourceRoom = matchingRoom.work_session_id === grant.source_work_session_id
          && source?.lifecycle === 'archived'
          && source?.mutation_id === grant.parent_mutation_id
          && source?.room_id === roomId
          && source?.canonical_cwd === record.working_directory
          && parent?.target.kind === 'work_session'
          && parent.target.id === grant.source_work_session_id
          && parent.action === 'promote'
          && ['state_committed', 'effect_started'].includes(parent.stage)
          && promotionEmployeeMutationId(grant.parent_mutation_id) === mutationId;
        if (!sourceRoom) throw new CrewServiceError('PROMOTION_UNAUTHORIZED', 409, 'Promotion grant does not match durable state');
      }
      if (matchingRoom && !sourceRoom && (matchingRoom.kind !== 'agent' || matchingRoom.agent !== input.name)) {
        throw new CrewServiceError('ROOM_CONFLICT', 409, 'Room identifier is already in use');
      }
      const registryBefore = structuredClone(registry);
      const roomsBefore = structuredClone(rooms);
      let directoryPublished = false;
      let enabledWriteAttempted = false;
      let roomsWriteAttempted = false;
      try {
        renameSync(stageDir, finalDir);
        directoryPublished = true;
        publicationRestored = false;
        if (dependencies.failAt === 'after-directory-publish') throw new Error('injected after directory publish');
        registry[input.name] = record;
        if (sourceRoom) {
          const index = rooms.findIndex(room => room.id === roomId);
          rooms[index] = {
            ...matchingRoom!,
            kind: 'agent',
            title: input.name,
            members: Array.from(new Set([...matchingRoom!.members, input.name])),
            agent: input.name,
            work_session_id: grant?.source_work_session_id,
            mutation_id: mutationId,
          };
        } else if (!matchingRoom) {
          rooms.push({
            id: roomId,
            kind: 'agent',
            title: input.name,
            members: [input.name],
            agent: input.name,
            created_at: record.created_at,
            created_by: input.actor,
            mutation_id: mutationId,
          });
        }
        enabledWriteAttempted = true;
        durableWriteJson(enabledPath, registry);
        if (dependencies.failAt === 'after-enabled-write') throw new Error('injected after enabled registry write');
        roomsWriteAttempted = true;
        durableWriteJson(roomsPath, rooms);
      } catch (publicationError) {
        let compensationError: unknown = null;
        try {
          if (roomsWriteAttempted) durableWriteJson(roomsPath, roomsBefore);
          if (enabledWriteAttempted) durableWriteJson(enabledPath, registryBefore);
          if (directoryPublished && existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
          publicationRestored = true;
        } catch (error) {
          compensationError = error;
          publicationRestored = false;
        }
        if (compensationError) throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee publication requires recovery');
        throw publicationError;
      }
    });
    if (dependencies.failAt === 'after-publication') throw new Error('injected after publication');
    stateCommitted = true;
    commitCrewMutationState(ctxRoot, mutationId, intendedAfterDigest);
    if (dependencies.failAt === 'after-state-commit') throw new Error('injected after state commit');
    startCrewMutationEffect(ctxRoot, mutationId);
    if (dependencies.failAt === 'after-effect-start') throw new Error('injected after effect start');
    const receipt = await (dependencies.startEmployee ?? (request => defaultStart(instanceId, request)))({
      name: input.name,
      org: input.org,
      agent_dir: finalDir,
      mutation_id: mutationId,
    });
    validateStartReceipt(receipt, { name: input.name, org: input.org, agent_dir: finalDir, mutation_id: mutationId });
    recordCrewMutationEffect(ctxRoot, mutationId, {
      ...receipt,
      receipt_digest: employeeStartReceiptDigest(receipt),
    });
    if (dependencies.failAt === 'after-effect') throw new Error('injected after effect');
    const createdResult = resultFromRegistry(input.name, record, receipt.started);
    finalizeCrewMutationAudit(ctxRoot, mutationId, receipt.started ? {
      result: 'success', after_digest: intendedAfterDigest, result_snapshot: resultSnapshot(createdResult),
    } : receipt.disposition === 'exited' || receipt.disposition === 'failed' ? {
      result: 'failure', after_digest: intendedAfterDigest,
      error_code: receipt.disposition === 'failed' ? 'EMPLOYEE_START_FAILED' : 'EMPLOYEE_RUNTIME_EXITED',
      sanitized_error: receipt.disposition === 'failed' ? 'Employee runtime did not become ready' : 'Employee runtime exited before recovery',
    } : {
      result: 'indeterminate', after_digest: intendedAfterDigest,
      error_code: 'EMPLOYEE_NOT_STARTED', sanitized_error: 'Employee configured but runtime not started',
      result_snapshot: resultSnapshot(createdResult),
    }, { failAfterAppend: dependencies.failAt === 'after-audit' });
    if (receipt.disposition === 'failed') throw new CrewServiceError('EMPLOYEE_START_FAILED', 500, 'Employee runtime did not become ready');
    if (receipt.disposition === 'exited') throw new CrewServiceError('EMPLOYEE_RUNTIME_EXITED', 500, 'Employee runtime exited before recovery');
    return createdResult;
  } catch (error) {
    if (!stateCommitted && publicationRestored) {
      rmSync(stageDir, { recursive: true, force: true });
      for (const link of hostSkillLinks) {
        try { unlinkSync(link); } catch { /* best effort */ }
      }
      const serviceError = error instanceof CrewServiceError ? error : new CrewServiceError('CREATE_FAILED', 500, 'Employee creation failed');
      finalizeCrewMutationAudit(ctxRoot, mutationId, {
        result: serviceError.status === 409 ? 'denied' : 'failure',
        after_digest: beforeDigest,
        error_code: serviceError.code,
        sanitized_error: serviceError.status === 409 ? 'Employee creation conflict' : 'Employee creation failed',
      });
      throw serviceError;
    }
    if (error instanceof CrewServiceError && ['MUTATION_OUTCOME_UNKNOWN', 'MUTATION_PENDING', 'EMPLOYEE_START_FAILED', 'EMPLOYEE_RUNTIME_EXITED'].includes(error.code)) throw error;
    throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
  }
}

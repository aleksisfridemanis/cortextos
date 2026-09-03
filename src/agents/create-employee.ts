import { randomBytes, randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { homedir } from 'os';
import {
  commitCrewMutationState,
  finalizeCrewMutationAudit,
  getCrewMutation,
  prepareCrewMutation,
  reconcileCrewMutationJournal,
  recordCrewMutationEffect,
  startCrewMutationEffect,
} from '../audit/crew-mutation-journal.js';
import { digestCrewAuditValue } from '../audit/crew-lifecycle-audit.js';
import { agentRoomId, validateRoomId } from '../rooms/id.js';
import { validateAgentName, validateOrgName } from '../utils/validate.js';
import { withFileLockSync } from '../utils/lock.js';
import type { Room } from '../types/index.js';

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
  status: 'created';
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
  started: boolean;
}

export interface CreateEmployeeDependencies {
  ctxRoot?: string;
  frameworkRoot?: string;
  instanceId?: string;
  now?: () => string;
  startEmployee?: (request: EmployeeStartRequest) => Promise<EmployeeStartReceipt>;
  failAt?: 'before-state-commit' | 'after-directory-publish' | 'after-enabled-write' | 'after-state-commit' | 'after-effect' | 'after-audit';
}

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

function validateInput(input: CreateEmployeeInput, frameworkRoot: string): void {
  if (!input || typeof input !== 'object') throw new CrewServiceError('INVALID_INPUT', 400, 'Invalid Employee request');
  if (typeof input.name !== 'string' || input.name.length > CREW_NAME_MAX_CHARS) {
    throw new CrewServiceError('INVALID_NAME', 400, `Employee name must contain at most ${CREW_NAME_MAX_CHARS} characters`);
  }
  try { validateAgentName(input.name); } catch { throw new CrewServiceError('INVALID_NAME', 400, 'Invalid Employee name'); }
  if (typeof input.org !== 'string') throw new CrewServiceError('INVALID_ORG', 400, 'Organization is required');
  try { validateOrgName(input.org); } catch { throw new CrewServiceError('INVALID_ORG', 400, 'Invalid organization'); }
  if (!existsSync(join(frameworkRoot, 'orgs', input.org)) || !lstatSync(join(frameworkRoot, 'orgs', input.org)).isDirectory()) {
    throw new CrewServiceError('ORG_NOT_FOUND', 404, 'Organization not found');
  }
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
    type: 'start-agent',
    agent: request.name,
    source: 'create-employee',
    mutation_id: request.mutation_id,
    data: { dir: request.agent_dir, mutation_id: request.mutation_id },
  });
  if (!response.success) {
    if (response.error?.includes('Daemon is not running')) {
      return { mutation_id: request.mutation_id, started: false };
    }
    throw new Error(response.code ?? 'DAEMON_START_FAILED');
  }
  return { mutation_id: request.mutation_id, started: true };
}

function resultFromRegistry(name: string, record: EmployeeRegistryRecord): CreateEmployeeResult {
  return { status: 'created', employee: { name, ...record }, audit: 'finalized' };
}

export async function createEmployee(
  input: CreateEmployeeInput,
  mutationId: string = randomUUID(),
  dependencies: CreateEmployeeDependencies = {},
): Promise<CreateEmployeeResult> {
  const ctxRoot = dependencies.ctxRoot ?? process.env.CTX_ROOT ?? join(homedir(), '.cortextos', dependencies.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default');
  const frameworkRoot = dependencies.frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT ?? process.env.CTX_PROJECT_ROOT ?? process.cwd();
  const instanceId = dependencies.instanceId ?? process.env.CTX_INSTANCE_ID ?? 'default';
  const now = dependencies.now ?? (() => new Date().toISOString());
  validateInput(input, frameworkRoot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationId)) {
    throw new CrewServiceError('INVALID_MUTATION_ID', 400, 'A valid mutation id is required');
  }

  reconcileCrewMutationJournal(ctxRoot);
  const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
  const roomsPath = join(ctxRoot, 'config', 'rooms.json');
  const existingRegistry = readObject(enabledPath);
  const beforeDigest = digestCrewAuditValue(existingRegistry[input.name] ?? null);
  const roomId = input.room_id ?? agentRoomId(input.name);
  const record: EmployeeRegistryRecord = {
    enabled: true,
    status: 'configured',
    org: input.org,
    runtime: input.runtime,
    model: input.model ?? null,
    working_directory: input.working_directory ? resolve(input.working_directory) : null,
    room_id: roomId,
    mutation_id: mutationId,
    created_at: now(),
  };
  const requestDigest = digestCrewAuditValue({
    name: input.name,
    org: input.org,
    runtime: input.runtime,
    model: input.model ?? null,
    working_directory: input.working_directory ?? null,
    telegram_polling: false,
    room_id: roomId,
  });
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
    if (priorMutation.stage === 'finalized' && priorMutation.final_result?.result === 'success') {
      const existing = readObject(enabledPath)[input.name];
      if (existing?.mutation_id === mutationId) return resultFromRegistry(input.name, existing);
    }
    throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
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
      if (matchingRoom && (matchingRoom.kind !== 'agent' || matchingRoom.agent !== input.name)) {
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
        if (!matchingRoom) {
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
    stateCommitted = true;
    commitCrewMutationState(ctxRoot, mutationId, intendedAfterDigest);
    if (dependencies.failAt === 'after-state-commit') throw new Error('injected after state commit');
    startCrewMutationEffect(ctxRoot, mutationId);
    const receipt = await (dependencies.startEmployee ?? (request => defaultStart(instanceId, request)))({
      name: input.name,
      org: input.org,
      agent_dir: finalDir,
      mutation_id: mutationId,
    });
    if (receipt.mutation_id !== mutationId || typeof receipt.started !== 'boolean') throw new Error('Invalid daemon mutation receipt');
    recordCrewMutationEffect(ctxRoot, mutationId, {
      mutation_id: receipt.mutation_id,
      started: receipt.started,
      receipt_digest: digestCrewAuditValue(receipt),
    });
    if (dependencies.failAt === 'after-effect') throw new Error('injected after effect');
    finalizeCrewMutationAudit(ctxRoot, mutationId, {
      result: 'success',
      after_digest: intendedAfterDigest,
    }, { failAfterAppend: dependencies.failAt === 'after-audit' });
    return resultFromRegistry(input.name, record);
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
    throw new CrewServiceError('MUTATION_PENDING', 503, 'Employee mutation requires recovery');
  }
}

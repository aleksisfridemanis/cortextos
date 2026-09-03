import { createHash, randomUUID } from 'crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync, writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import type { WorkSessionRecord } from '../work-sessions/types.js';
import type { WorkSessionLaunchInput, WorkSessionResumeHandle, WorkSessionRuntimeAdapter, WorkSessionRuntimeOutput } from '../work-sessions/types.js';
import {
  captureProcessIdentity, probeProcessGroup, probeProcessIdentity, signalProcessTree, type ProcessIdentity,
} from '../utils/process-identity.js';
import { atomicWriteSync } from '../utils/atomic.js';
import { closedRuntimeErrorCode } from '../utils/application-error.js';
import { withFileLockSync } from '../utils/lock.js';

const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

export interface WorkSessionEnvironmentIdentity {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  sessionId: string;
  roomId: string;
  projectRoot: string;
}

export function workSessionChildEnv(source: NodeJS.ProcessEnv, identity?: WorkSessionEnvironmentIdentity): NodeJS.ProcessEnv {
  const env = Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]])) as NodeJS.ProcessEnv;
  if (identity) Object.assign(env, {
    CTX_INSTANCE_ID: identity.instanceId,
    CTX_ROOT: identity.ctxRoot,
    CTX_FRAMEWORK_ROOT: identity.frameworkRoot,
    CTX_WORK_SESSION_ID: identity.sessionId,
    CTX_ROOM_ID: identity.roomId,
    CTX_PROJECT_ROOT: identity.projectRoot,
  });
  return env;
}

export function buildClaudeWorkSessionLaunch(input: { cwd: string; sessionId: string; resume: boolean; settingsPath?: string; mcpConfigPath?: string; model?: string }) {
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'];
  args.push(...(input.resume
    ? ['--resume', input.sessionId]
    : ['--session-id', input.sessionId]));
  args.push('--permission-mode', 'manual');
  // Safe mode is the documented OAuth-compatible isolation boundary. We still
  // verify the init frame below because an older CLI that ignores the flag is
  // not safe enough for session-only context.
  args.push('--safe-mode', '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config');
  if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath);
  if (input.settingsPath) args.push('--settings', input.settingsPath);
  if (input.model) args.push('--model', input.model);
  return { command: 'claude', args, cwd: input.cwd, env: workSessionChildEnv(process.env) };
}

const CLAUDE_AMBIENT_SOURCE_FIELDS = ['memory_paths', 'agents', 'plugins', 'skills', 'commands', 'mcp_servers'] as const;

export function claudeInitIsIsolated(frame: Record<string, unknown>): boolean {
  const nonEmpty = (value: unknown): boolean => Array.isArray(value) ? value.length > 0
    : value !== null && typeof value === 'object' ? Object.keys(value as object).length > 0
    : typeof value === 'string' ? value.length > 0 : value === true;
  return CLAUDE_AMBIENT_SOURCE_FIELDS.every(field => !nonEmpty(frame[field]));
}

interface CodexRequest { method: string; params: Record<string, unknown> }
export function buildCodexWorkSessionLaunch(input: { cwd: string; model?: string; threadId?: string }) {
  const shared = { cwd: input.cwd, model: input.model, sandbox: 'workspace-write', approvalPolicy: 'never', allowProviderModelFallback: false };
  const requests: CodexRequest[] = [{ method: 'initialize', params: { clientInfo: { name: 'cortextos-work-session', version: '1' } } }];
  requests.push(input.threadId
    ? { method: 'thread/resume', params: { ...shared, threadId: input.threadId } }
    : { method: 'thread/start', params: shared });
  return { command: 'codex', args: ['app-server'], cwd: input.cwd, env: workSessionChildEnv(process.env), requests };
}

export interface OpenCodeSessionCandidate { id: string; cwd: string; created_at: number; updated_at?: number }
export function selectOpenCodeSession(candidates: OpenCodeSessionCandidate[], canonicalCwd: string, spawnStart: number, spawnEnd: number): string {
  const matches = candidates.filter(row => row.cwd === canonicalCwd && row.created_at >= spawnStart && row.created_at <= spawnEnd);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'OPENCODE_SESSION_NOT_FOUND' : 'OPENCODE_SESSION_AMBIGUOUS');
  return matches[0].id;
}

export function buildOpenCodeWorkSessionLaunch(input: { cwd: string; sessionId?: string; model?: string }) {
  const args = ['acp', '--cwd', input.cwd, '--pure'];
  return { command: 'opencode', args, cwd: input.cwd, env: workSessionChildEnv(process.env) };
}

export function discoverOpenCodeSession(
  databasePath: string,
  canonicalCwd: string,
  spawnStart: number,
  spawnEnd: number,
  query: (databasePath: string) => OpenCodeSessionCandidate[],
): string {
  if (!existsSync(databasePath)) throw new Error('OPENCODE_SESSION_NOT_FOUND');
  return selectOpenCodeSession(query(databasePath).map(row => ({ ...row, cwd: realpathSync(row.cwd) })), realpathSync(canonicalCwd), spawnStart, spawnEnd);
}

export function claudeSessionSettings(canonicalCwd: string, reporterCommand: string): Record<string, unknown> {
  return {
    permissions: { defaultMode: 'manual', allow: [], deny: [] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [realpathSync(canonicalCwd)] },
    },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: reporterCommand }] }] },
  };
}

export function openCodePermissionConfig(): Record<string, unknown> {
  return { permission: { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'ask' } };
}

/** Build an isolated OpenCode home while copying only its documented auth store. */
export function prepareOpenCodeEnvironment(source: NodeJS.ProcessEnv, stateDir: string): Record<string, string> {
  const sourceHome = source.HOME;
  const sourceData = source.XDG_DATA_HOME ?? (sourceHome ? join(sourceHome, '.local', 'share') : null);
  if (!sourceData) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
  const sourceAuth = join(sourceData, 'opencode', 'auth.json');
  if (!existsSync(sourceAuth)) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
  const home = join(stateDir, 'home');
  const data = join(stateDir, 'data');
  const config = join(stateDir, 'config');
  const cache = join(stateDir, 'cache');
  const authDir = join(data, 'opencode');
  for (const directory of [home, data, config, cache, authDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const auth = join(authDir, 'auth.json');
  // Refresh through a new inode so an existing mode-0400 credential copy can
  // be replaced safely during exact resume without ever becoming writable.
  atomicWriteSync(auth, readFileSync(sourceAuth, 'utf8').trimEnd());
  chmodSync(auth, 0o400);
  return { HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, OPENCODE_CONFIG_DIR: config };
}

/** Isolate Codex state/instructions while preserving only installed authentication. */
export function prepareCodexEnvironment(source: NodeJS.ProcessEnv, stateDir: string): Record<string, string> {
  const sourceRoot = source.CODEX_HOME ?? (source.HOME ? join(source.HOME, '.codex') : null);
  if (!sourceRoot || !existsSync(join(sourceRoot, 'auth.json'))) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
  const home = join(stateDir, 'home');
  const codexHome = join(stateDir, 'codex-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const auth = join(codexHome, 'auth.json');
  atomicWriteSync(auth, readFileSync(join(sourceRoot, 'auth.json'), 'utf8').trimEnd());
  chmodSync(auth, 0o400);
  atomicWriteSync(join(codexHome, 'config.toml'), [
    'project_doc_max_bytes = 0',
    'model_provider = "openai"',
    '[shell_environment_policy]',
    'inherit = "none"',
  ].join('\n'));
  chmodSync(join(codexHome, 'config.toml'), 0o400);
  return { HOME: home, CODEX_HOME: codexHome };
}

/**
 * Process ownership is intentionally injected. The daemon supplies the native
 * PTY implementation; tests and recovery can exercise exact-handle semantics
 * without ever scanning for a "latest" session.
 */
export function createWorkSessionAdapter(
  harness: 'claude-code' | 'codex-app-server' | 'opencode',
  transport: {
    launch(spec: ReturnType<typeof buildClaudeWorkSessionLaunch> | ReturnType<typeof buildCodexWorkSessionLaunch> | ReturnType<typeof buildOpenCodeWorkSessionLaunch>): Promise<{
      session_id?: string;
      thread_id?: string;
      runtime_owner?: ProcessIdentity & { mutation_id: string };
    }>;
    send(text: string): Promise<void>;
    stop(): Promise<void>;
  },
): WorkSessionRuntimeAdapter {
  let currentOwner: (ProcessIdentity & { mutation_id: string }) | null = null;
  const owner = (value: (ProcessIdentity & { mutation_id: string }) | undefined, mutationId: string) => {
    currentOwner = requireTransportOwner(value, mutationId);
    return currentOwner;
  };
  return {
    async startFresh(input) {
      if (harness === 'claude-code') {
        const sessionId = randomUUID();
        const receipt = await transport.launch(buildClaudeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId, resume: false }));
        return { resume_handle: { runtime: 'claude-code', session_id: sessionId }, runtime_owner: owner(receipt.runtime_owner, input.mutation_id) };
      }
      if (harness === 'codex-app-server') {
        const receipt = await transport.launch(buildCodexWorkSessionLaunch({ cwd: input.cwd, model: input.model }));
        if (!receipt.thread_id) throw new Error('CODEX_THREAD_START_UNACKNOWLEDGED');
        return { resume_handle: { runtime: 'codex-app-server', thread_id: receipt.thread_id }, runtime_owner: owner(receipt.runtime_owner, input.mutation_id) };
      }
      const receipt = await transport.launch(buildOpenCodeWorkSessionLaunch({ cwd: input.cwd, model: input.model }));
      if (!receipt.session_id) throw new Error('OPENCODE_SESSION_UNACKNOWLEDGED');
      return { resume_handle: { runtime: 'opencode', session_id: receipt.session_id }, runtime_owner: owner(receipt.runtime_owner, input.mutation_id) };
    },
    async resumeExact(handle, input) {
      if (handle.runtime !== harness) throw new Error('RESUME_HANDLE_HARNESS_MISMATCH');
      let receipt: { session_id?: string; thread_id?: string; runtime_owner?: ProcessIdentity & { mutation_id: string } };
      if (handle.runtime === 'claude-code') {
        receipt = await transport.launch(buildClaudeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId: handle.session_id, resume: true }));
        if (receipt.session_id !== handle.session_id) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      } else if (handle.runtime === 'codex-app-server') {
        receipt = await transport.launch(buildCodexWorkSessionLaunch({ cwd: input.cwd, model: input.model, threadId: handle.thread_id }));
        if (receipt.thread_id !== handle.thread_id) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      } else {
        receipt = await transport.launch(buildOpenCodeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId: handle.session_id }));
        if (receipt.session_id !== handle.session_id) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      }
      return { runtime_owner: owner(receipt.runtime_owner, input.mutation_id) };
    },
    send: text => transport.send(text),
    stop: () => transport.stop(),
    status: () => ({ running: true, pid: null, error_code: null }),
    getResumeHandle: () => null,
    getRuntimeOwner: () => currentOwner,
  };
}

function requireTransportOwner(
  owner: (ProcessIdentity & { mutation_id: string }) | undefined,
  mutationId: string,
): ProcessIdentity & { mutation_id: string } {
  if (!owner || owner.mutation_id !== mutationId || probeProcessIdentity(owner) !== 'alive') {
    throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
  }
  return owner;
}

interface NativePty {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface NativeWorkSessionOptions {
  ctxRoot: string;
  frameworkRoot: string;
  instanceId: string;
  record: WorkSessionRecord;
  onExit?: (event: { exitCode: number; signal?: number }) => void | Promise<void>;
  onOutput?: (output: WorkSessionRuntimeOutput) => void;
  timeoutMs?: number;
  turnTimeoutMs?: number;
}

function waitFor<T>(probe: () => T | undefined, timeoutMs: number, intervalMs = 50, timeoutCode = 'RESUME_HANDLE_UNAVAILABLE'): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = probe();
        if (value !== undefined) return resolve(value);
      } catch (error) { return reject(error); }
      if (Date.now() - started >= timeoutMs) return reject(new Error(timeoutCode));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Native, tokenless PTY transport owned by the daemon for one Work Session. */
export class WorkSessionPTY implements WorkSessionRuntimeAdapter {
  private pty: NativePty | null = null;
  private buffer = '';
  private rpcId = 0;
  private readonly responses = new Map<number, unknown>();
  private readonly requestMethods = new Map<number, string>();
  private readonly timeoutMs: number;
  private readonly turnTimeoutMs: number;
  private intentionalStop = false;
  private ready = false;
  private currentThreadId: string | null = null;
  private currentHandle: WorkSessionResumeHandle | null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private currentOwner: (ProcessIdentity & { mutation_id: string }) | null = null;
  private spawningMutationId: string | null = null;
  private outputSequence = 0;
  private acpTurnText = '';
  private claudeSessionId: string | null = null;
  private claudeIsolationError: Error | null = null;
  private readonly claudeTurnResults: Array<true | Error> = [];
  private ambientOpenCodeCommands = false;
  private readonly codexTurnCompletions: Array<{ threadId: string; turnId: string } | Error> = [];
  private claudeAckPath: string | null = null;

  constructor(private readonly options: NativeWorkSessionOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 5 * 60_000;
    const receipt = this.readRuntimeReceipt();
    this.currentHandle = receipt?.resume_handle ?? options.record.resume_handle;
    this.currentOwner = receipt?.runtime_owner ?? options.record.runtime_owner ?? null;
  }

  async startFresh(input: WorkSessionLaunchInput): Promise<{ resume_handle: WorkSessionResumeHandle; runtime_owner: ProcessIdentity & { mutation_id: string } }> {
    this.assertCanonicalCwd(input.cwd);
    this.spawningMutationId = input.mutation_id;
    const result = this.options.record.harness === 'claude-code'
      ? await this.startClaude(input, undefined, input.context ?? 'Initialize this Work Session.')
      : this.options.record.harness === 'codex-app-server'
        ? await this.startCodex(input, undefined)
        : await this.startOpenCode(input, undefined);
    this.currentHandle = result.resume_handle;
    let owner: ProcessIdentity & { mutation_id: string };
    try {
      owner = this.requireCurrentOwner(input.mutation_id);
      // The continuation becomes restart-critical the instant discovery succeeds.
      // Persist it before the optional initial message introduces another await/crash
      // boundary, so restart can resume rather than treating a known handle as lost.
      this.persistRuntimeReceipt(owner, result.resume_handle);
      if (input.context && this.options.record.harness !== 'claude-code') {
        this.ready = true;
        await this.send(input.context);
      } else if (!input.context && (this.options.record.harness === 'opencode' || this.options.record.harness === 'codex-app-server')) {
        // A structured session acknowledgement alone does not prove that the
        // selected model can authenticate. Keep output suppressed until this
        // bounded provider round-trip completes.
        await this.send('Reply with OK to confirm runtime readiness.');
      }
      if (this.options.record.harness === 'opencode' && this.ambientOpenCodeCommands) throw new Error('AMBIENT_CONFIG_DETECTED');
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.ready = true;
    return { ...result, runtime_owner: owner };
  }

  async resumeExact(handle: WorkSessionResumeHandle, input: { id: string; mutation_id: string; cwd: string; model?: string }): Promise<{ runtime_owner: ProcessIdentity & { mutation_id: string } }> {
    this.assertCanonicalCwd(input.cwd);
    this.spawningMutationId = input.mutation_id;
    if (handle.runtime !== this.options.record.harness) throw new Error('RESUME_HANDLE_HARNESS_MISMATCH');
    if (handle.runtime === 'claude-code') await this.startClaude(input, handle.session_id);
    else if (handle.runtime === 'codex-app-server') await this.startCodex(input, handle.thread_id);
    else await this.startOpenCode(input, handle.session_id);
    this.currentHandle = handle;
    try {
      const owner = this.requireCurrentOwner(input.mutation_id);
      this.persistRuntimeReceipt(owner, handle);
      if (this.options.record.harness === 'opencode' && this.ambientOpenCodeCommands) throw new Error('AMBIENT_CONFIG_DETECTED');
      this.ready = true;
      return { runtime_owner: owner };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async send(text: string): Promise<void> {
    if (!this.pty) throw new Error('WORK_SESSION_NOT_RUNNING');
    if (this.options.record.harness === 'codex-app-server') {
      this.codexTurnCompletions.length = 0;
      const started = await this.rpc('turn/start', {
        threadId: this.currentThreadId ?? (this.options.record.resume_handle as { thread_id?: string } | null)?.thread_id,
        input: [{ type: 'text', text, text_elements: [] }],
        model: this.options.record.model ?? undefined,
        cwd: this.options.record.canonical_cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.options.record.canonical_cwd], networkAccess: false },
      }) as { turn?: { id?: string } };
      const turnId = started?.turn?.id;
      if (!turnId) throw new Error('RUNTIME_REQUEST_REJECTED');
      let completed: { threadId: string; turnId: string } | Error;
      const exactThreadId = this.currentThreadId;
      if (!exactThreadId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      try {
        completed = await waitFor(() => {
          if (!this.pty) return new Error('WORK_SESSION_NOT_RUNNING');
          const index = this.codexTurnCompletions.findIndex(item => item instanceof Error
            || (item.threadId === exactThreadId && item.turnId === turnId));
          return index < 0 ? undefined : this.codexTurnCompletions.splice(index, 1)[0];
        }, this.turnTimeoutMs, 50, 'RUNTIME_TURN_TIMEOUT');
      } catch (error) {
        if ((error as Error).message === 'RUNTIME_TURN_TIMEOUT') {
          await this.rpc('turn/interrupt', { threadId: this.currentThreadId, turnId }).catch(() => undefined);
        }
        throw error;
      }
      if (completed instanceof Error) throw completed;
      return;
    }
    if (this.options.record.harness === 'opencode') {
      const sessionId = this.currentHandle?.runtime === 'opencode' ? this.currentHandle.session_id : null;
      if (!sessionId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      this.acpTurnText = '';
      try {
        await this.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, this.turnTimeoutMs);
      } catch (error) {
        if ((error as Error).message === 'RUNTIME_TURN_TIMEOUT') {
          await this.rpc('session/cancel', { sessionId }).catch(() => undefined);
        }
        throw error;
      }
      return;
    }
    if (this.options.record.harness === 'claude-code') {
      const sessionId = this.currentHandle?.runtime === 'claude-code' ? this.currentHandle.session_id : null;
      if (!sessionId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      this.claudeTurnResults.length = 0;
      this.pty.write(`${JSON.stringify({
        type: 'user', session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text }] },
      })}\n`);
      if (this.claudeSessionId !== sessionId) await this.awaitClaudeAcknowledgement(sessionId);
      let result: true | Error;
      try {
        result = await waitFor(() => !this.pty ? new Error('WORK_SESSION_NOT_RUNNING') : this.claudeTurnResults.shift(), this.turnTimeoutMs, 50, 'RUNTIME_TURN_TIMEOUT');
      } catch (error) {
        if ((error as Error).message === 'RUNTIME_TURN_TIMEOUT') {
          this.pty?.write(`${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })}\n`);
        }
        throw error;
      }
      if (result instanceof Error) throw result;
      return;
    }
    this.pty.write(`\u001b[200~${text}\u001b[201~\r`);
  }

  async stop(): Promise<void> {
    const pty = this.pty;
    this.intentionalStop = true;
    this.ready = false;
    if (!pty) {
      const owner = this.currentOwner ?? this.options.record.runtime_owner;
      if (!owner) return;
      await this.terminateOwnedTree(owner);
      this.clearRuntimeReceipt();
      return;
    }
    const exit = this.exitPromise;
    if (!exit) throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
    if (this.currentOwner) {
      try { signalProcessTree(this.currentOwner, 'SIGTERM'); } catch { /* PTY kill and proof below remain authoritative */ }
    }
    try { pty.kill('SIGTERM'); } catch { /* confirm via the exit signal below */ }
    try {
      await this.awaitExit(exit, this.timeoutMs);
      if (this.currentOwner) await this.terminateOwnedTree(this.currentOwner);
      this.clearRuntimeReceipt();
      return;
    } catch { /* bounded graceful stop elapsed; escalate */ }
    try { pty.kill('SIGKILL'); } catch { /* confirm via the exit signal below */ }
    try {
      await this.awaitExit(exit, this.timeoutMs);
      if (this.currentOwner) await this.terminateOwnedTree(this.currentOwner);
      this.clearRuntimeReceipt();
    } catch {
      throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
    }
  }

  status() {
    if (this.pty) {
      const identity = captureProcessIdentity(this.pty.pid);
      return {
        running: true,
        pid: this.pty.pid,
        error_code: identity ? null : 'RUNTIME_OWNERSHIP_UNCONFIRMED',
        process_started_at: identity?.started_at ?? null,
        ownership: identity ? 'attached' as const : 'unknown' as const,
      };
    }
    const owner = this.currentOwner ?? this.options.record.runtime_owner;
    if (!owner) return { running: false, pid: null, error_code: null, process_started_at: null, ownership: 'dead' as const };
    const state = probeProcessIdentity(owner);
    if (state === 'dead') return { running: false, pid: owner.pid, error_code: null, process_started_at: owner.started_at, ownership: 'dead' as const };
    return {
      running: true,
      pid: owner.pid,
      error_code: state === 'unknown' ? 'RUNTIME_OWNERSHIP_UNCONFIRMED' : 'RUNTIME_DETACHED',
      process_started_at: owner.started_at,
      ownership: state === 'alive' ? 'detached' as const : 'unknown' as const,
    };
  }
  getResumeHandle(): WorkSessionResumeHandle | null { return this.currentHandle; }
  getRuntimeOwner(): (ProcessIdentity & { mutation_id: string }) | null { return this.currentOwner; }

  private runtimeReceiptPath(): string {
    return join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id, 'runtime-owner.json');
  }

  private readRuntimeReceipt(): { runtime_owner: ProcessIdentity & { mutation_id: string }; resume_handle: WorkSessionResumeHandle | null } | null {
    try {
      const value = JSON.parse(readFileSync(this.runtimeReceiptPath(), 'utf8'));
      if (value?.session_id !== this.options.record.id || !value.runtime_owner) return null;
      return { runtime_owner: value.runtime_owner, resume_handle: value.resume_handle ?? null };
    } catch { return null; }
  }

  private persistRuntimeReceipt(owner: ProcessIdentity & { mutation_id: string }, resumeHandle: WorkSessionResumeHandle | null): void {
    atomicWriteSync(this.runtimeReceiptPath(), JSON.stringify({
      schema_version: 1,
      session_id: this.options.record.id,
      runtime_owner: owner,
      resume_handle: resumeHandle,
    }, null, 2));
  }

  private clearRuntimeReceipt(): void {
    this.currentOwner = null;
    try { unlinkSync(this.runtimeReceiptPath()); } catch { /* already absent */ }
  }

  private requireCurrentOwner(mutationId: string): ProcessIdentity & { mutation_id: string } {
    if (!this.currentOwner || this.currentOwner.mutation_id !== mutationId) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    return this.currentOwner;
  }

  private async terminateOwnedTree(owner: ProcessIdentity): Promise<void> {
    const before = probeProcessGroup(owner);
    if (before === 'dead') return;
    if (before === 'unknown') throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
    try { signalProcessTree(owner, 'SIGTERM'); } catch { /* probe below is authoritative */ }
    try {
      await waitFor(() => probeProcessGroup(owner) === 'dead' ? true : undefined, this.timeoutMs);
      return;
    } catch { /* escalate below */ }
    const remaining = probeProcessGroup(owner);
    if (remaining !== 'alive') throw new Error('WORK_SESSION_STOP_UNCONFIRMED');
    try { signalProcessTree(owner, 'SIGKILL'); } catch { /* probe below is authoritative */ }
    try {
      await waitFor(() => probeProcessGroup(owner) === 'dead' ? true : undefined, this.timeoutMs);
    } catch { throw new Error('WORK_SESSION_STOP_UNCONFIRMED'); }
  }

  private assertCanonicalCwd(cwd: string): void {
    if (realpathSync(cwd) !== this.options.record.canonical_cwd) throw new Error('CWD_CHANGED');
  }

  private env(): Record<string, string> {
    const result = workSessionChildEnv(process.env, {
      instanceId: this.options.instanceId, ctxRoot: this.options.ctxRoot,
      frameworkRoot: this.options.frameworkRoot, sessionId: this.options.record.id,
      roomId: this.options.record.room_id, projectRoot: this.options.record.canonical_cwd,
    });
    return Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }

  private spawn(command: string, args: string[], cwd: string, env: Record<string, string>): NativePty {
    if (this.pty) throw new Error('WORK_SESSION_ALREADY_RUNNING');
    const nodePty = require('node-pty') as { spawn(file: string, args: string[], options: object): NativePty };
    const pty = nodePty.spawn(command, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd, env });
    this.intentionalStop = false;
    this.pty = pty;
    const identity = captureProcessIdentity(pty.pid);
    if (!identity) {
      try { pty.kill('SIGKILL'); } catch { /* fail closed below */ }
      this.pty = null;
      throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    }
    if (!this.spawningMutationId) {
      try { pty.kill('SIGKILL'); } catch { /* fail closed below */ }
      this.pty = null;
      throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    }
    this.currentOwner = { ...identity, mutation_id: this.spawningMutationId };
    this.persistRuntimeReceipt(this.currentOwner, null);
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    pty.onData(data => this.capture(data));
    pty.onExit(event => {
      if (this.pty === pty) this.pty = null;
      this.resolveExit?.();
      this.resolveExit = null;
      if (!this.intentionalStop && this.ready) {
        this.ready = false;
        setTimeout(() => {
          try {
            void Promise.resolve(this.options.onExit?.(event)).catch(error => {
              console.error(`[work-session] PTY exit recovery failed: ${(error as Error).message}`);
            });
          } catch (error) {
            console.error(`[work-session] PTY exit recovery failed: ${(error as Error).message}`);
          }
        }, 0);
      }
    });
    return pty;
  }

  private async awaitExit(exit: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exit,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WORK_SESSION_STOP_TIMEOUT')), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private capture(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; params?: unknown; type?: unknown; subtype?: unknown; session_id?: unknown; is_error?: unknown; message?: unknown };
        if (value.type === 'system' && value.subtype === 'init' && typeof value.session_id === 'string') {
          this.claudeSessionId = value.session_id;
          if (!claudeInitIsIsolated(value)) this.claudeIsolationError = new Error('AMBIENT_CONFIG_DETECTED');
        }
        if (value.type === 'assistant' && typeof value.error === 'string') {
          this.claudeTurnResults.push(new Error(closedRuntimeErrorCode(value, 'claude-code', 'session/prompt')));
        }
        if (value.type === 'result') {
          this.claudeTurnResults.push(value.is_error === true
            ? new Error(closedRuntimeErrorCode(value, 'claude-code', 'session/prompt'))
            : true);
        }
        if (typeof value.id === 'number' && value.method === undefined && ('result' in value || 'error' in value)) {
          this.responses.set(value.id, value);
          if (this.requestMethods.get(value.id) === 'session/prompt' && !value.error) {
            const text = this.acpTurnText.trim();
            if (text && this.ready) this.emitOutput({ id: this.fallbackOutputId(text), text });
            this.acpTurnText = '';
          }
        }
        if (typeof value.id === 'number' && value.method === 'session/request_permission') {
          this.pty?.write(`${JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } })}\n`);
        }
        if (value.method === 'session/update' && value.params && typeof value.params === 'object') {
          const update = (value.params as Record<string, unknown>).update;
          if (update && typeof update === 'object') {
            const updateValue = update as Record<string, unknown>;
            if (updateValue.sessionUpdate === 'available_commands_update') {
              const commands = updateValue.availableCommands ?? updateValue.available_commands;
              if (Array.isArray(commands) && commands.length > 0) this.ambientOpenCodeCommands = true;
            }
            const content = updateValue.content && typeof updateValue.content === 'object' ? updateValue.content as Record<string, unknown> : null;
            if (updateValue.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') {
              this.acpTurnText += content.text;
            }
          }
        }
        if (value.method === 'turn/completed') {
          const params = value.params && typeof value.params === 'object' ? value.params as Record<string, unknown> : {};
          const turn = params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : {};
          if (typeof params.threadId !== 'string' || typeof turn.id !== 'string' || typeof turn.status !== 'string') {
            this.codexTurnCompletions.push(new Error('RUNTIME_REQUEST_REJECTED'));
          } else if (turn.status === 'completed') {
            this.codexTurnCompletions.push({ threadId: params.threadId, turnId: turn.id });
          } else if (params.threadId === this.currentThreadId) {
            this.codexTurnCompletions.push(new Error(closedRuntimeErrorCode(turn, 'codex-app-server', 'turn/completed')));
          }
        }
        if (value.method === 'error') {
          this.codexTurnCompletions.push(new Error(closedRuntimeErrorCode(value.params ?? value.error ?? value, 'codex-app-server', 'turn/completed')));
        }
        const output = this.completedOutput(value);
        if (output && this.ready) this.emitOutput(output);
      } catch {
        // Interactive TUI bytes are not authoritative assistant completions.
        // Prompt echo, redraw/status chrome, and tool output must never enter
        // the durable room as if the model authored it.
        continue;
      }
    }
  }

  private emitOutput(output: WorkSessionRuntimeOutput): void {
    try {
      this.enqueueOutput(output);
      this.reconcileOutputInbox();
    } catch (error) {
      // PTY data events execute outside the request promise. A persistence
      // failure must be observable without escaping as a daemon-fatal throw.
      try {
        atomicWriteSync(this.outputRecoveryPath(), JSON.stringify({
          schema_version: 1, session_id: this.options.record.id,
          error_code: 'OUTPUT_RECOVERY_REQUIRED', updated_at: new Date().toISOString(),
        }, null, 2));
      } catch { /* the original durable failure remains authoritative */ }
      console.error(`[work-session] output persistence failed: ${(error as Error).message}`);
    }
  }

  private outputInboxPath(): string {
    return join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id, 'output-inbox');
  }

  private outputRecoveryPath(): string {
    return join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id, 'output-recovery-required.json');
  }

  private enqueueOutput(output: WorkSessionRuntimeOutput): void {
    if (!output.id || !output.text.trim()) return;
    const directory = this.outputInboxPath();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    withFileLockSync(directory, () => {
      const digest = createHash('sha256').update(output.id).digest('hex');
      const existing = readdirSync(directory).find(name => name.endsWith(`-${digest}.json`));
      if (existing) {
        const prior = JSON.parse(readFileSync(join(directory, existing), 'utf8')) as { session_id?: unknown; output?: unknown };
        const priorOutput = prior.output as Partial<WorkSessionRuntimeOutput> | undefined;
        if (prior.session_id !== this.options.record.id
          || priorOutput?.id !== output.id || priorOutput.text !== output.text) {
          throw new Error('OUTPUT_ID_CONFLICT');
        }
        return;
      }
      const sequencePath = join(directory, 'sequence.json');
      let sequence = 0;
      try {
        const counter = JSON.parse(readFileSync(sequencePath, 'utf8')) as { sequence?: unknown };
        if (!Number.isSafeInteger(counter.sequence) || Number(counter.sequence) < 0) throw new Error('OUTPUT_SEQUENCE_CORRUPT');
        sequence = Number(counter.sequence);
      } catch (error) {
        if (existsSync(sequencePath)) throw error;
      }
      sequence += 1;
      atomicWriteSync(sequencePath, JSON.stringify({ schema_version: 1, session_id: this.options.record.id, sequence }));
      const durableOutput = { ...output, completed_at: output.completed_at ?? new Date().toISOString() };
      const name = `${String(sequence).padStart(16, '0')}-${digest}.json`;
      atomicWriteSync(join(directory, name), JSON.stringify({
        schema_version: 2, session_id: this.options.record.id, sequence, completed_at: durableOutput.completed_at, output: durableOutput,
      }, null, 2));
    });
  }

  /** Publish durable completed output and remove each inbox item only after success. */
  reconcileOutputInbox(): number {
    const directory = this.outputInboxPath();
    if (!existsSync(directory)) return 0;
    if (!this.options.onOutput) return readdirSync(directory).filter(name => /^\d{16}-[0-9a-f]{64}\.json$/.test(name)).length;
    let published = 0;
    const queued = readdirSync(directory).filter(entry => /^\d{16}-[0-9a-f]{64}\.json$/.test(entry)).map(name => {
      const path = join(directory, name);
      const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
        schema_version?: unknown; session_id?: unknown; sequence?: unknown; completed_at?: unknown; output?: WorkSessionRuntimeOutput;
      };
      if (envelope.schema_version !== 2 || envelope.session_id !== this.options.record.id
        || !Number.isSafeInteger(envelope.sequence) || typeof envelope.completed_at !== 'string'
        || !envelope.output || typeof envelope.output.id !== 'string' || typeof envelope.output.text !== 'string'
        || envelope.output.completed_at !== envelope.completed_at) {
        throw new Error('OUTPUT_INBOX_CORRUPT');
      }
      return { path, sequence: Number(envelope.sequence), output: envelope.output };
    }).sort((left, right) => left.sequence - right.sequence);
    for (const envelope of queued) {
      this.options.onOutput(envelope.output);
      unlinkSync(envelope.path);
      published += 1;
    }
    try { unlinkSync(this.outputRecoveryPath()); } catch { /* no recovery marker */ }
    return published;
  }

  private completedOutput(value: Record<string, unknown>): WorkSessionRuntimeOutput | null {
    const params = value.params && typeof value.params === 'object' ? value.params as Record<string, unknown> : null;
    const item = params?.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : null;
    if (value.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
      return { id: typeof item.id === 'string' ? item.id : this.fallbackOutputId(item.text), text: item.text.trim() };
    }
    const message = value.message && typeof value.message === 'object' ? value.message as Record<string, unknown> : null;
    if (value.type === 'assistant' && typeof value.error !== 'string' && Array.isArray(message?.content)) {
      const text = message.content.flatMap(part => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
        && typeof (part as Record<string, unknown>).text === 'string' ? [(part as Record<string, unknown>).text as string] : []).join('\n').trim();
      if (text) return { id: typeof value.uuid === 'string' ? value.uuid : this.fallbackOutputId(text), text };
    }
    const properties = value.properties && typeof value.properties === 'object' ? value.properties as Record<string, unknown> : null;
    const part = properties?.part && typeof properties.part === 'object' ? properties.part as Record<string, unknown> : null;
    if (value.type === 'message.part.completed' && part?.type === 'text'
      && typeof part.text === 'string' && part.text.trim()) {
      return { id: typeof part.id === 'string' ? part.id : this.fallbackOutputId(part.text), text: part.text.trim() };
    }
    return null;
  }

  private fallbackOutputId(text: string): string {
    this.outputSequence += 1;
    const generation = this.currentOwner?.started_at ?? this.spawningMutationId ?? 'unknown';
    return createHash('sha256').update(`${generation}\0${this.outputSequence}\0${text}`).digest('hex');
  }

  private async rpc(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<any> {
    if (!this.pty) throw new Error('WORK_SESSION_NOT_RUNNING');
    const id = ++this.rpcId;
    this.requestMethods.set(id, method);
    this.pty.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waitFor(() => this.responses.get(id), timeoutMs, 50, method.includes('prompt') ? 'RUNTIME_TURN_TIMEOUT' : 'RESUME_HANDLE_UNAVAILABLE') as { error?: unknown; result?: unknown };
    this.responses.delete(id);
    this.requestMethods.delete(id);
    if (response.error) throw new Error(closedRuntimeErrorCode(response.error, this.options.record.harness, method));
    return response.result;
  }

  private async startClaude(input: { cwd: string; model?: string }, resumeId?: string, initialText?: string) {
    const sessionId = resumeId ?? randomUUID();
    this.claudeSessionId = null;
    this.claudeIsolationError = null;
    if (resumeId) {
      // Claude's CLI has no non-conversational exact-handle probe. `--resume`
      // can exit before stdin (or copy a live session), so never publish an
      // active lease from that unacknowledged process.
      const auth = JSON.parse(execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: this.timeoutMs })) as { loggedIn?: unknown };
      if (auth.loggedIn !== true) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
      throw new Error('RESUME_HANDLE_UNAVAILABLE');
    }
    const stateDir = join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const ackPath = join(stateDir, 'claude-session-ack.json');
    this.claudeAckPath = ackPath;
    try { unlinkSync(ackPath); } catch {}
    // tsup emits this reporter as a standalone sibling of daemon.js. Keeping
    // it out of the daemon bundle guarantees exactly one stdin consumer.
    const reporter = join(__dirname, 'claude-session-reporter.js');
    const settingsPath = join(stateDir, 'claude-session-settings.json');
    const mcpConfigPath = join(stateDir, 'claude-mcp.json');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(reporter)} ${JSON.stringify(sessionId)} ${JSON.stringify(ackPath)}`;
    writeFileSync(settingsPath, `${JSON.stringify(claudeSessionSettings(input.cwd, command), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(mcpConfigPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(settingsPath, 0o600);
    const spec = buildClaudeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId, resume: !!resumeId, settingsPath, mcpConfigPath });
    this.spawn(spec.command, spec.args, spec.cwd, this.env());
    try {
      this.claudeTurnResults.length = 0;
      this.ready = initialText !== 'Initialize this Work Session.';
      this.pty!.write(`${JSON.stringify({
        type: 'user', session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: initialText }] },
      })}\n`);
      await this.awaitClaudeAcknowledgement(sessionId);
      const completion = await waitFor(() => this.claudeTurnResults.shift(), this.turnTimeoutMs, 50, 'RUNTIME_TURN_TIMEOUT');
      if (completion instanceof Error) throw completion;
    } catch (error) { await this.stop(); throw error; }
    return { resume_handle: { runtime: 'claude-code' as const, session_id: sessionId } };
  }

  private async awaitClaudeAcknowledgement(sessionId: string): Promise<void> {
    const ackPath = this.claudeAckPath;
    if (!ackPath) throw new Error('RESUME_HANDLE_UNAVAILABLE');
    await waitFor(() => {
      if (this.claudeIsolationError) throw this.claudeIsolationError;
      if (this.claudeSessionId && this.claudeSessionId !== sessionId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      if (!existsSync(ackPath) || this.claudeSessionId !== sessionId) return undefined;
      const siblings = readdirSync(dirname(ackPath)).filter(name => name.startsWith('claude-session-ack'));
      if (siblings.length !== 1) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      const ack = JSON.parse(readFileSync(ackPath, 'utf8')) as { session_id?: string };
      if (ack.session_id !== sessionId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      return true;
    }, this.timeoutMs);
  }

  private async startCodex(input: { cwd: string; model?: string }, threadId?: string) {
    const spec = buildCodexWorkSessionLaunch({ cwd: input.cwd, model: input.model, threadId });
    const stateDir = join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id, 'codex');
    const isolated = prepareCodexEnvironment(process.env, stateDir);
    this.spawn(spec.command, spec.args, spec.cwd, { ...this.env(), ...isolated });
    try {
      await this.rpc('initialize', { clientInfo: { name: 'cortextos-work-session', version: '1' }, capabilities: {} });
      const shared = { cwd: input.cwd, model: input.model, approvalPolicy: 'never', sandbox: 'workspace-write', allowProviderModelFallback: false };
      const result = await this.rpc(threadId ? 'thread/resume' : 'thread/start', threadId ? { ...shared, threadId } : shared) as {
        thread?: { id?: string }; instructionSources?: unknown;
      };
      if (Array.isArray(result?.instructionSources) && result.instructionSources.length > 0) throw new Error('AMBIENT_CONFIG_DETECTED');
      const exact = result?.thread?.id;
      if (!exact || (threadId && exact !== threadId)) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      this.currentThreadId = exact;
      return { resume_handle: { runtime: 'codex-app-server' as const, thread_id: exact } };
    } catch (error) { await this.stop(); throw error; }
  }

  private queryOpenCodeSessions(databasePath: string): OpenCodeSessionCandidate[] {
    try {
      const raw = execFileSync('sqlite3', ['-json', databasePath, 'SELECT id, directory AS cwd, time_created AS created_at, time_updated AS updated_at FROM session'], { encoding: 'utf8', timeout: 2000 });
      const rows = JSON.parse(raw || '[]') as Array<{ id: string; cwd: string; created_at: number; updated_at?: number }>;
      return rows.map(row => ({
        ...row,
        created_at: row.created_at < 10_000_000_000 ? row.created_at * 1000 : row.created_at,
        updated_at: row.updated_at === undefined ? undefined : row.updated_at < 10_000_000_000 ? row.updated_at * 1000 : row.updated_at,
      }));
    } catch { return []; }
  }

  private async startOpenCode(input: { cwd: string; model?: string }, sessionId?: string) {
    this.ambientOpenCodeCommands = false;
    const stateDir = join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id, 'opencode');
    const isolated = prepareOpenCodeEnvironment(process.env, stateDir);
    const configDir = isolated.OPENCODE_CONFIG_DIR;
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, 'opencode.json'), `${JSON.stringify(openCodePermissionConfig(), null, 2)}\n`, { mode: 0o600 });
    const spec = buildOpenCodeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId });
    const env = { ...this.env(), ...isolated };
    this.spawn(spec.command, spec.args, spec.cwd, env);
    try {
      await this.rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cortextos-work-session', version: '1' },
      });
      const result = await this.rpc(sessionId ? 'session/load' : 'session/new', {
        ...(sessionId ? { sessionId } : {}), cwd: input.cwd, mcpServers: [],
      }) as { sessionId?: string };
      const exact = sessionId ?? result?.sessionId;
      if (!exact || (sessionId && result?.sessionId && result.sessionId !== sessionId)) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      if (input.model) await this.rpc('session/set_config_option', { sessionId: exact, configId: 'model', value: input.model });
      return { resume_handle: { runtime: 'opencode' as const, session_id: exact } };
    } catch (error) { await this.stop(); throw error; }
  }
}

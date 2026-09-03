import { randomUUID } from 'crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync, writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import type { WorkSessionRecord } from '../work-sessions/types.js';
import type { WorkSessionResumeHandle, WorkSessionRuntimeAdapter } from '../work-sessions/types.js';

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

export function buildClaudeWorkSessionLaunch(input: { cwd: string; sessionId: string; resume: boolean; settingsPath?: string; model?: string }) {
  const args = input.resume
    ? ['--resume', input.sessionId]
    : ['--session-id', input.sessionId];
  args.push('--permission-mode', 'manual');
  if (input.settingsPath) args.push('--settings', input.settingsPath);
  if (input.model) args.push('--model', input.model);
  return { command: 'claude', args, cwd: input.cwd, env: workSessionChildEnv(process.env) };
}

interface CodexRequest { method: string; params: Record<string, unknown> }
export function buildCodexWorkSessionLaunch(input: { cwd: string; model?: string; threadId?: string }) {
  const shared = { cwd: input.cwd, model: input.model, sandbox: 'workspaceWrite', approvalPolicy: 'never', allowProviderModelFallback: false };
  const requests: CodexRequest[] = [{ method: 'initialize', params: { clientInfo: { name: 'cortextos-work-session', version: '1' } } }];
  requests.push(input.threadId
    ? { method: 'thread/resume', params: { ...shared, threadId: input.threadId } }
    : { method: 'thread/start', params: shared });
  return { command: 'codex', args: ['app-server'], cwd: input.cwd, env: workSessionChildEnv(process.env), requests };
}

export interface OpenCodeSessionCandidate { id: string; cwd: string; created_at: number }
export function selectOpenCodeSession(candidates: OpenCodeSessionCandidate[], canonicalCwd: string, spawnStart: number, spawnEnd: number): string {
  const matches = candidates.filter(row => row.cwd === canonicalCwd && row.created_at >= spawnStart && row.created_at <= spawnEnd);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? 'OPENCODE_SESSION_NOT_FOUND' : 'OPENCODE_SESSION_AMBIGUOUS');
  return matches[0].id;
}

export function buildOpenCodeWorkSessionLaunch(input: { cwd: string; sessionId?: string; model?: string }) {
  const args = input.sessionId ? ['--session', input.sessionId, '--auto=false'] : ['--auto=false'];
  if (input.model) args.push('--model', input.model);
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

/**
 * Process ownership is intentionally injected. The daemon supplies the native
 * PTY implementation; tests and recovery can exercise exact-handle semantics
 * without ever scanning for a "latest" session.
 */
export function createWorkSessionAdapter(
  harness: 'claude-code' | 'codex-app-server' | 'opencode',
  transport: {
    launch(spec: ReturnType<typeof buildClaudeWorkSessionLaunch> | ReturnType<typeof buildCodexWorkSessionLaunch> | ReturnType<typeof buildOpenCodeWorkSessionLaunch>): Promise<{ session_id?: string; thread_id?: string }>;
    send(text: string): Promise<void>;
    stop(): Promise<void>;
  },
): WorkSessionRuntimeAdapter {
  return {
    async startFresh(input) {
      if (harness === 'claude-code') {
        const sessionId = randomUUID();
        await transport.launch(buildClaudeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId, resume: false }));
        return { resume_handle: { runtime: harness, session_id: sessionId } };
      }
      if (harness === 'codex-app-server') {
        const receipt = await transport.launch(buildCodexWorkSessionLaunch({ cwd: input.cwd, model: input.model }));
        if (!receipt.thread_id) throw new Error('CODEX_THREAD_START_UNACKNOWLEDGED');
        return { resume_handle: { runtime: harness, thread_id: receipt.thread_id } };
      }
      const receipt = await transport.launch(buildOpenCodeWorkSessionLaunch({ cwd: input.cwd, model: input.model }));
      if (!receipt.session_id) throw new Error('OPENCODE_SESSION_UNACKNOWLEDGED');
      return { resume_handle: { runtime: harness, session_id: receipt.session_id } };
    },
    async resumeExact(handle, input) {
      if (handle.runtime !== harness) throw new Error('RESUME_HANDLE_HARNESS_MISMATCH');
      if (handle.runtime === 'claude-code') await transport.launch(buildClaudeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId: handle.session_id, resume: true }));
      else if (handle.runtime === 'codex-app-server') await transport.launch(buildCodexWorkSessionLaunch({ cwd: input.cwd, model: input.model, threadId: handle.thread_id }));
      else await transport.launch(buildOpenCodeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId: handle.session_id }));
    },
    send: text => transport.send(text),
    stop: () => transport.stop(),
    status: () => ({ running: true, pid: null, error_code: null }),
    getResumeHandle: () => null,
  };
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
  onExit?: (event: { exitCode: number; signal?: number }) => void;
  timeoutMs?: number;
}

function waitFor<T>(probe: () => T | undefined, timeoutMs: number, intervalMs = 50): Promise<T> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = probe();
        if (value !== undefined) return resolve(value);
      } catch (error) { return reject(error); }
      if (Date.now() - started >= timeoutMs) return reject(new Error('RESUME_HANDLE_UNAVAILABLE'));
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
  private readonly timeoutMs: number;
  private intentionalStop = false;
  private ready = false;
  private currentThreadId: string | null = null;
  private currentHandle: WorkSessionResumeHandle | null;

  constructor(private readonly options: NativeWorkSessionOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.currentHandle = options.record.resume_handle;
  }

  async startFresh(input: { id: string; cwd: string; model?: string; context?: string }): Promise<{ resume_handle: WorkSessionResumeHandle }> {
    this.assertCanonicalCwd(input.cwd);
    const result = this.options.record.harness === 'claude-code'
      ? await this.startClaude(input, undefined)
      : this.options.record.harness === 'codex-app-server'
        ? await this.startCodex(input, undefined)
        : await this.startOpenCode(input, undefined);
    if (input.context) await this.send(input.context);
    this.currentHandle = result.resume_handle;
    this.ready = true;
    return result;
  }

  async resumeExact(handle: WorkSessionResumeHandle, input: { id: string; cwd: string; model?: string }): Promise<void> {
    this.assertCanonicalCwd(input.cwd);
    if (handle.runtime !== this.options.record.harness) throw new Error('RESUME_HANDLE_HARNESS_MISMATCH');
    if (handle.runtime === 'claude-code') await this.startClaude(input, handle.session_id);
    else if (handle.runtime === 'codex-app-server') await this.startCodex(input, handle.thread_id);
    else await this.startOpenCode(input, handle.session_id);
    this.currentHandle = handle;
    this.ready = true;
  }

  async send(text: string): Promise<void> {
    if (!this.pty) throw new Error('WORK_SESSION_NOT_RUNNING');
    if (this.options.record.harness === 'codex-app-server') {
      await this.rpc('turn/start', {
        threadId: this.currentThreadId ?? (this.options.record.resume_handle as { thread_id?: string } | null)?.thread_id,
        input: [{ type: 'text', text, text_elements: [] }],
        model: this.options.record.model ?? undefined,
        cwd: this.options.record.canonical_cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.options.record.canonical_cwd], networkAccess: false },
      });
      return;
    }
    this.pty.write(`\u001b[200~${text}\u001b[201~\r`);
  }

  async stop(): Promise<void> {
    const pty = this.pty;
    this.intentionalStop = true;
    this.ready = false;
    this.pty = null;
    if (pty) { try { pty.kill('SIGTERM'); } catch {} }
  }

  status() { return { running: this.pty !== null, pid: this.pty?.pid ?? null, error_code: null }; }
  getResumeHandle(): WorkSessionResumeHandle | null { return this.currentHandle; }

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
    pty.onData(data => this.capture(data));
    pty.onExit(event => {
      if (this.pty === pty) this.pty = null;
      if (!this.intentionalStop && this.ready) {
        this.ready = false;
        setTimeout(() => this.options.onExit?.(event), 0);
      }
    });
    return pty;
  }

  private capture(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as { id?: unknown };
        if (typeof value.id === 'number') this.responses.set(value.id, value);
      } catch { /* normal TUI output */ }
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.pty) throw new Error('WORK_SESSION_NOT_RUNNING');
    const id = ++this.rpcId;
    this.pty.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waitFor(() => this.responses.get(id), this.timeoutMs) as { error?: unknown; result?: unknown };
    this.responses.delete(id);
    if (response.error) throw new Error(`${method.toUpperCase().replaceAll('/', '_')}_REJECTED`);
    return response.result;
  }

  private async startClaude(input: { cwd: string; model?: string }, resumeId?: string) {
    const sessionId = resumeId ?? randomUUID();
    const stateDir = join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const ackPath = join(stateDir, 'claude-session-ack.json');
    try { unlinkSync(ackPath); } catch {}
    const reporter = join(__dirname, 'daemon.js');
    const settingsPath = join(stateDir, 'claude-session-settings.json');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(reporter)} --claude-session-report ${JSON.stringify(sessionId)} ${JSON.stringify(ackPath)}`;
    writeFileSync(settingsPath, `${JSON.stringify(claudeSessionSettings(input.cwd, command), null, 2)}\n`, { mode: 0o600 });
    chmodSync(settingsPath, 0o600);
    const spec = buildClaudeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId, resume: !!resumeId, settingsPath });
    this.spawn(spec.command, spec.args, spec.cwd, this.env());
    try {
      await waitFor(() => {
        if (!existsSync(ackPath)) return undefined;
        const siblings = readdirSync(dirname(ackPath)).filter(name => name.startsWith('claude-session-ack'));
        if (siblings.length !== 1) throw new Error('RESUME_HANDLE_UNAVAILABLE');
        const ack = JSON.parse(readFileSync(ackPath, 'utf8')) as { session_id?: string };
        if (ack.session_id !== sessionId) throw new Error('RESUME_HANDLE_UNAVAILABLE');
        return true;
      }, this.timeoutMs);
    } catch (error) { await this.stop(); throw error; }
    return { resume_handle: { runtime: 'claude-code' as const, session_id: sessionId } };
  }

  private async startCodex(input: { cwd: string; model?: string }, threadId?: string) {
    const spec = buildCodexWorkSessionLaunch({ cwd: input.cwd, model: input.model, threadId });
    this.spawn(spec.command, spec.args, spec.cwd, this.env());
    try {
      await this.rpc('initialize', { clientInfo: { name: 'cortextos-work-session', version: '1' }, capabilities: {} });
      const shared = { cwd: input.cwd, model: input.model, approvalPolicy: 'never', sandbox: 'workspaceWrite', allowProviderModelFallback: false };
      const result = await this.rpc(threadId ? 'thread/resume' : 'thread/start', threadId ? { ...shared, threadId } : shared) as { thread?: { id?: string } };
      const exact = result?.thread?.id;
      if (!exact || (threadId && exact !== threadId)) throw new Error('RESUME_HANDLE_UNAVAILABLE');
      this.currentThreadId = exact;
      return { resume_handle: { runtime: 'codex-app-server' as const, thread_id: exact } };
    } catch (error) { await this.stop(); throw error; }
  }

  private queryOpenCodeSessions(databasePath: string): OpenCodeSessionCandidate[] {
    try {
      const raw = execFileSync('sqlite3', ['-json', databasePath, 'SELECT id, directory AS cwd, time_created AS created_at FROM session'], { encoding: 'utf8', timeout: 2000 });
      const rows = JSON.parse(raw || '[]') as Array<{ id: string; cwd: string; created_at: number }>;
      return rows.map(row => ({ ...row, created_at: row.created_at < 10_000_000_000 ? row.created_at * 1000 : row.created_at }));
    } catch { return []; }
  }

  private async startOpenCode(input: { cwd: string; model?: string }, sessionId?: string) {
    const stateDir = join(this.options.ctxRoot, 'state', 'work-sessions', this.options.record.id, 'opencode');
    const configDir = join(stateDir, 'config');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, 'opencode.json'), `${JSON.stringify(openCodePermissionConfig(), null, 2)}\n`, { mode: 0o600 });
    const dataDir = join(stateDir, 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = join(dataDir, 'opencode', 'opencode.db');
    const before = new Set(this.queryOpenCodeSessions(databasePath).map(row => row.id));
    const start = Date.now();
    const spec = buildOpenCodeWorkSessionLaunch({ cwd: input.cwd, model: input.model, sessionId });
    const env = { ...this.env(), OPENCODE_CONFIG_DIR: configDir, XDG_DATA_HOME: dataDir };
    this.spawn(spec.command, spec.args, spec.cwd, env);
    if (sessionId) return { resume_handle: { runtime: 'opencode' as const, session_id: sessionId } };
    try {
      const exact = await waitFor(() => {
        const rows = this.queryOpenCodeSessions(databasePath).filter(row => !before.has(row.id));
        if (!rows.length) return undefined;
        return selectOpenCodeSession(rows, input.cwd, start, Date.now());
      }, this.timeoutMs, 100);
      return { resume_handle: { runtime: 'opencode' as const, session_id: exact } };
    } catch (error) { await this.stop(); throw error; }
  }
}

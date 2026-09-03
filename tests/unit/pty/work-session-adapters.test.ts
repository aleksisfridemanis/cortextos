import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeWorkSessionLaunch,
  buildCodexWorkSessionLaunch,
  buildOpenCodeWorkSessionLaunch,
  selectOpenCodeSession,
  workSessionChildEnv,
  createWorkSessionAdapter,
  prepareOpenCodeEnvironment,
} from '../../../src/pty/work-session-pty.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Work Session harness contracts', () => {
  it('uses a generated Claude session id for fresh launch and only that id for resume', () => {
    const fresh = buildClaudeWorkSessionLaunch({ cwd: '/project', sessionId: 'uuid-exact', resume: false });
    expect(fresh.args).toEqual(expect.arrayContaining([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--session-id', 'uuid-exact',
      '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
    ]));
    const resumed = buildClaudeWorkSessionLaunch({ cwd: '/project', sessionId: 'uuid-exact', resume: true });
    expect(resumed.args).toEqual(expect.arrayContaining(['--resume', 'uuid-exact']));
    expect(resumed.args).not.toContain('--continue');
  });

  it('uses Codex thread/start and thread/resume without list or latest fallback', () => {
    const fresh = buildCodexWorkSessionLaunch({ cwd: '/project', model: 'gpt-5.6', threadId: undefined });
    expect(fresh.requests.map(request => request.method)).toContain('thread/start');
    const resumed = buildCodexWorkSessionLaunch({ cwd: '/project', model: 'gpt-5.6', threadId: 'thread-exact' });
    expect(resumed.requests).toContainEqual(expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: 'thread-exact', cwd: '/project' }) }));
    expect(resumed.requests.some(request => /list|latest/i.test(request.method))).toBe(false);
  });

  it('selects one OpenCode session by canonical cwd and spawn window, then resumes with --session', () => {
    const selected = selectOpenCodeSession([
      { id: 'old', cwd: '/project', created_at: 50 },
      { id: 'exact', cwd: '/project', created_at: 105 },
      { id: 'other', cwd: '/other', created_at: 105 },
    ], '/project', 100, 110);
    expect(selected).toBe('exact');
    expect(buildOpenCodeWorkSessionLaunch({ cwd: '/project', sessionId: selected }).args).toEqual(['acp', '--cwd', '/project', '--pure']);
  });

  it('passes only the strict tokenless child environment allowlist', () => {
    const env = workSessionChildEnv({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm', LANG: 'en', AUTH_SECRET: 'forbidden', OPENAI_API_KEY: 'forbidden' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm', LANG: 'en' });
  });

  it('isolates OpenCode HOME and copies only the documented auth store', () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-isolation-'));
    try {
      const hostData = join(root, 'host-data');
      mkdirSync(join(hostData, 'opencode'), { recursive: true });
      writeFileSync(join(hostData, 'opencode', 'auth.json'), '{"provider":"secret"}');
      writeFileSync(join(hostData, 'opencode', 'history.json'), '{"private":true}');
      const env = prepareOpenCodeEnvironment({ HOME: join(root, 'personal-home'), XDG_DATA_HOME: hostData }, join(root, 'session'));
      expect(env.HOME).toBe(join(root, 'session', 'home'));
      expect(JSON.parse(readFileSync(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'))).toEqual({ provider: 'secret' });
      expect(existsSync(join(env.XDG_DATA_HOME, 'opencode', 'history.json'))).toBe(false);
      expect(env.XDG_CONFIG_HOME).not.toContain('personal-home');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires an exact native acknowledgement before resume succeeds', async () => {
    const transport = {
      launch: vi.fn(async () => ({ session_id: 'different-session' })),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const adapter = createWorkSessionAdapter('opencode', transport);
    await expect(adapter.resumeExact(
      { runtime: 'opencode', session_id: 'requested-session' },
      { id: 'ws-one', mutation_id: '11111111-1111-4111-8111-111111111111', cwd: '/project' },
    )).rejects.toThrow('RESUME_HANDLE_UNAVAILABLE');
  });
});

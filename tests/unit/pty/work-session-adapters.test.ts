import { describe, expect, it } from 'vitest';
import {
  buildClaudeWorkSessionLaunch,
  buildCodexWorkSessionLaunch,
  buildOpenCodeWorkSessionLaunch,
  selectOpenCodeSession,
  workSessionChildEnv,
} from '../../../src/pty/work-session.js';

describe('Work Session harness contracts', () => {
  it('uses a generated Claude session id for fresh launch and only that id for resume', () => {
    expect(buildClaudeWorkSessionLaunch({ cwd: '/project', sessionId: 'uuid-exact', resume: false }).args)
      .toEqual(expect.arrayContaining(['--session-id', 'uuid-exact']));
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
    expect(buildOpenCodeWorkSessionLaunch({ cwd: '/project', sessionId: selected }).args).toEqual(['--session', 'exact']);
  });

  it('passes only the strict tokenless child environment allowlist', () => {
    const env = workSessionChildEnv({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm', LANG: 'en', AUTH_SECRET: 'forbidden', OPENAI_API_KEY: 'forbidden' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm', LANG: 'en' });
  });
});

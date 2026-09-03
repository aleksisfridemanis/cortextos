import { describe, expect, it } from 'vitest';
import {
  CREW_EMPLOYEE_HARNESSES,
  buildCreateChatRequest,
  createChatRequestKey,
  initialCreateChatState,
  retainedCreateMutationId,
} from '../create-chat-dialog';

describe('CreateChatDialog contract', () => {
  it('defaults Employee creation to Claude Code and the harness default model', () => {
    expect(initialCreateChatState()).toMatchObject({ kind: 'employee', harness: 'claude-code', model: '' });
    expect(CREW_EMPLOYEE_HARNESSES.map(item => item.value)).toEqual([
      'claude-code', 'codex-app-server', 'opencode',
    ]);
  });

  it('builds the audited Employee request without Telegram or actor input', () => {
    const request = buildCreateChatRequest({
      ...initialCreateChatState(), name: 'ada', org: 'platform', workingDirectory: '/workspace',
    }, '18d64d6a-b787-46e4-8bb2-a488909a60d2');
    expect(request).toEqual({
      endpoint: '/api/agents',
      headers: {
        'content-type': 'application/json',
        'x-cortext-intent': 'create-employee',
        'x-cortext-mutation-id': '18d64d6a-b787-46e4-8bb2-a488909a60d2',
      },
      body: {
        name: 'ada', org: 'platform', runtime: 'claude-code', model: undefined,
        working_directory: '/workspace', telegram_polling: false,
      },
    });
    expect(request.body).not.toHaveProperty('actor');
    expect(request.body).not.toHaveProperty('telegram_token');
  });

  it('builds a distinct exact-resume Work Session request', () => {
    const request = buildCreateChatRequest({
      ...initialCreateChatState(), kind: 'work_session', name: 'release', org: 'platform', harness: 'codex-app-server', workingDirectory: '/workspace',
    }, '28d64d6a-b787-46e4-8bb2-a488909a60d2');
    expect(request).toEqual({
      endpoint: '/api/work-sessions',
      headers: { 'content-type': 'application/json', 'x-cortext-intent': 'create-work-session', 'x-cortext-mutation-id': '28d64d6a-b787-46e4-8bb2-a488909a60d2' },
      body: { display_name: 'release', org: 'platform', harness: 'codex-app-server', model: undefined, requested_cwd: '/workspace' },
    });
  });

  it('retains a creation mutation only while the exact request binding is unchanged', () => {
    const state = { ...initialCreateChatState(), name: 'ada', org: 'platform' };
    const key = createChatRequestKey(state);
    const pending = { mutationId: 'original', requestKey: key };
    expect(retainedCreateMutationId(pending, key, () => 'new')).toBe('original');
    expect(retainedCreateMutationId(pending, createChatRequestKey({ ...state, name: 'grace' }), () => 'new')).toBe('new');
  });
});

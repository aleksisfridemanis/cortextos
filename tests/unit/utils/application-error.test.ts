import { describe, expect, it } from 'vitest';
import { closedRuntimeErrorCode } from '../../../src/utils/application-error.js';

describe('closedRuntimeErrorCode', () => {
  it('decodes whitelisted nested harness error data without consulting message text', () => {
    expect(closedRuntimeErrorCode({ code: -32000, message: '/private/auth failed', data: { providerId: 'anthropic', modelId: 'missing' } }, 'opencode', 'session/set_config_option'))
      .toBe('MODEL_UNSUPPORTED');
    expect(closedRuntimeErrorCode({ code: -32001, data: { reason: 'permission_denied' } }, 'opencode', 'session/prompt'))
      .toBe('POLICY_REJECTED');
    expect(closedRuntimeErrorCode({ code: -32002, data: { category: 'sandbox_unavailable' } }, 'codex-app-server', 'thread/start'))
      .toBe('SANDBOX_UNAVAILABLE');
  });

  it('fails closed for numeric and unrecognized structured errors', () => {
    expect(closedRuntimeErrorCode({ code: -32000, message: 'model exploded at /secret' }, 'opencode', 'session/prompt'))
      .toBe('RUNTIME_REQUEST_REJECTED');
  });

  it.each([
    [{ type: 'assistant', error: 'model_not_found' }, 'claude-code', 'MODEL_UNSUPPORTED'],
    [{ type: 'result', subtype: 'error', error: 'authentication_failed' }, 'claude-code', 'RUNTIME_AUTH_UNAVAILABLE'],
    [{ turn: { status: 'failed', error: { code: 'sandbox_unavailable' } } }, 'codex-app-server', 'SANDBOX_UNAVAILABLE'],
    [{ data: { error: { category: 'policy_rejected' } } }, 'opencode', 'POLICY_REJECTED'],
  ] as const)('maps stable real-shape fields to closed codes', (frame, harness, expected) => {
    expect(closedRuntimeErrorCode(frame, harness, 'turn/completed')).toBe(expected);
  });
});

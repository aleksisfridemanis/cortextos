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
});

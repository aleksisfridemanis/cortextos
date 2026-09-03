import { describe, expect, it } from 'vitest';
import { publicApplicationError } from '../application-error';

describe('publicApplicationError', () => {
  it('maps resources, recovery, and runtime failures consistently', () => {
    expect(publicApplicationError('ORG_NOT_FOUND')).toEqual({ code: 'ORG_NOT_FOUND', status: 404 });
    expect(publicApplicationError('CONTEXT_SOURCE_UNAVAILABLE')).toEqual({ code: 'CONTEXT_SOURCE_UNAVAILABLE', status: 503 });
    expect(publicApplicationError('POLICY_REJECTED')).toEqual({ code: 'POLICY_REJECTED', status: 500 });
  });

  it('redacts arbitrary exception text and absolute paths', () => {
    expect(publicApplicationError('CONTEXT_SOURCE_UNAVAILABLE: /private/host/template.md'))
      .toEqual({ code: 'INTERNAL_ERROR', status: 500 });
  });
});

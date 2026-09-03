import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendCrewLifecycleAuditEvent,
  digestCrewAuditValue,
  readCrewLifecycleAuditEvents,
  type CrewLifecycleAuditEvent,
} from '../../../src/audit/crew-lifecycle-audit';

describe('Crew lifecycle audit', () => {
  it('writes one mode-safe, idempotent event and rejects conflicting duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-audit-'));
    try {
      const event: CrewLifecycleAuditEvent = {
        schema_version: 1,
        event_id: '11111111-1111-4111-8111-111111111111',
        actor: 'owner:1',
        target: { kind: 'employee', id: 'sam' },
        action: 'create',
        request_digest: digestCrewAuditValue({ name: 'sam' }),
        before_digest: digestCrewAuditValue(null),
        after_digest: digestCrewAuditValue({ enabled: true }),
        timestamp: '2026-09-03T00:00:00.000Z',
        result: 'success',
        error_code: null,
        sanitized_error: null,
      };

      expect(appendCrewLifecycleAuditEvent(root, event)).toEqual({ appended: true });
      expect(appendCrewLifecycleAuditEvent(root, event)).toEqual({ appended: false });
      expect(readCrewLifecycleAuditEvents(root)).toEqual([event]);
      expect(() => appendCrewLifecycleAuditEvent(root, { ...event, result: 'failure' }))
        .toThrow(/conflicting audit event/i);

      const raw = readFileSync(join(root, 'state', 'crew-lifecycle-audit.jsonl'), 'utf8');
      expect(raw).not.toContain('sentinel-secret-value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects raw sensitive fields and values', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-audit-redact-'));
    try {
      const unsafe = {
        schema_version: 1,
        event_id: '22222222-2222-4222-8222-222222222222',
        actor: 'owner:1',
        target: { kind: 'employee', id: 'sam' },
        action: 'message',
        request_digest: digestCrewAuditValue('request'),
        before_digest: digestCrewAuditValue(null),
        after_digest: digestCrewAuditValue(null),
        timestamp: new Date().toISOString(),
        result: 'failure',
        error_code: 'FAILED',
        sanitized_error: 'sentinel-secret-value',
      } as CrewLifecycleAuditEvent;
      expect(() => appendCrewLifecycleAuditEvent(root, unsafe)).toThrow(/sanitized/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

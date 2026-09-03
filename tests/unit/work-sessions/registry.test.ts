import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkSessionRegistryError,
  createWorkSessionRecord,
  readWorkSessions,
  transitionWorkSession,
} from '../../../src/work-sessions/registry.js';

describe('Work Session registry', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cortext-work-sessions-'));
    roots.push(root);
    const ctxRoot = join(root, 'ctx');
    const cwd = join(root, 'project');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(cwd);
    return { root, ctxRoot, cwd };
  }

  it('stores Work Sessions outside the Employee registry with a canonical cwd lease', () => {
    const { root, ctxRoot, cwd } = fixture();
    const alias = join(root, 'alias');
    symlinkSync(cwd, alias);

    const created = createWorkSessionRecord(ctxRoot, {
      id: 'ws-one', display_name: 'One', org: 'platform', harness: 'codex-app-server', requested_cwd: alias, room_id: 'room-one', mutation_id: '11111111-1111-4111-8111-111111111111', created_by: 'owner:test',
    });
    const canonical = realpathSync(cwd);
    expect(created).toMatchObject({ kind: 'work_session', lifecycle: 'starting', requested_cwd: alias, canonical_cwd: canonical });
    expect(readWorkSessions(ctxRoot)).toEqual([created]);

    expect(() => createWorkSessionRecord(ctxRoot, {
      id: 'ws-two', display_name: 'Two', org: 'platform', harness: 'claude-code', requested_cwd: cwd, room_id: 'room-two', mutation_id: '22222222-2222-4222-8222-222222222222', created_by: 'owner:test',
    })).toThrowError(expect.objectContaining({ code: 'CWD_LEASE_CONFLICT' }));
  });

  it('permits only declared lifecycle transitions and preserves the exact resume handle', () => {
    const { ctxRoot, cwd } = fixture();
    createWorkSessionRecord(ctxRoot, {
      id: 'ws-one', display_name: 'One', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, room_id: 'room-one', mutation_id: '11111111-1111-4111-8111-111111111111', created_by: 'owner:test',
    });
    const active = transitionWorkSession(ctxRoot, 'ws-one', ['starting'], 'active', {
      resume_handle: { runtime: 'codex-app-server', thread_id: 'thread-exact' },
    }, '33333333-3333-4333-8333-333333333333');
    expect(active.resume_handle).toEqual({ runtime: 'codex-app-server', thread_id: 'thread-exact' });
    expect(() => transitionWorkSession(ctxRoot, 'ws-one', ['archived'], 'active', {}, 'bad'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    expect(() => transitionWorkSession(ctxRoot, 'ws-one', ['active'], 'active', {
      resume_handle: { runtime: 'opencode', session_id: 'wrong-harness' },
    }, '44444444-4444-4444-8444-444444444444')).toThrowError(expect.objectContaining({ code: 'REGISTRY_CORRUPT' }));
  });

  it('returns the same record for the same mutation and rejects conflicting reuse', () => {
    const { ctxRoot, cwd } = fixture();
    const input = {
      id: 'ws-one', display_name: 'One', org: 'platform', harness: 'codex-app-server' as const,
      requested_cwd: cwd, room_id: 'room-one', mutation_id: '11111111-1111-4111-8111-111111111111', created_by: 'owner:test',
    };
    const created = createWorkSessionRecord(ctxRoot, input);
    expect(createWorkSessionRecord(ctxRoot, input)).toEqual(created);
    expect(() => createWorkSessionRecord(ctxRoot, { ...input, display_name: 'Different' }))
      .toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('fails closed when the registry is corrupt', () => {
    const { ctxRoot } = fixture();
    writeFileSync(join(ctxRoot, 'config', 'work-sessions.json'), '{');
    expect(() => readWorkSessions(ctxRoot)).toThrow(WorkSessionRegistryError);
  });
});

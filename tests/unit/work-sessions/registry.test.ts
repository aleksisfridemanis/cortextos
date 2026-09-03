import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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
      id: 'ws-one', name: 'One', harness: 'codex', cwd: alias, room_id: 'room-one', mutation_id: 'mutation-one',
    });
    expect(created).toMatchObject({ lifecycle: 'starting', cwd, canonical_cwd: cwd });
    expect(readWorkSessions(ctxRoot)).toEqual([created]);

    expect(() => createWorkSessionRecord(ctxRoot, {
      id: 'ws-two', name: 'Two', harness: 'claude-code', cwd, room_id: 'room-two', mutation_id: 'mutation-two',
    })).toThrowError(expect.objectContaining({ code: 'CWD_LEASE_CONFLICT' }));
  });

  it('permits only declared lifecycle transitions and preserves the exact resume handle', () => {
    const { ctxRoot, cwd } = fixture();
    createWorkSessionRecord(ctxRoot, {
      id: 'ws-one', name: 'One', harness: 'codex', cwd, room_id: 'room-one', mutation_id: 'mutation-one',
    });
    const active = transitionWorkSession(ctxRoot, 'ws-one', ['starting'], 'active', {
      resume_handle: { harness: 'codex', thread_id: 'thread-exact' },
    }, 'mutation-active');
    expect(active.resume_handle).toEqual({ harness: 'codex', thread_id: 'thread-exact' });
    expect(() => transitionWorkSession(ctxRoot, 'ws-one', ['archived'], 'active', {}, 'bad'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });

  it('fails closed when the registry is corrupt', () => {
    const { ctxRoot } = fixture();
    writeFileSync(join(ctxRoot, 'config', 'work-sessions.json'), '{');
    expect(() => readWorkSessions(ctxRoot)).toThrow(WorkSessionRegistryError);
  });
});

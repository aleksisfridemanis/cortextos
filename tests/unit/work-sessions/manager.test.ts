import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkSessionManager } from '../../../src/work-sessions/manager.js';
import type { WorkSessionRuntimeAdapter } from '../../../src/work-sessions/types.js';

describe('WorkSessionManager', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'cortext-work-manager-'));
    roots.push(root);
    const ctxRoot = join(root, 'ctx');
    const cwd = join(root, 'project');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(cwd);
    const adapter: WorkSessionRuntimeAdapter = {
      startFresh: vi.fn(async () => ({ resume_handle: { harness: 'codex', thread_id: 'thread-exact' } })),
      resumeExact: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const createEmployee = vi.fn(async () => ({ status: 'created' as const }));
    const manager = new WorkSessionManager({ ctxRoot, adapterFactory: () => adapter, createEmployee });
    return { manager, adapter, createEmployee, cwd };
  }

  it('starts, messages, stops, and resumes only the persisted exact handle', async () => {
    const { manager, adapter, cwd } = fixture();
    const created = await manager.create({ name: 'Fix release', harness: 'codex', cwd, actor: 'owner:test' }, 'mutation-create');
    expect(created.lifecycle).toBe('active');
    await manager.send(created.id, 'continue', 'owner:test', 'mutation-send');
    await manager.stop(created.id, 'owner:test', 'mutation-stop');
    const resumed = await manager.resume(created.id, 'owner:test', 'mutation-resume');
    expect(resumed.lifecycle).toBe('active');
    expect(adapter.resumeExact).toHaveBeenCalledWith(
      { harness: 'codex', thread_id: 'thread-exact' },
      expect.objectContaining({ cwd }),
    );
  });

  it('archives before promotion and creates an Employee in the same room and cwd', async () => {
    const { manager, createEmployee, cwd } = fixture();
    const created = await manager.create({ name: 'Promote me', harness: 'codex', cwd, actor: 'owner:test' }, 'mutation-create');
    await manager.promote(created.id, {
      name: 'release-engineer', org: 'platform', runtime: 'codex', actor: 'owner:test',
    }, 'mutation-promote');
    expect(manager.get(created.id)?.lifecycle).toBe('archived');
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ cwd, room_id: created.room_id }), 'mutation-promote');
  });
});

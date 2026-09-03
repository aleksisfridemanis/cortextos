import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
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
      startFresh: vi.fn(async () => ({ resume_handle: { runtime: 'codex-app-server', thread_id: 'thread-exact' } })),
      resumeExact: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      status: vi.fn(() => ({ running: true, pid: 1, error_code: null })),
      getResumeHandle: vi.fn(() => null),
    };
    const createEmployee = vi.fn(async () => ({ status: 'created' as const }));
    const manager = new WorkSessionManager({ ctxRoot, adapterFactory: () => adapter, createEmployee });
    return { manager, adapter, createEmployee, cwd };
  }

  it('starts, messages, stops, and resumes only the persisted exact handle', async () => {
    const { manager, adapter, cwd } = fixture();
    const created = await manager.create({ display_name: 'Fix release', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '11111111-1111-4111-8111-111111111111');
    expect(created.lifecycle).toBe('active');
    await manager.send(created.id, 'continue', 'owner:test', '22222222-2222-4222-8222-222222222222');
    await manager.send(created.id, 'continue', 'owner:test', '22222222-2222-4222-8222-222222222222');
    const stopped = await manager.stop(created.id, 'owner:test', '33333333-3333-4333-8333-333333333333');
    expect(await manager.stop(created.id, 'owner:test', '33333333-3333-4333-8333-333333333333')).toEqual(stopped);
    const resumed = await manager.resume(created.id, 'owner:test', '44444444-4444-4444-8444-444444444444');
    expect(await manager.resume(created.id, 'owner:test', '44444444-4444-4444-8444-444444444444')).toEqual(resumed);
    expect(resumed.lifecycle).toBe('active');
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.resumeExact).toHaveBeenCalledTimes(1);
    expect(adapter.resumeExact).toHaveBeenCalledWith(
      { runtime: 'codex-app-server', thread_id: 'thread-exact' },
      expect.objectContaining({ cwd: realpathSync(cwd) }),
    );
  });

  it('rejects reuse of a mutation id for different input', async () => {
    const { manager, cwd } = fixture();
    const created = await manager.create({ display_name: 'Fix release', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '11111111-1111-4111-8111-111111111111');
    await manager.send(created.id, 'first', 'owner:test', '22222222-2222-4222-8222-222222222222');
    await expect(manager.send(created.id, 'different', 'owner:test', '22222222-2222-4222-8222-222222222222')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('archives before promotion and creates an Employee in the same room and cwd', async () => {
    const { manager, createEmployee, cwd } = fixture();
    const created = await manager.create({ display_name: 'Promote me', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '11111111-1111-4111-8111-111111111111');
    await manager.promote(created.id, {
      name: 'release-engineer', org: 'platform', runtime: 'codex', actor: 'owner:test',
    }, '55555555-5555-4555-8555-555555555555');
    expect(manager.get(created.id)?.lifecycle).toBe('archived');
    expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ working_directory: realpathSync(cwd), room_id: created.room_id }), expect.stringMatching(/^[0-9a-f-]{36}$/));
  });
});

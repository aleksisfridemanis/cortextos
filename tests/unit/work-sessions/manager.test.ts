import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkSessionManager } from '../../../src/work-sessions/manager.js';
import type { WorkSessionRuntimeAdapter } from '../../../src/work-sessions/types.js';
import {
  commitCrewMutationState, getCrewMutation, prepareCrewMutation, startCrewMutationEffect,
} from '../../../src/audit/crew-mutation-journal.js';
import { digestCrewAuditValue } from '../../../src/audit/crew-lifecycle-audit.js';
import { createWorkSessionRecord, transitionWorkSession } from '../../../src/work-sessions/registry.js';
import { upsertRoom } from '../../../src/rooms/registry.js';

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
    return { manager, adapter, createEmployee, cwd, ctxRoot };
  }

  function digest(record: Record<string, unknown>): string {
    return digestCrewAuditValue({ ...record, resume_handle: record.resume_handle ? digestCrewAuditValue(record.resume_handle) : null });
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

  it('returns each mutation original terminal result after later lifecycle changes', async () => {
    const { manager, adapter, cwd } = fixture();
    const created = await manager.create({ display_name: 'Fix release', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '91111111-1111-4111-8111-111111111111');
    const stopMutation = '93333333-3333-4333-8333-333333333333';
    const resumeMutation = '94444444-4444-4444-8444-444444444444';
    const laterStopMutation = '95555555-5555-4555-8555-555555555555';
    const stopped = await manager.stop(created.id, 'owner:test', stopMutation);
    const retriedCreate = await manager.create({ display_name: 'Fix release', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '91111111-1111-4111-8111-111111111111');
    expect(retriedCreate).toEqual(created);
    expect(retriedCreate.lifecycle).toBe('active');
    expect(manager.get(created.id)?.lifecycle).toBe('archived');
    const resumed = await manager.resume(created.id, 'owner:test', resumeMutation);
    const retriedStop = await manager.stop(created.id, 'owner:test', stopMutation);
    expect(retriedStop).toEqual(stopped);
    expect(retriedStop.lifecycle).toBe('archived');
    expect(manager.get(created.id)?.lifecycle).toBe('active');
    await manager.stop(created.id, 'owner:test', laterStopMutation);
    const retriedResume = await manager.resume(created.id, 'owner:test', resumeMutation);
    expect(retriedResume).toEqual(resumed);
    expect(retriedResume.lifecycle).toBe('active');
    expect(manager.get(created.id)?.lifecycle).toBe('archived');
    expect(adapter.resumeExact).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(2);
  });

  it('rejects reuse of a mutation id for different input', async () => {
    const { manager, cwd } = fixture();
    const created = await manager.create({ display_name: 'Fix release', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '11111111-1111-4111-8111-111111111111');
    await manager.send(created.id, 'first', 'owner:test', '22222222-2222-4222-8222-222222222222');
    await expect(manager.send(created.id, 'different', 'owner:test', '22222222-2222-4222-8222-222222222222')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects a new mutation while the same Work Session has unresolved ownership', async () => {
    const { manager, adapter, cwd } = fixture();
    const created = await manager.create({ display_name: 'Pending', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'd1111111-1111-4111-8111-111111111111');
    const pending = 'd2222222-2222-4222-8222-222222222222';
    prepareCrewMutation(roots.at(-1)! + '/ctx', {
      mutation_id: pending, idempotency_key: pending, actor: 'owner:test', target: { kind: 'work_session', id: created.id }, action: 'message',
      request_digest: digestCrewAuditValue({ text_digest: digestCrewAuditValue('pending') }),
      before_digest: '1'.repeat(64), intended_after_digest: '2'.repeat(64),
    });

    await expect(manager.stop(created.id, 'owner:test', 'd3333333-3333-4333-8333-333333333333'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('retains the cwd lease when startup cleanup cannot confirm process death', async () => {
    const { manager, adapter, cwd } = fixture();
    vi.mocked(adapter.startFresh).mockRejectedValueOnce(new Error('context injection failed'));
    vi.mocked(adapter.status).mockReturnValue({ running: true, pid: 99, error_code: null });
    await expect(manager.create({ display_name: 'Unsafe start', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'a1111111-1111-4111-8111-111111111111'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(manager.list()[0]).toMatchObject({ lifecycle: 'starting', last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' });
    await expect(manager.create({ display_name: 'Unsafe start', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'a1111111-1111-4111-8111-111111111111'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(adapter.startFresh).toHaveBeenCalledTimes(1);
    await expect(manager.create({ display_name: 'Second', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'a2222222-2222-4222-8222-222222222222'))
      .rejects.toMatchObject({ code: 'CWD_LEASE_CONFLICT' });
  });

  it('retains the cwd lease when stop cannot confirm process death', async () => {
    const { manager, adapter, cwd } = fixture();
    const created = await manager.create({ display_name: 'Unsafe stop', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'b1111111-1111-4111-8111-111111111111');
    vi.mocked(adapter.stop).mockRejectedValueOnce(new Error('death unconfirmed'));
    vi.mocked(adapter.status).mockReturnValue({ running: true, pid: 99, error_code: null });
    await expect(manager.stop(created.id, 'owner:test', 'b2222222-2222-4222-8222-222222222222'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(manager.get(created.id)).toMatchObject({ lifecycle: 'stopping', last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' });
  });

  it('retains the cwd lease when failed resume cleanup cannot confirm process death', async () => {
    const { manager, adapter, cwd } = fixture();
    const created = await manager.create({ display_name: 'Unsafe resume', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'c1111111-1111-4111-8111-111111111111');
    await manager.stop(created.id, 'owner:test', 'c2222222-2222-4222-8222-222222222222');
    vi.mocked(adapter.resumeExact).mockRejectedValueOnce(new Error('resume acknowledgement lost'));
    vi.mocked(adapter.stop).mockRejectedValueOnce(new Error('death unconfirmed'));
    vi.mocked(adapter.status).mockReturnValue({ running: true, pid: 99, error_code: null });

    await expect(manager.resume(created.id, 'owner:test', 'c3333333-3333-4333-8333-333333333333'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(manager.get(created.id)).toMatchObject({ lifecycle: 'starting', last_error: 'RUNTIME_OWNERSHIP_UNCONFIRMED' });
    await expect(manager.resume(created.id, 'owner:test', 'c3333333-3333-4333-8333-333333333333'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(adapter.resumeExact).toHaveBeenCalledTimes(1);
    await expect(manager.create({ display_name: 'Blocked', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'c4444444-4444-4444-8444-444444444444'))
      .rejects.toMatchObject({ code: 'CWD_LEASE_CONFLICT' });
  });

  it('compensates a record when room publication fails so the cwd lease is released', async () => {
    const { cwd } = fixture();
    const root = roots.at(-1)!;
    const ctxRoot = join(root, 'ctx');
    const adapter: WorkSessionRuntimeAdapter = {
      startFresh: vi.fn(async () => ({ resume_handle: { runtime: 'codex-app-server', thread_id: 'thread-exact' } })),
      resumeExact: vi.fn(async () => undefined), send: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
      status: vi.fn(() => ({ running: true, pid: 1, error_code: null })), getResumeHandle: vi.fn(() => null),
    };
    const failing = new WorkSessionManager({ ctxRoot, adapterFactory: () => adapter, failAt: 'after-session-record' });
    await expect(failing.create({ display_name: 'First', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '61111111-1111-4111-8111-111111111111')).rejects.toThrow();
    expect(failing.list()).toEqual([]);
    const succeeding = new WorkSessionManager({ ctxRoot, adapterFactory: () => adapter });
    await expect(succeeding.create({ display_name: 'Second', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '71111111-1111-4111-8111-111111111111')).resolves.toMatchObject({ lifecycle: 'active' });
  });

  it('fails closed on a corrupt room registry without overwriting it or retaining a cwd lease', async () => {
    const { manager, cwd } = fixture();
    const ctxRoot = join(roots.at(-1)!, 'ctx');
    const roomsPath = join(ctxRoot, 'config', 'rooms.json');
    writeFileSync(roomsPath, '{corrupt');
    await expect(manager.create({ display_name: 'Fix release', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, '81111111-1111-4111-8111-111111111111'))
      .rejects.toMatchObject({ code: 'REGISTRY_CORRUPT' });
    expect(readFileSync(roomsPath, 'utf8')).toBe('{corrupt');
    expect(manager.list()).toEqual([]);
  });

  it('recovers a create interrupted after its effect-start write', async () => {
    const { manager, adapter, cwd, ctxRoot } = fixture();
    vi.mocked(adapter.status).mockReturnValue({ running: false, pid: null, error_code: null });
    const mutationId = 'e1111111-1111-4111-8111-111111111111';
    const id = `ws-${mutationId}`;
    const input = { display_name: 'Recover create', org: 'platform', harness: 'codex-app-server' as const, requested_cwd: cwd, actor: 'owner:test' };
    const record = createWorkSessionRecord(ctxRoot, {
      id, display_name: input.display_name, org: input.org, harness: input.harness, requested_cwd: cwd,
      room_id: `work-${mutationId}`, mutation_id: mutationId, created_by: input.actor,
    });
    upsertRoom(ctxRoot, { id: record.room_id, kind: 'work_session', title: record.display_name, members: [], work_session_id: id, created_at: record.created_at, created_by: input.actor, mutation_id: mutationId });
    prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: input.actor, target: { kind: 'work_session', id }, action: 'create',
      request_digest: digestCrewAuditValue({ ...input, actor: undefined }), before_digest: digestCrewAuditValue(null), intended_after_digest: '1'.repeat(64),
    });
    commitCrewMutationState(ctxRoot, mutationId, digest(record));
    startCrewMutationEffect(ctxRoot, mutationId);

    await expect(manager.create(input, mutationId)).resolves.toMatchObject({ lifecycle: 'active' });
    expect(adapter.startFresh).toHaveBeenCalledTimes(1);
    expect(getCrewMutation(ctxRoot, mutationId)?.stage).toBe('finalized');
  });

  it('makes an interrupted message indeterminate without replaying delivery', async () => {
    const { manager, adapter, cwd, ctxRoot } = fixture();
    const created = await manager.create({ display_name: 'Message', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'e2111111-1111-4111-8111-111111111111');
    const mutationId = 'e2222222-2222-4222-8222-222222222222';
    const request = { text_digest: digestCrewAuditValue('uncertain') };
    prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: 'owner:test', target: { kind: 'work_session', id: created.id }, action: 'message',
      request_digest: digestCrewAuditValue(request), before_digest: digest(created), intended_after_digest: '1'.repeat(64),
    });
    commitCrewMutationState(ctxRoot, mutationId, digest(created));
    startCrewMutationEffect(ctxRoot, mutationId);

    await expect(manager.send(created.id, 'uncertain', 'owner:test', mutationId)).rejects.toMatchObject({ code: 'DELIVERY_RETRY_REQUIRED' });
    expect(adapter.send).not.toHaveBeenCalled();
    expect(getCrewMutation(ctxRoot, mutationId)).toMatchObject({ stage: 'finalized', final_result: { result: 'indeterminate' } });
  });

  it('recovers stop and resume mutations interrupted after effect-start', async () => {
    const { manager, adapter, cwd, ctxRoot } = fixture();
    const created = await manager.create({ display_name: 'Lifecycle', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'e3111111-1111-4111-8111-111111111111');
    const stopId = 'e3222222-2222-4222-8222-222222222222';
    prepareCrewMutation(ctxRoot, {
      mutation_id: stopId, idempotency_key: stopId, actor: 'owner:test', target: { kind: 'work_session', id: created.id }, action: 'stop',
      request_digest: digestCrewAuditValue({ id: created.id }), before_digest: digest(created), intended_after_digest: '1'.repeat(64),
    });
    const stopping = transitionWorkSession(ctxRoot, created.id, ['active'], 'stopping', {}, stopId);
    commitCrewMutationState(ctxRoot, stopId, digest(stopping));
    startCrewMutationEffect(ctxRoot, stopId);
    vi.mocked(adapter.status).mockReturnValue({ running: false, pid: null, error_code: null });
    const stopped = await manager.stop(created.id, 'owner:test', stopId);
    expect(stopped.lifecycle).toBe('archived');

    const resumeId = 'e3333333-3333-4333-8333-333333333333';
    const request = { id: created.id, handle_digest: digestCrewAuditValue(stopped.resume_handle) };
    prepareCrewMutation(ctxRoot, {
      mutation_id: resumeId, idempotency_key: resumeId, actor: 'owner:test', target: { kind: 'work_session', id: created.id }, action: 'resume',
      request_digest: digestCrewAuditValue(request), before_digest: digest(stopped), intended_after_digest: '2'.repeat(64),
    });
    const starting = transitionWorkSession(ctxRoot, created.id, ['archived'], 'starting', {}, resumeId);
    commitCrewMutationState(ctxRoot, resumeId, digest(starting));
    startCrewMutationEffect(ctxRoot, resumeId);
    const resumed = await manager.resume(created.id, 'owner:test', resumeId);
    expect(resumed.lifecycle).toBe('active');
    expect(adapter.resumeExact).toHaveBeenCalledTimes(1);
    expect(getCrewMutation(ctxRoot, resumeId)?.stage).toBe('finalized');
  });

  it('recovers promotion with the deterministic child Employee mutation', async () => {
    const { manager, adapter, createEmployee, cwd, ctxRoot } = fixture();
    const created = await manager.create({ display_name: 'Promote', org: 'platform', harness: 'codex-app-server', requested_cwd: cwd, actor: 'owner:test' }, 'e4111111-1111-4111-8111-111111111111');
    const mutationId = 'e4222222-2222-4222-8222-222222222222';
    const employee = { name: 'operator', org: 'platform', runtime: 'claude-code' as const, actor: 'owner:test' };
    prepareCrewMutation(ctxRoot, {
      mutation_id: mutationId, idempotency_key: mutationId, actor: employee.actor, target: { kind: 'work_session', id: created.id }, action: 'promote',
      request_digest: digestCrewAuditValue({ id: created.id, employee: { ...employee, actor: undefined } }),
      before_digest: digest(created), intended_after_digest: '1'.repeat(64),
    });
    const stopping = transitionWorkSession(ctxRoot, created.id, ['active'], 'stopping', {}, mutationId);
    commitCrewMutationState(ctxRoot, mutationId, digest(stopping));
    startCrewMutationEffect(ctxRoot, mutationId);
    vi.mocked(adapter.status).mockReturnValue({ running: false, pid: null, error_code: null });

    await manager.promote(created.id, employee, mutationId);
    expect(manager.get(created.id)).toMatchObject({ lifecycle: 'archived', promoted_employee: 'operator' });
    expect(createEmployee).toHaveBeenCalledTimes(1);
    expect(createEmployee.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCrewMutation(ctxRoot, mutationId)?.stage).toBe('finalized');
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

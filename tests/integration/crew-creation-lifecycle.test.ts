import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmployee, createPromotedEmployee } from '../../src/agents/create-employee.js';
import { readCrewLifecycleAuditEvents } from '../../src/audit/crew-lifecycle-audit.js';
import {
  commitCrewMutationState, getCrewMutation, prepareCrewMutation, readCrewMutationJournal,
  reconcileCrewMutationJournal, startCrewMutationEffect,
} from '../../src/audit/crew-mutation-journal.js';
import { WorkSessionManager } from '../../src/work-sessions/manager.js';
import { transitionWorkSession } from '../../src/work-sessions/registry.js';
import { promotionEmployeeMutationId } from '../../src/work-sessions/promotion.js';
import { digestCrewAuditValue } from '../../src/audit/crew-lifecycle-audit.js';

describe('Crew Employee creation lifecycle', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  it('binds one mutation through state, daemon receipt, and final audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-crew-lifecycle-'));
    roots.push(root);
    const ctxRoot = join(root, 'ctx');
    const frameworkRoot = join(root, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'platform', 'agents'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'templates', 'agent'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'templates', 'context'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'templates', 'agent', 'config.json'), '{}');
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'work-session.md'), 'Work safely.');
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}');
    writeFileSync(join(ctxRoot, 'config', 'rooms.json'), '[]');
    const mutationId = '1f1438f9-e0b4-43fb-88e0-44b4140393bd';

    const result = await createEmployee({
      name: 'ada', org: 'platform', runtime: 'claude-code', telegram_polling: false, actor: 'owner:test',
    }, mutationId, {
      ctxRoot,
      frameworkRoot,
      instanceId: 'test',
      now: () => '2026-09-03T00:00:00.000Z',
      startEmployee: async request => ({ mutation_id: request.mutation_id, started: true }),
    });

    expect(result.status).toBe('created');
    const registry = JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'));
    expect(registry.ada.mutation_id).toBe(mutationId);
    expect(readCrewMutationJournal(ctxRoot)[0]).toMatchObject({ mutation_id: mutationId, stage: 'finalized' });
    expect(readCrewLifecycleAuditEvents(ctxRoot)).toEqual([
      expect.objectContaining({ event_id: mutationId, action: 'create', result: 'success' }),
    ]);
  });
});

describe('Crew Work Session lifecycle', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  it('uses one mutation identity through Work Session state, effect, and audit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-work-lifecycle-'));
    roots.push(root);
    const ctxRoot = join(root, 'ctx');
    const cwd = join(root, 'project');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(cwd);
    const manager = new WorkSessionManager({
      ctxRoot,
      adapterFactory: () => ({
        startFresh: async () => ({ resume_handle: { runtime: 'claude-code', session_id: '66666666-6666-4666-8666-666666666666' } }),
        resumeExact: async () => undefined,
        send: async () => undefined,
        stop: async () => undefined,
        status: () => ({ running: true, pid: 1, error_code: null }),
        getResumeHandle: () => null,
      }),
    });
    const mutationId = '7f51a223-4111-46fb-b4f2-27870567d55d';

    const result = await manager.create({ display_name: 'Investigate', org: 'platform', harness: 'claude-code', requested_cwd: cwd, actor: 'owner:test' }, mutationId);

    expect(result).toMatchObject({ lifecycle: 'active', mutation_id: mutationId });
    expect(readCrewMutationJournal(ctxRoot).find(row => row.mutation_id === mutationId)).toMatchObject({ stage: 'finalized' });
    expect(readCrewLifecycleAuditEvents(ctxRoot).find(row => row.event_id === mutationId)).toMatchObject({ action: 'create', target: { kind: 'work_session' }, result: 'success' });
  });

  it('promotes through the real Employee service by transferring the durable room in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-work-promotion-'));
    roots.push(root);
    const ctxRoot = join(root, 'ctx');
    const cwd = join(root, 'project');
    const frameworkRoot = join(root, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(cwd);
    mkdirSync(join(frameworkRoot, 'orgs', 'platform', 'agents'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'templates', 'agent'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'templates', 'context'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'templates', 'agent', 'config.json'), '{}');
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'work-session.md'), 'Work safely.');
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}');
    writeFileSync(join(ctxRoot, 'config', 'rooms.json'), '[]');
    const adapter = {
      startFresh: async () => ({ resume_handle: { runtime: 'claude-code' as const, session_id: '66666666-6666-4666-8666-666666666666' } }),
      resumeExact: async () => undefined,
      send: async () => undefined,
      stop: async () => undefined,
      status: () => ({ running: true, pid: 1, error_code: null }),
      getResumeHandle: () => null,
    };
    const manager = new WorkSessionManager({ ctxRoot, frameworkRoot, adapterFactory: () => adapter });
    const created = await manager.create({
      display_name: 'Promote real', org: 'platform', harness: 'claude-code', requested_cwd: cwd, actor: 'owner:test',
    }, '8f51a223-4111-46fb-b4f2-27870567d55d');
    await expect(createEmployee({
      name: 'forged', org: 'platform', runtime: 'claude-code', telegram_polling: false, actor: 'owner:test',
      working_directory: created.canonical_cwd, room_id: created.room_id, source_work_session_id: created.id,
    } as never, '7f51a223-4111-46fb-b4f2-27870567d55d', { ctxRoot, frameworkRoot }))
      .rejects.toMatchObject({ code: 'FORGED_SERVER_FIELD' });
    expect(manager.get(created.id)?.lifecycle).toBe('active');
    expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'rooms.json'), 'utf8'))[0]).toMatchObject({ kind: 'work_session' });
    mkdirSync(join(ctxRoot, 'rooms', created.room_id), { recursive: true });
    const logPath = join(ctxRoot, 'rooms', created.room_id, 'log.jsonl');
    writeFileSync(logPath, '{"id":"history"}\n');

    await manager.promote(created.id, {
      name: 'release-engineer', org: 'platform', runtime: 'claude-code', actor: 'owner:test',
    }, '9f51a223-4111-46fb-b4f2-27870567d55d');

    const employee = JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'))['release-engineer'];
    const room = JSON.parse(readFileSync(join(ctxRoot, 'config', 'rooms.json'), 'utf8'))[0];
    expect(employee).toMatchObject({ room_id: created.room_id, working_directory: realpathSync(cwd) });
    expect(manager.get(created.id)).toMatchObject({ lifecycle: 'archived', promoted_employee: 'release-engineer' });
    expect(room).toMatchObject({ id: created.room_id, kind: 'agent', agent: 'release-engineer', work_session_id: created.id });
    expect(readFileSync(logPath, 'utf8')).toBe('{"id":"history"}\n');
  });

  it('terminates a parent promotion after restart rolls back its crashed real-service child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortext-promotion-crash-'));
    roots.push(root);
    const ctxRoot = join(root, 'ctx');
    const cwd = join(root, 'project');
    const frameworkRoot = join(root, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(cwd);
    mkdirSync(join(frameworkRoot, 'orgs', 'platform', 'agents'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'templates', 'agent'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'templates', 'context'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'templates', 'agent', 'config.json'), '{}');
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'work-session.md'), 'Work safely.');
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}');
    writeFileSync(join(ctxRoot, 'config', 'rooms.json'), '[]');
    const adapter = {
      startFresh: async () => ({ resume_handle: { runtime: 'claude-code' as const, session_id: '76666666-6666-4666-8666-666666666666' } }),
      resumeExact: async () => undefined, send: async () => undefined, stop: async () => undefined,
      status: () => ({ running: false, pid: null, error_code: null }), getResumeHandle: () => null,
    };
    const manager = new WorkSessionManager({ ctxRoot, frameworkRoot, adapterFactory: () => adapter });
    const created = await manager.create({ display_name: 'Crash child', org: 'platform', harness: 'claude-code', requested_cwd: cwd, actor: 'owner:test' }, 'a051a223-4111-46fb-b4f2-27870567d55d');
    const parentId = 'a151a223-4111-46fb-b4f2-27870567d55d';
    prepareCrewMutation(ctxRoot, {
      mutation_id: parentId, idempotency_key: parentId, actor: 'owner:test', target: { kind: 'work_session', id: created.id }, action: 'promote',
      request_digest: '1'.repeat(64), before_digest: '2'.repeat(64), intended_after_digest: '3'.repeat(64),
    });
    let parent = transitionWorkSession(ctxRoot, created.id, ['active'], 'stopping', {}, parentId);
    commitCrewMutationState(ctxRoot, parentId, digestCrewAuditValue({ ...parent, resume_handle: digestCrewAuditValue(parent.resume_handle) }));
    startCrewMutationEffect(ctxRoot, parentId);
    parent = transitionWorkSession(ctxRoot, created.id, ['stopping'], 'archived', {}, parentId);
    const childId = promotionEmployeeMutationId(parentId);
    await expect(createPromotedEmployee({
      name: 'crash-child', org: 'platform', runtime: 'claude-code', actor: 'owner:test', telegram_polling: false,
      working_directory: parent.canonical_cwd, room_id: parent.room_id,
    }, childId, { sourceWorkSessionId: parent.id, parentMutationId: parentId }, {
      ctxRoot, frameworkRoot, failAt: 'after-publication', startEmployee: async request => ({ mutation_id: request.mutation_id, started: true }),
    })).rejects.toMatchObject({ code: 'MUTATION_PENDING' });

    reconcileCrewMutationJournal(ctxRoot, { frameworkRoot });
    expect(getCrewMutation(ctxRoot, childId)?.final_result).toMatchObject({ result: 'failure', error_code: 'INTERRUPTED_PUBLICATION' });
    await manager.reconcilePending();
    expect(getCrewMutation(ctxRoot, parentId)?.final_result).toMatchObject({ result: 'failure', error_code: 'PROMOTION_FAILED' });
    expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'))).toEqual({});
    expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'rooms.json'), 'utf8'))[0]).toMatchObject({ kind: 'work_session', work_session_id: parent.id });
    expect(readCrewMutationJournal(ctxRoot).filter(entry => entry.stage !== 'finalized')).toEqual([]);
  });
});

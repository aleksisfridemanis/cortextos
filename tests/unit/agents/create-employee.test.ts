import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREW_BODY_MAX_BYTES,
  CREW_NAME_MAX_CHARS,
  CrewServiceError,
  createEmployee,
  type CreateEmployeeDependencies,
} from '../../../src/agents/create-employee.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

describe('createEmployee', () => {
  let root: string;
  let frameworkRoot: string;
  let ctxRoot: string;
  let started: string[];
  let dependencies: CreateEmployeeDependencies;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortext-employee-'));
    frameworkRoot = join(root, 'framework');
    ctxRoot = join(root, 'ctx');
    mkdirSync(join(frameworkRoot, 'templates', 'agent'), { recursive: true });
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'platform', 'agents'), { recursive: true });
    writeJson(join(frameworkRoot, 'templates', 'agent', 'config.json'), { telegram_polling: true });
    writeFileSync(join(frameworkRoot, 'templates', 'agent', 'IDENTITY.md'), 'template identity\n');
    writeJson(join(ctxRoot, 'config', 'enabled-agents.json'), {});
    writeJson(join(ctxRoot, 'config', 'rooms.json'), []);
    started = [];
    dependencies = {
      ctxRoot,
      frameworkRoot,
      instanceId: 'test',
      now: () => '2026-09-03T00:00:00.000Z',
      startEmployee: async receipt => {
        const registry = JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'));
        expect(registry[receipt.name]?.mutation_id).toBe(receipt.mutation_id);
        started.push(receipt.mutation_id);
        return { mutation_id: receipt.mutation_id, started: true };
      },
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('validates before writes, publishes atomically, creates one stable room, and starts last', async () => {
    const mutationId = 'f85b93db-3fef-46d7-bf60-fc136d56515f';
    const result = await createEmployee({
      name: 'a'.repeat(CREW_NAME_MAX_CHARS),
      org: 'platform',
      runtime: 'claude-code',
      telegram_polling: false,
      actor: 'owner:test',
    }, mutationId, dependencies);

    expect(result.status).toBe('created');
    expect(result.employee.room_id).toBe(`agent-${'a'.repeat(CREW_NAME_MAX_CHARS)}`);
    expect(started).toEqual([mutationId]);
    const config = JSON.parse(readFileSync(join(frameworkRoot, 'orgs', 'platform', 'agents', 'a'.repeat(64), 'config.json'), 'utf8'));
    expect(config.telegram_polling).toBe(false);
    expect(config.mutation_id).toBe(mutationId);
    const rooms = JSON.parse(readFileSync(join(ctxRoot, 'config', 'rooms.json'), 'utf8'));
    expect(rooms).toHaveLength(1);
  });

  it('returns the stored result for an identical retry and rejects a conflicting reuse', async () => {
    const mutationId = '7cc579cb-8eaa-4015-a18c-e8bf8311b0dd';
    const input = { name: 'ada', org: 'platform', runtime: 'claude-code' as const, telegram_polling: false as const, actor: 'owner:test' };
    const first = await createEmployee(input, mutationId, dependencies);
    const second = await createEmployee(input, mutationId, dependencies);
    expect(second).toEqual(first);
    expect(started).toHaveLength(1);

    await expect(createEmployee({ ...input, name: 'grace' }, mutationId, dependencies))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('rejects invalid inputs without mutating registries or staging files', async () => {
    const before = readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8');
    const invalid = [
      { name: '', org: 'platform', runtime: 'claude-code' },
      { name: 'a'.repeat(65), org: 'platform', runtime: 'claude-code' },
      { name: 'Ada', org: 'platform', runtime: 'claude-code' },
      { name: 'ada', org: 'missing', runtime: 'claude-code' },
      { name: 'ada', org: 'platform', runtime: 'hermes' },
      { name: 'ada', org: 'platform', runtime: 'claude-code', telegram_polling: true },
    ];
    for (const value of invalid) {
      await expect(createEmployee({ ...value, actor: 'owner:test' } as never, crypto.randomUUID(), dependencies))
        .rejects.toBeInstanceOf(CrewServiceError);
    }
    expect(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8')).toBe(before);
    expect(() => readFileSync(join(frameworkRoot, 'orgs', 'platform', 'agents', 'ada'), 'utf8')).toThrow();
  });

  it('removes staging artifacts when a failure occurs before publication', async () => {
    dependencies.failAt = 'before-state-commit';
    await expect(createEmployee({
      name: 'ada', org: 'platform', runtime: 'claude-code', telegram_polling: false, actor: 'owner:test',
    }, '67ee842e-b948-4cbb-a4e6-e80c6847dc85', dependencies)).rejects.toMatchObject({ code: 'CREATE_FAILED' });
    expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'))).toEqual({});
    expect(() => readFileSync(join(frameworkRoot, 'orgs', 'platform', 'agents', 'ada'), 'utf8')).toThrow();
  });

  it.each(['after-directory-publish', 'after-enabled-write'] as const)(
    'compensates every published artifact when failure occurs %s',
    async failAt => {
      dependencies.failAt = failAt;
      const mutationId = failAt === 'after-directory-publish'
        ? '77ee842e-b948-4cbb-a4e6-e80c6847dc85'
        : '87ee842e-b948-4cbb-a4e6-e80c6847dc85';
      await expect(createEmployee({
        name: 'ada', org: 'platform', runtime: 'claude-code', telegram_polling: false, actor: 'owner:test',
      }, mutationId, dependencies)).rejects.toMatchObject({ code: 'CREATE_FAILED' });
      expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), 'utf8'))).toEqual({});
      expect(JSON.parse(readFileSync(join(ctxRoot, 'config', 'rooms.json'), 'utf8'))).toEqual([]);
      expect(existsSync(join(frameworkRoot, 'orgs', 'platform', 'agents', 'ada'))).toBe(false);
      const journal = JSON.parse(readFileSync(join(ctxRoot, 'state', 'crew-mutation-journal.json'), 'utf8'));
      expect(journal[0]).toMatchObject({ stage: 'finalized', final_result: { result: 'failure' } });
      expect(journal[0].final_result.after_digest).toBe(journal[0].before_digest);
    },
  );

  it('replays the exact mutation after a crash at the effect-start boundary', async () => {
    const mutationId = '97ee842e-b948-4cbb-a4e6-e80c6847dc85';
    const input = { name: 'ada', org: 'platform', runtime: 'claude-code' as const, telegram_polling: false as const, actor: 'owner:test' };
    dependencies.failAt = 'after-effect-start';
    await expect(createEmployee(input, mutationId, dependencies)).rejects.toMatchObject({ code: 'MUTATION_PENDING' });
    expect(started).toEqual([]);

    dependencies.failAt = undefined;
    await expect(createEmployee(input, mutationId, dependencies)).resolves.toMatchObject({ status: 'created' });
    expect(started).toEqual([mutationId]);
    const journal = JSON.parse(readFileSync(join(ctxRoot, 'state', 'crew-mutation-journal.json'), 'utf8'));
    expect(journal[0]).toMatchObject({ stage: 'finalized', final_result: { result: 'success' } });
  });

  it('exports the exact request ceilings', () => {
    expect(CREW_BODY_MAX_BYTES).toBe(131_072);
    expect(CREW_NAME_MAX_CHARS).toBe(64);
  });
});

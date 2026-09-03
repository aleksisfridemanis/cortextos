import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmployee } from '../../src/agents/create-employee.js';
import { readCrewLifecycleAuditEvents } from '../../src/audit/crew-lifecycle-audit.js';
import { readCrewMutationJournal } from '../../src/audit/crew-mutation-journal.js';

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
    writeFileSync(join(frameworkRoot, 'templates', 'agent', 'config.json'), '{}');
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

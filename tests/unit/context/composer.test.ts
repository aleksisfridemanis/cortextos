import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPLOYEE_CORE_MAX_BYTES,
  composeEmployeeContext,
} from '../../../src/context/composer.js';

describe('composeEmployeeContext', () => {
  let root: string;
  let frameworkRoot: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortext-context-'));
    frameworkRoot = join(root, 'framework');
    agentDir = join(root, 'agent');
    mkdirSync(join(frameworkRoot, 'templates', 'context'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'employee-core.md'), 'CURRENT CORE\n');
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'employee-router.md'), 'CURRENT ROUTER\n');
    writeFileSync(join(agentDir, 'IDENTITY.md'), 'identity bytes: \u03bb\n');
    writeFileSync(join(agentDir, 'GOALS.md'), 'goals bytes\n');
    writeFileSync(join(agentDir, 'USER.md'), 'user rules bytes\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('uses current framework templates and byte-preserved instance-owned sources', () => {
    const packet = composeEmployeeContext({
      frameworkRoot,
      agentDir,
      ctxRoot: join(root, 'ctx'),
      mode: 'fresh',
    });
    expect(packet.text).toContain('CURRENT CORE');
    expect(packet.text).toContain('CURRENT ROUTER');
    expect(packet.text).toContain('identity bytes: \u03bb\n');
    expect(packet.text).toContain('goals bytes\n');
    expect(packet.text).toContain('user rules bytes\n');
    expect(packet.provenance.map(item => item.owner)).toEqual([
      'framework', 'framework', 'instance', 'instance', 'instance',
    ]);
    expect(packet.byte_length).toBeLessThanOrEqual(EMPLOYEE_CORE_MAX_BYTES);
  });

  it('routes to dynamic registries without enumerating installed contents', () => {
    const packet = composeEmployeeContext({
      frameworkRoot,
      agentDir,
      ctxRoot: join(root, 'ctx'),
      mode: 'fresh',
    });
    expect(packet.routes.map(route => route.kind)).toEqual(expect.arrayContaining([
      'tools', 'skills', 'memory', 'project_instructions', 'identity', 'current_work',
    ]));
    expect(packet.text).not.toContain('installed_tools');
    expect(packet.text).not.toContain('installed_skills');
  });

  it('fails closed instead of truncating an oversized core', () => {
    writeFileSync(join(frameworkRoot, 'templates', 'context', 'employee-core.md'), 'x'.repeat(EMPLOYEE_CORE_MAX_BYTES));
    expect(() => composeEmployeeContext({
      frameworkRoot,
      agentDir,
      ctxRoot: join(root, 'ctx'),
      mode: 'fresh',
    })).toThrow(/CONTEXT_BUDGET_EXCEEDED/);
  });
});

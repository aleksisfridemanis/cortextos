import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

describe('production Claude session reporter bundle', () => {
  const output = mkdtempSync(join(tmpdir(), 'cortext-reporter-bundle-'));

  afterAll(() => rmSync(output, { recursive: true, force: true }));

  it('emits one standalone reporter that atomically acknowledges SessionStart', () => {
    execFileSync(process.execPath, [
      require.resolve('tsup/dist/cli-default.js'), '--config', 'tsup.config.ts',
      '--out-dir', output, '--clean', 'false',
    ], { cwd: process.cwd(), stdio: 'pipe' });
    const artifact = join(output, 'claude-session-reporter.js');
    expect(existsSync(artifact)).toBe(true);
    const id = '11111111-1111-4111-8111-111111111111';
    const ack = join(output, 'ack.json');
    const result = spawnSync(process.execPath, [artifact, id, ack], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: id }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(ack, 'utf8'))).toMatchObject({ session_id: id });
  }, 30_000);
});

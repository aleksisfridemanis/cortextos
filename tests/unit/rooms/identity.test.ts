import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveCanonicalUser } from '../../../src/rooms/identity';

describe('resolveCanonicalUser', () => {
  let root: string;
  let saved: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-room-identity-'));
    saved = process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_USERNAME;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = saved;
  });

  it('reads dashboard.env when the daemon process has no ADMIN_USERNAME', () => {
    // No daemon launch path exports ADMIN_USERNAME — only `cortextos
    // dashboard` does, and only into the Next process. Without this the
    // daemon would derive dm-<agent>--user while the route reads
    // dm-admin--<agent>, and the two could never meet.
    writeFileSync(join(root, 'dashboard.env'), 'AUTH_SECRET=x\nADMIN_USERNAME=admin\n');
    expect(resolveCanonicalUser(root)).toBe('admin');
  });

  it('prefers process.env over dashboard.env', () => {
    writeFileSync(join(root, 'dashboard.env'), 'ADMIN_USERNAME=admin\n');
    process.env.ADMIN_USERNAME = 'James';
    expect(resolveCanonicalUser(root)).toBe('james');
  });

  it("falls back to 'user' — the dashboard's own default — when nothing is configured", () => {
    expect(resolveCanonicalUser(root)).toBe('user');
  });

  it('treats a set-but-empty value as unset in both sources', () => {
    process.env.ADMIN_USERNAME = '   ';
    writeFileSync(join(root, 'dashboard.env'), 'ADMIN_USERNAME=\n');
    expect(resolveCanonicalUser(root)).toBe('user');
  });
});

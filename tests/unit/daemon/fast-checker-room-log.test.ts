import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import type { BusPaths, InboxMessage } from '../../../src/types';

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function seedInboxMessage(paths: BusPaths, msg: InboxMessage): void {
  writeFileSync(
    join(paths.inbox, `2-${Date.now()}-from-${msg.from}-aaaaa.json`),
    JSON.stringify(msg),
    'utf-8',
  );
}

const MESSAGE: InboxMessage = {
  id: '1755600000000-boris-x1y2z',
  from: 'boris',
  to: 'test-agent',
  priority: 'normal',
  timestamp: '2026-08-19T10:00:00.000Z',
  text: 'hello from the bus',
  reply_to: null,
};

describe('FastChecker — canonical room log recording', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-fastchecker-rooms-'));
    paths = createTestPaths(testDir);
  });

  afterEach(() => {
    // Restore permissions before rm so the chmod test can clean up.
    try { chmodSync(join(testDir, 'rooms'), 0o700); } catch { /* may not exist */ }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('records a delivered inbox message into the canonical room log', async () => {
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: () => {} });
    seedInboxMessage(paths, MESSAGE);

    await (checker as any).pollCycle();

    const logPath = join(testDir, 'rooms', 'dm-boris--test-agent', 'log.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const recorded = JSON.parse(lines[0]);
    expect(recorded.id).toBe(MESSAGE.id);
    expect(recorded.room_id).toBe('dm-boris--test-agent');
    expect(recorded.from).toBe('boris');
    expect(recorded.to).toBe('test-agent');
    expect(recorded.text).toBe('hello from the bus');
    expect(recorded.source).toBe('bus');
    expect(recorded.thread_id).toBe(MESSAGE.id);
    expect(recorded.attachments).toEqual([]);

    // Delivery still happened.
    expect(agent.injectMessage).toHaveBeenCalled();
  });

  it('keeps delivery and ACK working when the rooms dir is unwritable', async () => {
    // Hazard positive control: prove the chmod actually denies the write this
    // test depends on, so a root/permissive run cannot make it pass hollow.
    const roomsBase = join(testDir, 'rooms');
    mkdirSync(roomsBase, { recursive: true });
    chmodSync(roomsBase, 0o500);
    expect(() => mkdirSync(join(roomsBase, 'probe'), { recursive: true })).toThrow();

    const logged: string[] = [];
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: (m) => logged.push(m) });
    seedInboxMessage(paths, MESSAGE);

    await expect((checker as any).pollCycle()).resolves.not.toThrow();

    // The recording failure was reported...
    expect(logged.some(m => m.includes('recordRoomMessage'))).toBe(true);
    // ...and neither delivery nor ACK was affected: the message left inflight.
    expect(agent.injectMessage).toHaveBeenCalled();
    expect(readdirSync(paths.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync(paths.processed).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });
});

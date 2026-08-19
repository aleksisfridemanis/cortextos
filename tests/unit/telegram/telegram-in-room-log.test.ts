/**
 * Telegram-IN adapter: `recordInboundTelegram` must write the delivered
 * message into the canonical room log, in addition to the inbound JSONL
 * archive and the telegram_received bus event it already wrote.
 *
 * Sibling of tests/unit/daemon/fast-checker-room-log.test.ts (bus adapter)
 * and tests/unit/cli/send-telegram-room-log.test.ts (Telegram-OUT adapter):
 * one file per adapter, each asserting the same seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordInboundTelegram } from '../../../src/telegram/logging';
import type { BusPaths, TelegramMessage } from '../../../src/types';

function buildPaths(ctxRoot: string, agent: string): BusPaths {
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    processed: join(ctxRoot, 'processed', agent),
    logDir: join(ctxRoot, 'logs', agent),
    stateDir: join(ctxRoot, 'state', agent),
    taskDir: join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir: join(ctxRoot, 'analytics'),
    deliverablesDir: join(ctxRoot, 'orgs', 'lifeos', 'deliverables'),
  };
}

const MESSAGE: TelegramMessage = {
  message_id: 12345,
  date: 1755600000,
  from: { id: 6595584963, first_name: 'James' },
  chat: { id: 6595584963, type: 'private' },
  text: 'ship it',
};

describe('recordInboundTelegram — canonical room log recording', () => {
  let testDir: string;
  let originalAdminUsername: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-tg-in-rooms-'));
    // resolveCanonicalUser reads ADMIN_USERNAME first. Pin it so the derived
    // room id is a property of the code under test, not of the host machine.
    originalAdminUsername = process.env.ADMIN_USERNAME;
    process.env.ADMIN_USERNAME = 'james';
  });

  afterEach(() => {
    if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalAdminUsername;
    // Restore permissions before rm so the chmod test can clean up.
    try { chmodSync(join(testDir, 'rooms'), 0o700); } catch { /* may not exist */ }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('records an inbound Telegram message into the canonical room log', () => {
    const paths = buildPaths(testDir, 'boris');
    mkdirSync(paths.stateDir, { recursive: true });

    recordInboundTelegram(paths, testDir, 'boris', 'lifeos', 'James', MESSAGE);

    const logPath = join(testDir, 'rooms', 'dm-boris--james', 'log.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const recorded = JSON.parse(lines[0]);
    expect(recorded.id).toBe('tg-in-boris-12345');
    expect(recorded.room_id).toBe('dm-boris--james');
    expect(recorded.from).toBe('james');
    expect(recorded.to).toBe('boris');
    expect(recorded.text).toBe('ship it');
    expect(recorded.source).toBe('telegram');
    expect(recorded.thread_id).toBe('tg-in-boris-12345');
    expect(recorded.attachments).toEqual([]);

    // The pre-existing JSONL archive is untouched by the addition.
    const inboundPath = join(testDir, 'logs', 'boris', 'inbound-messages.jsonl');
    expect(JSON.parse(readFileSync(inboundPath, 'utf-8').trim())).toMatchObject({
      message_id: 12345,
      text: 'ship it',
      agent: 'boris',
    });
  });

  it('skips a text-less message but still records the text one (media stub)', () => {
    const paths = buildPaths(testDir, 'boris');
    mkdirSync(paths.stateDir, { recursive: true });

    // Positive control first: this write MUST land, so the absence asserted
    // below is a property of the empty text, not of a dead harness.
    recordInboundTelegram(paths, testDir, 'boris', 'lifeos', 'James', MESSAGE);

    const logPath = join(testDir, 'rooms', 'dm-boris--james', 'log.jsonl');
    expect(readFileSync(logPath, 'utf-8').trim().split('\n')).toHaveLength(1);

    // A voice note arrives as a stub with no text; the transcript lands later
    // on a separate path, so recording the stub would pin an empty bubble.
    recordInboundTelegram(paths, testDir, 'boris', 'lifeos', 'James', {
      message_id: 12346,
      date: 1755600060,
      from: { id: 6595584963, first_name: 'James' },
      chat: { id: 6595584963, type: 'private' },
      voice: { file_id: 'voice-abc', duration: 3 },
    } as TelegramMessage);

    const after = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(after).toHaveLength(1);
    expect(JSON.parse(after[0]).id).toBe('tg-in-boris-12345');
  });

  it('keeps JSONL archiving working when the rooms dir is unwritable', () => {
    // Hazard positive control: prove the chmod actually denies the write this
    // test depends on, so a root/permissive run cannot make it pass hollow.
    const roomsBase = join(testDir, 'rooms');
    mkdirSync(roomsBase, { recursive: true });
    chmodSync(roomsBase, 0o500);
    expect(() => mkdirSync(join(roomsBase, 'probe'), { recursive: true })).toThrow();

    const paths = buildPaths(testDir, 'boris');
    mkdirSync(paths.stateDir, { recursive: true });
    const logged: string[] = [];

    expect(() =>
      recordInboundTelegram(paths, testDir, 'boris', 'lifeos', 'James', MESSAGE, m => logged.push(m)),
    ).not.toThrow();

    // The recording failure was reported...
    expect(logged.some(m => m.includes('recordRoomMessage(telegram_in)'))).toBe(true);
    // ...and the inbound archive the daemon depends on still went through.
    const inboundPath = join(testDir, 'logs', 'boris', 'inbound-messages.jsonl');
    expect(JSON.parse(readFileSync(inboundPath, 'utf-8').trim())).toMatchObject({
      message_id: 12345,
      agent: 'boris',
    });
  });
});

/**
 * Telegram-OUT adapter: `cortextos bus send-telegram` must write the sent
 * message into the canonical room log, in addition to the outbound JSONL
 * trail and the telegram_sent bus event it already wrote.
 *
 * Sibling of tests/unit/daemon/fast-checker-room-log.test.ts (bus adapter)
 * and tests/unit/telegram/telegram-in-room-log.test.ts (Telegram-IN adapter):
 * one file per adapter, each asserting the same seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Same mocking idiom as tests/unit/cli/send-telegram-normalize.test.ts, but the
// returned message_id is per-test so the "no message_id" branch is reachable.
const sendMessageSpy = vi.fn();
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

describe('send-telegram — canonical room log recording', () => {
  let tempCtx: string;
  let tempCwd: string;
  let originalCtxRoot: string | undefined;
  let originalAgentName: string | undefined;
  let originalBotToken: string | undefined;
  let originalAdminUsername: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    tempCtx = mkdtempSync(join(tmpdir(), 'cortextos-tg-out-rooms-ctx-'));
    tempCwd = mkdtempSync(join(tmpdir(), 'cortextos-tg-out-rooms-cwd-'));
    mkdirSync(join(tempCtx, 'logs', 'boris'), { recursive: true });

    originalCtxRoot = process.env.CTX_ROOT;
    originalAgentName = process.env.CTX_AGENT_NAME;
    originalBotToken = process.env.BOT_TOKEN;
    originalAdminUsername = process.env.ADMIN_USERNAME;
    originalCwd = process.cwd();
    process.env.CTX_ROOT = tempCtx;
    process.env.CTX_AGENT_NAME = 'boris';
    process.env.BOT_TOKEN = 'fake-token-for-test';
    // resolveCanonicalUser reads ADMIN_USERNAME first. Pin it so the derived
    // room id is a property of the code under test, not of the host machine.
    process.env.ADMIN_USERNAME = 'james';
    process.chdir(tempCwd);

    sendMessageSpy.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = originalCtxRoot;
    if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = originalAgentName;
    if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = originalBotToken;
    if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalAdminUsername;
    rmSync(tempCtx, { recursive: true, force: true });
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('records a sent Telegram message into the canonical room log', async () => {
    sendMessageSpy.mockResolvedValue({ result: { message_id: 4242 } });

    await busCommand.parseAsync(['send-telegram', '12345', 'ship it'], { from: 'user' });

    const logPath = join(tempCtx, 'rooms', 'dm-boris--james', 'log.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const recorded = JSON.parse(lines[0]);
    expect(recorded.id).toBe('tg-out-boris-4242');
    expect(recorded.room_id).toBe('dm-boris--james');
    expect(recorded.from).toBe('boris');
    expect(recorded.to).toBe('james');
    expect(recorded.text).toBe('ship it');
    expect(recorded.source).toBe('telegram');
    expect(recorded.thread_id).toBe('tg-out-boris-4242');
    expect(recorded.attachments).toEqual([]);

    // The send itself still happened.
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('skips recording when Telegram returned no message_id', async () => {
    // Positive control first: this send MUST land in the log, so the absence
    // asserted below is a property of the missing id, not of a dead harness.
    sendMessageSpy.mockResolvedValue({ result: { message_id: 7 } });
    await busCommand.parseAsync(['send-telegram', '12345', 'first'], { from: 'user' });

    const logPath = join(tempCtx, 'rooms', 'dm-boris--james', 'log.jsonl');
    expect(readFileSync(logPath, 'utf-8').trim().split('\n')).toHaveLength(1);

    // Without a message_id the dashboard falls back to a timestamp-derived id
    // we cannot reproduce, so recording would render the message twice.
    sendMessageSpy.mockResolvedValue({ result: {} });
    await busCommand.parseAsync(['send-telegram', '12345', 'second'], { from: 'user' });

    const after = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(after).toHaveLength(1);
    expect(JSON.parse(after[0]).id).toBe('tg-out-boris-7');
  });
});

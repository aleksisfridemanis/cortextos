/**
 * Tests for readPairSummary — the roster's last-activity/preview source.
 *
 * The roster used to read ONLY the DM room-log tail (readRoomTail), which
 * misses agent→user replies sent over the bus: those are never projected into
 * the room log, but they DO land in the bus queues and the agent's Telegram
 * logs. readPairSummary unions those live sources so the roster summary cannot
 * lag behind the open chat.
 *
 * Fixtures use generic placeholder identities (agent-a, agent-b, user) so the
 * suite is portable to any install, not this fleet's roster.
 *
 * Each surfacing test is a real POSITIVE CONTROL: it also asserts that the
 * old room-log-tail-only path (readRoomTail) returns {null,null} for the same
 * seed, so a regression back to tail-only would fail here rather than pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPairSummary, readRoomTail } from '../rooms';
import type { CommsIdentity } from '../comms-identity';

const identity: CommsIdentity = {
  agents: new Set(['agent-a', 'agent-b']),
  canonicalUser: 'user',
};
const PAIR_ROOM = 'dm-agent-a--user';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-summary-'));
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeRoomLog(lines: Array<Record<string, unknown>>): void {
  const dir = path.join(root, 'rooms', PAIR_ROOM);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'log.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

function writeTelegramLog(
  agent: string,
  file: 'inbound-messages.jsonl' | 'outbound-messages.jsonl',
  entries: Array<Record<string, unknown>>,
): void {
  const dir = path.join(root, 'logs', agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

function writeQueue(queue: string, owner: string, file: string, obj: Record<string, unknown>): void {
  const dir = path.join(root, queue, owner);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj));
}

const summary = () => readPairSummary(root, 'agent-a', 'user', identity);

describe('readPairSummary', () => {
  it('surfaces a reply present ONLY in the agent outbound log (absent from room log)', () => {
    writeTelegramLog('agent-a', 'outbound-messages.jsonl', [
      { timestamp: '2026-08-20T10:00:00Z', agent: 'agent-a', text: 'reply from outbound', message_id: 1 },
    ]);
    // Positive control: the old room-log-tail-only path sees nothing.
    expect(readRoomTail(root, PAIR_ROOM)).toEqual({ lastActivity: null, lastPreview: null });
    expect(summary()).toEqual({
      lastActivity: '2026-08-20T10:00:00Z',
      lastPreview: 'reply from outbound',
    });
  });

  it('surfaces a user note present ONLY in the agent inbound (Telegram) log', () => {
    writeTelegramLog('agent-a', 'inbound-messages.jsonl', [
      { timestamp: '2026-08-24T10:00:00Z', text: 'user telegram note', message_id: 5 },
    ]);
    // Positive control: room-log tail (and every other source) is empty, so an
    // inbound-blind reader would return null here.
    expect(readRoomTail(root, PAIR_ROOM)).toEqual({ lastActivity: null, lastPreview: null });
    expect(summary()).toEqual({
      lastActivity: '2026-08-24T10:00:00Z',
      lastPreview: 'user telegram note',
    });
  });

  it('surfaces an agent→user reply from the USER inbox queue when the room log is tool-runs only', () => {
    // Room log carries only a `kind` tool-run marker — no ordinary bubble.
    writeRoomLog([
      { id: 'k1', from: 'agent-a', to: 'user', timestamp: '2026-08-21T09:00:00Z', kind: 'tool_run', text: 'tool step' },
    ]);
    // The reply landed in the user's inbox as from-agent-a (never the agent's dir).
    writeQueue('inbox', 'user', '2-1787200000000-from-agent-a-abc12.json', {
      id: '1787200000000-agent-a-abc12',
      from: 'agent-a',
      to: 'user',
      priority: 'normal',
      timestamp: '2026-08-21T10:00:00Z',
      text: 'queued bus reply',
      reply_to: null,
    });
    // Positive control: room-log tail has no ordinary message.
    expect(readRoomTail(root, PAIR_ROOM)).toEqual({ lastActivity: null, lastPreview: null });
    expect(summary()).toEqual({
      lastActivity: '2026-08-21T10:00:00Z',
      lastPreview: 'queued bus reply',
    });
  });

  it('surfaces the newest ordinary room-log message past a later tool-run line', () => {
    writeRoomLog([
      { id: 'm1', from: 'agent-a', to: 'user', timestamp: '2026-08-19T12:00:00Z', text: 'real reply' },
      { id: 'r1', from: 'agent-a', to: 'user', timestamp: '2026-08-19T13:00:00Z', kind: 'tool_run', text: 'tool step' },
    ]);
    expect(summary()).toEqual({
      lastActivity: '2026-08-19T12:00:00Z',
      lastPreview: 'real reply',
    });
  });

  it('picks the newest across sources (queue newer than room log)', () => {
    writeRoomLog([
      { id: 'm1', from: 'user', to: 'agent-a', timestamp: '2026-08-22T08:00:00Z', text: 'user message' },
    ]);
    writeQueue('processed', 'user', '2-1787300000000-from-agent-a-zzz99.json', {
      id: '1787300000000-agent-a-zzz99',
      from: 'agent-a',
      to: 'user',
      priority: 'normal',
      timestamp: '2026-08-22T09:00:00Z',
      text: 'newer agent reply',
      reply_to: null,
    });
    expect(summary()).toEqual({
      lastActivity: '2026-08-22T09:00:00Z',
      lastPreview: 'newer agent reply',
    });
  });

  it('surfaces a reply buried under >16 KiB of tool-run lines via the queue copy', () => {
    // Ordinary reply at the very top, then a wall of `kind` lines that exceeds
    // the 16 KiB tail window, pushing the ordinary message out of readRoomTail's
    // reach entirely.
    const lines: Array<Record<string, unknown>> = [
      { id: 'buried', from: 'agent-a', to: 'user', timestamp: '2026-08-22T08:00:00Z', text: 'buried reply' },
    ];
    for (let i = 0; i < 120; i++) {
      lines.push({
        id: `k${i}`,
        from: 'agent-a',
        to: 'user',
        timestamp: `2026-08-22T09:${String(i % 60).padStart(2, '0')}:00Z`,
        kind: 'tool_run',
        text: 'x'.repeat(220),
      });
    }
    writeRoomLog(lines);
    // Same reply also recorded in the queue.
    writeQueue('inbox', 'user', '2-1787310000000-from-agent-a-bur10.json', {
      id: '1787310000000-agent-a-bur10',
      from: 'agent-a',
      to: 'user',
      priority: 'normal',
      timestamp: '2026-08-22T08:00:00Z',
      text: 'buried reply',
      reply_to: null,
    });
    // Positive control: the tail window is all tool-runs, so tail-only is blind.
    expect(readRoomTail(root, PAIR_ROOM)).toEqual({ lastActivity: null, lastPreview: null });
    expect(summary()).toEqual({
      lastActivity: '2026-08-22T08:00:00Z',
      lastPreview: 'buried reply',
    });
  });

  it('returns nulls when the agent has no message anywhere', () => {
    expect(summary()).toEqual({ lastActivity: null, lastPreview: null });
  });

  it('ignores queue envelopes from other agents in the shared user inbox', () => {
    // The user inbox holds messages from many agents; an agent-b→user message
    // must not surface on agent-a's row.
    writeQueue('inbox', 'user', '2-1787400000000-from-agent-b-oth01.json', {
      id: '1787400000000-agent-b-oth01',
      from: 'agent-b',
      to: 'user',
      priority: 'normal',
      timestamp: '2026-08-23T10:00:00Z',
      text: 'agent-b message',
      reply_to: null,
    });
    expect(summary()).toEqual({ lastActivity: null, lastPreview: null });
  });
});

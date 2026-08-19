import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordRoomMessage, inboxMessageToRoomInput } from '../../../src/rooms/record';
import { readRoomLog } from '../../../src/rooms/log';
import { getRoom } from '../../../src/rooms/registry';
import type { InboxMessage } from '../../../src/types';

const INBOX: InboxMessage = {
  id: '1755600000000-boris-x1y2z',
  from: 'Boris',
  to: 'nick',
  priority: 'high',
  timestamp: '2026-08-19T10:00:00.000Z',
  text: 'ship it',
  reply_to: null,
};

describe('recordRoomMessage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-room-record-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('translates an inbox envelope without touching it', () => {
    const input = inboxMessageToRoomInput(INBOX);
    expect(input).toEqual({
      id: INBOX.id,
      from: 'Boris',
      to: 'nick',
      timestamp: INBOX.timestamp,
      text: 'ship it',
      reply_to: null,
      source: 'bus',
      priority: 'high',
    });
    // Pure: the envelope is unchanged.
    expect(INBOX.from).toBe('Boris');
  });

  it('derives the room, indexes it, and appends the message', () => {
    const msg = recordRoomMessage(root, inboxMessageToRoomInput(INBOX));

    expect(msg.room_id).toBe('dm-boris--nick');
    expect(msg.from).toBe('boris'); // normalized
    expect(msg.to).toBe('nick');
    expect(msg.priority).toBe('high');
    expect(msg.attachments).toEqual([]);

    const indexed = getRoom(root, 'dm-boris--nick');
    expect(indexed?.kind).toBe('dm');
    expect(indexed?.members).toEqual(['boris', 'nick']);

    expect(readRoomLog(root, 'dm-boris--nick').map(m => m.id)).toEqual([INBOX.id]);
  });

  it('roots a thread at the message id, and a reply at its parent', () => {
    const root1 = recordRoomMessage(root, inboxMessageToRoomInput(INBOX));
    expect(root1.thread_id).toBe(INBOX.id);

    const reply = recordRoomMessage(root, {
      id: 'reply-1',
      from: 'nick',
      to: 'boris',
      timestamp: '2026-08-19T10:01:00.000Z',
      text: 'shipped',
      reply_to: INBOX.id,
      source: 'bus',
    });
    expect(reply.thread_id).toBe(INBOX.id);
    expect(reply.room_id).toBe('dm-boris--nick'); // same room, either direction
  });

  it('honours an explicit room id', () => {
    const msg = recordRoomMessage(root, {
      id: 'm1',
      from: 'boris',
      timestamp: '2026-08-19T10:00:00.000Z',
      text: 'note to self',
      source: 'bus',
      roomId: 'agent-boris',
    });
    expect(msg.room_id).toBe('agent-boris');
    expect(getRoom(root, 'agent-boris')?.kind).toBe('agent');
  });

  it('rejects an unsafe explicit room id before it becomes a path', () => {
    expect(() => recordRoomMessage(root, {
      id: 'm1',
      from: 'boris',
      timestamp: '2026-08-19T10:00:00.000Z',
      text: 'x',
      source: 'bus',
      roomId: '../../escape',
    })).toThrow();
  });

  it('throws when there is neither a room nor a recipient', () => {
    expect(() => recordRoomMessage(root, {
      id: 'm1',
      from: 'boris',
      timestamp: '2026-08-19T10:00:00.000Z',
      text: 'x',
      source: 'bus',
    })).toThrow(/no room and no recipient/);
  });

  it('carries attachments through', () => {
    const msg = recordRoomMessage(root, {
      id: 'm1',
      from: 'james',
      to: 'boris',
      timestamp: '2026-08-19T10:00:00.000Z',
      text: '[voice message]',
      source: 'telegram',
      attachments: [{ kind: 'voice', path: 'media/v1.ogg', transcript: 'hello' }],
    });
    expect(msg.attachments).toEqual([
      { kind: 'voice', path: 'media/v1.ogg', transcript: 'hello' },
    ]);
    expect(readRoomLog(root, 'dm-boris--james')[0].attachments).toHaveLength(1);
  });
});

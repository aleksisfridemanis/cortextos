import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendRoomMessage, readRoomLog, roomLogPath } from '../../../src/rooms/log';
import type { RoomMessage } from '../../../src/types';

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: 'm1',
    room_id: 'dm-boris--nick',
    from: 'boris',
    to: 'nick',
    timestamp: '2026-08-19T10:00:00.000Z',
    text: 'hello',
    reply_to: null,
    thread_id: 'm1',
    source: 'bus',
    attachments: [],
    ...overrides,
  };
}

describe('room log', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-room-log-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the room directory and writes one line per record', () => {
    appendRoomMessage(root, message());
    const p = roomLogPath(root, 'dm-boris--nick');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('appends rather than overwrites, preserving write order', () => {
    appendRoomMessage(root, message({ id: 'm1' }));
    appendRoomMessage(root, message({ id: 'm2', text: 'second' }));
    appendRoomMessage(root, message({ id: 'm3', text: 'third' }));

    const read = readRoomLog(root, 'dm-boris--nick');
    expect(read.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns a duplicated id exactly once', () => {
    // A daemon bounce re-delivers whatever was inflight, so the writer is
    // allowed to repeat. The reader is what collapses it.
    appendRoomMessage(root, message({ id: 'm1' }));
    appendRoomMessage(root, message({ id: 'm1' }));
    appendRoomMessage(root, message({ id: 'm2' }));

    const raw = readFileSync(roomLogPath(root, 'dm-boris--nick'), 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(3); // the writer really did repeat

    const read = readRoomLog(root, 'dm-boris--nick');
    expect(read.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('skips a corrupt line without losing its neighbours', () => {
    appendRoomMessage(root, message({ id: 'm1' }));
    appendFileSync(roomLogPath(root, 'dm-boris--nick'), '{not json\n', 'utf-8');
    appendRoomMessage(root, message({ id: 'm2' }));

    const read = readRoomLog(root, 'dm-boris--nick');
    expect(read.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('returns an empty list for a room with no log', () => {
    expect(readRoomLog(root, 'dm-nobody--here')).toEqual([]);
  });

  it('refuses to build a path from an unsafe room id', () => {
    expect(() => roomLogPath(root, '../escape')).toThrow();
    expect(() => appendRoomMessage(root, message({ room_id: '../escape' }))).toThrow();
  });
});

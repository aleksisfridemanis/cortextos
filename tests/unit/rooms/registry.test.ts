import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readRooms, getRoom, upsertRoom } from '../../../src/rooms/registry';
import { recordRoomMessage } from '../../../src/rooms/record';
import type { Room } from '../../../src/types';

function room(id = 'dm-boris--nick'): Room {
  return {
    id,
    kind: 'dm',
    title: 'boris ↔ nick',
    members: ['boris', 'nick'],
    created_at: '2026-08-19T10:00:00.000Z',
    created_by: 'boris',
  };
}

function registryPath(root: string): string {
  return join(root, 'config', 'rooms.json');
}

describe('room registry', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-room-registry-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates config/rooms.json on first upsert', () => {
    upsertRoom(root, room());
    expect(existsSync(registryPath(root))).toBe(true);
    expect(readRooms(root).map(r => r.id)).toEqual(['dm-boris--nick']);
  });

  it('does not duplicate on re-upsert of the same id', () => {
    upsertRoom(root, room());
    upsertRoom(root, room());
    upsertRoom(root, { ...room(), title: 'changed' });
    const rooms = readRooms(root);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].title).toBe('boris ↔ nick'); // first write wins, no churn
  });

  it('keeps distinct rooms side by side', () => {
    upsertRoom(root, room('dm-boris--nick'));
    upsertRoom(root, room('dm-boris--paul'));
    expect(readRooms(root).map(r => r.id).sort()).toEqual(['dm-boris--nick', 'dm-boris--paul']);
  });

  it('returns [] for an absent registry without throwing', () => {
    expect(readRooms(root)).toEqual([]);
    expect(getRoom(root, 'dm-boris--nick')).toBeNull();
  });

  it('neither throws nor drops the write when rooms.json is corrupt', () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(registryPath(root), '{ not json at all');

    expect(readRooms(root)).toEqual([]);
    expect(() => upsertRoom(root, room())).not.toThrow();
    expect(readRooms(root).map(r => r.id)).toEqual(['dm-boris--nick']);
  });

  it('ignores non-room entries in a structurally valid file', () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(registryPath(root), JSON.stringify([{ nope: 1 }, room()]));
    expect(readRooms(root).map(r => r.id)).toEqual(['dm-boris--nick']);
  });

  it('records a message even when the registry is unreadable — ids are derived, not looked up', () => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(registryPath(root), 'garbage');
    expect(getRoom(root, 'dm-boris--nick')).toBeNull();

    const recorded = recordRoomMessage(root, {
      id: 'm1',
      from: 'boris',
      to: 'nick',
      timestamp: '2026-08-19T10:00:00.000Z',
      text: 'still delivered',
      source: 'bus',
    });

    expect(recorded.room_id).toBe('dm-boris--nick');
    const logged = readFileSync(join(root, 'rooms', 'dm-boris--nick', 'log.jsonl'), 'utf-8');
    expect(logged).toContain('still delivered');
  });
});

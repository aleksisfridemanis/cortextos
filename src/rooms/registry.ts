/**
 * Room registry — an INDEX, not a routing dependency.
 *
 * Lives at {ctxRoot}/config/rooms.json, beside enabled-agents.json: it is
 * fleet-global, and unlike state/ it is not per-agent and not cleared by
 * lifecycle operations.
 *
 * Every read is defensive: an absent or corrupt registry returns an empty
 * list rather than throwing, because room ids are derived and recording must
 * survive a broken index.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import type { Room } from '../types/index.js';

function registryDir(ctxRoot: string): string {
  return join(ctxRoot, 'config');
}

function registryPath(ctxRoot: string): string {
  return join(registryDir(ctxRoot), 'rooms.json');
}

function isRoom(value: unknown): value is Room {
  const r = value as Room;
  return !!r && typeof r.id === 'string' && typeof r.kind === 'string';
}

/** All known rooms. Absent or corrupt registry => []. Never throws. */
export function readRooms(ctxRoot: string): Room[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(ctxRoot), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter(isRoom) : [];
  } catch {
    return [];
  }
}

/** A single room by id, or null when it is not indexed. Never throws. */
export function getRoom(ctxRoot: string, roomId: string): Room | null {
  return readRooms(ctxRoot).find(r => r.id === roomId) ?? null;
}

/**
 * Add `room` to the registry if its id is not already present.
 *
 * The whole read-modify-write runs under the config dir's mutex and re-reads
 * inside the lock, so a daemon and N agents upserting concurrently cannot
 * lose each other's entries.
 */
export function upsertRoom(ctxRoot: string, room: Room): void {
  const dir = registryDir(ctxRoot);
  ensureDir(dir);
  withFileLockSync(dir, () => {
    const rooms = readRooms(ctxRoot);
    if (rooms.some(r => r.id === room.id)) return;
    rooms.push(room);
    atomicWriteSync(registryPath(ctxRoot), JSON.stringify(rooms, null, 2));
  });
}

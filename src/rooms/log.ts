/**
 * Canonical room log — {ctxRoot}/rooms/{roomId}/log.jsonl.
 *
 * Append-only, one JSON object per line, written with appendFileSync (same
 * pattern as bus/event.ts and telegram/logging.ts — no new locking scheme).
 *
 * THE WRITER MAY REPEAT AND THE READER DEDUPES BY id. A daemon bounce
 * re-delivers whatever was inflight, so the same message can be recorded
 * twice; readRoomLog collapses that back to one.
 */

import { appendFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { validateRoomId } from './id.js';
import type { RoomMessage } from '../types/index.js';

/** Directory holding a room's log. Room id is validated before the join. */
export function roomDir(ctxRoot: string, roomId: string): string {
  return join(ctxRoot, 'rooms', validateRoomId(roomId));
}

export function roomLogPath(ctxRoot: string, roomId: string): string {
  return join(roomDir(ctxRoot, roomId), 'log.jsonl');
}

/** Append one message to its room log, creating the room directory if needed. */
export function appendRoomMessage(ctxRoot: string, msg: RoomMessage): void {
  const dir = roomDir(ctxRoot, msg.room_id);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(msg) + '\n', 'utf-8');
}

/**
 * Read a room log in write order. Message content is immutable and the first
 * occurrence wins; later copies may advance only the delivery-state projection.
 * Corrupt lines are skipped without losing their neighbours. Absent log => [].
 */
export function readRoomLog(ctxRoot: string, roomId: string): RoomMessage[] {
  let raw: string;
  try {
    raw = readFileSync(roomLogPath(ctxRoot, roomId), 'utf-8');
  } catch {
    return [];
  }

  const byId = new Map<string, RoomMessage>();
  const messages: RoomMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg: RoomMessage = JSON.parse(line);
      // Same admission rule as the dashboard's read-only twin
      // (dashboard/src/lib/rooms.ts) — a line missing any of these is not a
      // renderable message, and the two readers must agree on what they drop.
      if (!msg.id || !msg.from || !msg.timestamp) continue;
      const existing = byId.get(msg.id);
      if (existing) {
        if (msg.delivery_state) existing.delivery_state = msg.delivery_state;
        continue;
      }
      byId.set(msg.id, msg);
      messages.push(msg);
    } catch {
      /* skip corrupt line */
    }
  }
  return messages;
}

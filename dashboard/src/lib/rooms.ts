/**
 * READ-ONLY view of the canonical room logs written by the daemon
 * (src/rooms/*). The dashboard never writes a room log — there is exactly one
 * writer implementation, in src/.
 *
 * This duplicates ~40 lines of src/rooms deliberately: the dashboard bundle
 * cannot import from src/ (every src module uses .js specifiers that the
 * Turbopack build will not map back to .ts across the package boundary), so
 * the read side is reimplemented here rather than shared. The route tests
 * seed a real room log and read it back through this module, which is what
 * keeps the two implementations in agreement.
 */

import fs from 'fs';
import path from 'path';

export interface RoomMessage {
  id: string;
  room_id: string;
  from: string;
  to?: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
  thread_id: string;
  source: string;
  /** Tool-run marker. Absent on ordinary messages and on every inc1 line. */
  kind?: string;
  attachments: Array<{ kind: string; path: string; mime?: string; transcript?: string }>;
  priority?: string;
}

const ROOM_ID_PATTERN = /^[a-z0-9_-]+$/;

/** Room id for a 1:1 conversation — 'dm-' + the canonical pair key. */
export function dmRoomId(a: string, b: string): string {
  return `dm-${[a.trim().toLowerCase(), b.trim().toLowerCase()].sort().join('--')}`;
}

/**
 * Read a room log, first occurrence of each id winning. Corrupt lines are
 * skipped. An absent log, or an id that is not a safe path segment, gives [].
 */
export function readRoomLog(ctxRoot: string, roomId: string): RoomMessage[] {
  if (!ROOM_ID_PATTERN.test(roomId)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(ctxRoot, 'rooms', roomId, 'log.jsonl'), 'utf-8');
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const messages: RoomMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg: RoomMessage = JSON.parse(line);
      if (!msg.id || !msg.from || !msg.timestamp || seen.has(msg.id)) continue;
      seen.add(msg.id);
      messages.push(msg);
    } catch {
      /* skip corrupt line */
    }
  }
  return messages;
}

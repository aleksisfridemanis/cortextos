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

/** Last-activity summary of a room — the newest human message only. */
export interface RoomTail {
  /** ISO timestamp of the newest ordinary message, or null when empty. */
  lastActivity: string | null;
  /** Whitespace-collapsed, truncated text of that message, or null. */
  lastPreview: string | null;
}

// How many bytes to read from the tail of a log for a preview. One screenful of
// chat is a few hundred bytes; 16 KiB covers a long run of tool-step records
// without ever reading a multi-megabyte log in full.
const TAIL_BYTES = 16 * 1024;

function previewText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

/**
 * Derive a room's last-activity summary from the tail lines of its log.
 *
 * Walks backwards to the newest ORDINARY message — `kind`-bearing tool-run
 * markers are skipped so the preview matches the last bubble the chat renders.
 * `startedMidFile` means the first element is a partial line (the read began
 * inside the file) and must be dropped.
 *
 * Pure: the file IO lives in readRoomTail. Exported for its own unit test.
 */
export function extractTail(
  lines: string[],
  startedMidFile: boolean,
  previewChars = 140,
): RoomTail {
  const work = startedMidFile && lines.length > 1 ? lines.slice(1) : lines;
  for (let i = work.length - 1; i >= 0; i--) {
    const line = work[i].trim();
    if (!line) continue;
    let msg: RoomMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg.id || !msg.from || !msg.timestamp || msg.kind) continue;
    return { lastActivity: msg.timestamp, lastPreview: previewText(msg.text ?? '', previewChars) };
  }
  return { lastActivity: null, lastPreview: null };
}

/**
 * Tail-only room-log reader: reads at most the last TAIL_BYTES of the log and
 * returns the newest ordinary message's timestamp and preview. Unlike
 * readRoomLog this never parses the whole file, so it stays cheap as logs grow
 * — the reusable primitive behind the crew roster's last-message time and sort.
 *
 * An absent log, an unsafe id, or an empty file gives {null, null}.
 */
export function readRoomTail(ctxRoot: string, roomId: string, previewChars = 140): RoomTail {
  if (!ROOM_ID_PATTERN.test(roomId)) return { lastActivity: null, lastPreview: null };

  const filePath = path.join(ctxRoot, 'rooms', roomId, 'log.jsonl');
  let fd: number;
  let size: number;
  try {
    size = fs.statSync(filePath).size;
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { lastActivity: null, lastPreview: null };
  }

  try {
    if (size === 0) return { lastActivity: null, lastPreview: null };
    const readLen = Math.min(size, TAIL_BYTES);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    return extractTail(buf.toString('utf-8').split('\n'), start > 0, previewChars);
  } catch {
    return { lastActivity: null, lastPreview: null };
  } finally {
    fs.closeSync(fd);
  }
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

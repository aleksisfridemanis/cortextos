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
import { buildPairKey, type CommsIdentity } from './comms-identity';

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
 * Selects the newest ORDINARY message by timestamp — `kind`-bearing tool-run
 * markers are skipped so the preview matches the last bubble the chat renders.
 * File/append order can diverge from timestamp order (DM logs are recorded at
 * delivery by independent per-direction inbox checkers), so this picks the
 * greatest `timestamp` (ISO strings compare lexically), tie-breaking on later
 * file position. This matches the chat view, which sorts by timestamp.
 * `startedMidFile` means the first element is a partial line (the read began
 * inside the file) and must be dropped.
 *
 * Bounded to the last TAIL_BYTES (16 KiB) window: a message displaced by more
 * than that much later appends is still missed. That bound is unchanged here.
 *
 * Pure: the file IO lives in readRoomTail. Exported for its own unit test.
 */
export function extractTail(
  lines: string[],
  startedMidFile: boolean,
  previewChars = 140,
): RoomTail {
  const work = startedMidFile && lines.length > 1 ? lines.slice(1) : lines;
  let best: RoomMessage | null = null;
  for (let i = 0; i < work.length; i++) {
    const line = work[i].trim();
    if (!line) continue;
    let msg: RoomMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg.id || !msg.from || !msg.timestamp || msg.kind) continue;
    // Later file position wins ties (>=), so iterating forward keeps the newest
    // append at an equal timestamp.
    if (!best || msg.timestamp.localeCompare(best.timestamp) >= 0) best = msg;
  }
  if (!best) return { lastActivity: null, lastPreview: null };
  return { lastActivity: best.timestamp, lastPreview: previewText(best.text ?? '', previewChars) };
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

/**
 * Read at most the last `maxBytes` of a JSONL file and return the parsed
 * objects, dropping the first (partial) line when the read began mid-file.
 * An absent/unreadable file gives null; an empty file gives []. Same
 * tail/stat discipline as readRoomTail — never parses the whole file.
 */
function readJsonlTail(
  filePath: string,
  maxBytes = TAIL_BYTES,
): Record<string, unknown>[] | null {
  let fd: number;
  let size: number;
  try {
    size = fs.statSync(filePath).size;
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    if (size === 0) return [];
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, start);
    const parts = buf.toString('utf-8').split('\n');
    const lines = start > 0 && parts.length > 1 ? parts.slice(1) : parts;
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Bus queue envelope filename: '<priority>-<epochMs>-from-<sender>-<rand>.json'.
// The sender may itself contain dashes (e.g. codex-worker); the random suffix
// is the final dash segment and never does. Greedy sender capture takes the
// rest.
const QUEUE_FILE_PATTERN = /^\d+-(\d+)-from-(.+)-[a-z0-9]+\.json$/;

/**
 * Last-activity summary for one agent↔user conversation, unioning the live
 * sources the chat channel route reads so the roster and the open chat cannot
 * disagree:
 *
 *   1. the canonical room-log tail (readRoomTail),
 *   2. the newest ordinary message in the bus queues (inbox/inflight/processed)
 *      for the pair — scanned on BOTH members' queue dirs, because an agent→user
 *      reply sent over the bus lands in the USER's inbox (from-<agent>), never
 *      the agent's own dir,
 *   3. the tails of the agent's Telegram logs (logs/<agent>/{inbound,outbound}-
 *      messages.jsonl) — inbound is user→agent, outbound is agent→user; both
 *      belong to this pair.
 *
 * The channel route's fourth source, the legacy logs/message-history.jsonl, is
 * intentionally omitted: it has no remaining writer (dead source), so a
 * whole-file scan of it would add cost without ever winning the newest slot.
 *
 * Returns the newest ORDINARY (non-`kind`) message across those sources. Ties
 * in timestamp resolve to the higher-precedence source (room log > queue >
 * Telegram log), mirroring the channel route where the room-log copy claims the
 * id first. Every source is tail/stat-bounded — no whole-file parse.
 *
 * An agent with no message anywhere gives {null, null} (roster falls back to
 * the tagline).
 */
export function readPairSummary(
  ctxRoot: string,
  agent: string,
  user: string,
  identity: CommsIdentity,
  previewChars = 140,
): RoomTail {
  const pair = buildPairKey(agent, user, identity);
  // Accumulator held on an object so the closure's assignment does not defeat
  // control-flow narrowing of the final read.
  const acc: { best: { timestamp: string; text: string } | null } = { best: null };

  // Strictly-greater replacement means an equal-timestamp candidate from a
  // later (lower-precedence) source cannot displace an earlier one.
  const consider = (timestamp: string, text: string): void => {
    if (!timestamp || !text) return;
    if (!acc.best || timestamp.localeCompare(acc.best.timestamp) > 0) {
      acc.best = { timestamp, text };
    }
  };

  // 1. Room-log tail (highest precedence).
  const room = readRoomTail(ctxRoot, `dm-${pair}`, previewChars);
  if (room.lastActivity && room.lastPreview) consider(room.lastActivity, room.lastPreview);

  // 2. Bus queues — newest ordinary pair message. Filenames carry the sender and
  // an epoch-ms ordering key, so candidates are ranked WITHOUT reading; only the
  // newest matching envelope per direction is opened.
  const otherByOwner: Array<{ owner: string; other: string }> = [
    { owner: user, other: agent },
    { owner: agent, other: user },
  ];
  const candidates: Array<{ ms: number; full: string }> = [];
  for (const queue of ['inbox', 'inflight', 'processed']) {
    for (const { owner, other } of otherByOwner) {
      const dir = path.join(ctxRoot, queue, owner);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = QUEUE_FILE_PATTERN.exec(f);
        if (!m) continue;
        if (m[2].toLowerCase() !== other.toLowerCase()) continue; // sender must be the counterpart
        candidates.push({ ms: Number(m[1]), full: path.join(dir, f) });
      }
    }
  }
  // Rank by the filename epoch (assumed ~= the message `timestamp`); only the
  // newest-by-filename ordinary envelope is opened and then compared by its real
  // timestamp. Clock skew or a re-enqueue could reorder the two by a few ms — an
  // accepted rare bound, since the room-log/Telegram sources cover the same
  // message and reading every envelope to sort by true timestamp is the cost
  // this tail-bounded path exists to avoid.
  candidates.sort((x, y) => y.ms - x.ms);
  for (const c of candidates) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(fs.readFileSync(c.full, 'utf-8'));
    } catch {
      continue;
    }
    if (msg.kind) continue; // tool-run marker, never a chat bubble
    const text = typeof msg.text === 'string' ? msg.text : '';
    const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : '';
    if (!text || !timestamp) continue;
    if (buildPairKey(String(msg.from ?? ''), String(msg.to ?? ''), identity) !== pair) continue;
    consider(timestamp, text);
    break; // newest ordinary pair envelope found; older ones cannot win
  }

  // 3. Agent's Telegram logs — inbound (user→agent) and outbound (agent→user).
  // Every entry in either file belongs to this pair, so no pair filter is
  // needed. text may live under `text` or `transcript` (voice notes).
  for (const logFile of ['inbound-messages.jsonl', 'outbound-messages.jsonl']) {
    const entries = readJsonlTail(path.join(ctxRoot, 'logs', agent, logFile));
    if (!entries) continue;
    for (const obj of entries) {
      const text =
        typeof obj.text === 'string' && obj.text
          ? obj.text
          : typeof obj.transcript === 'string'
            ? obj.transcript
            : '';
      const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : '';
      consider(timestamp, text);
    }
  }

  if (!acc.best) return { lastActivity: null, lastPreview: null };
  return { lastActivity: acc.best.timestamp, lastPreview: previewText(acc.best.text, previewChars) };
}

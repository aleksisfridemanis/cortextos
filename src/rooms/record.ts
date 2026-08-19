/**
 * The transport seam — ONE function every adapter calls.
 *
 * Adapters translate their own message shape into a RoomMessageInput and hand
 * it here; nothing else in the codebase knows how a room log is laid out.
 *
 * Recording happens at DELIVERY, not at send: checkInbox is the one chokepoint
 * every inbox writer already flows through, so the send paths the live fleet
 * depends on need no changes at all.
 */

import { dmRoomId, normalizeMember, validateRoomId } from './id.js';
import { getRoom, upsertRoom } from './registry.js';
import { appendRoomMessage } from './log.js';
import type {
  InboxMessage,
  Priority,
  Room,
  RoomAttachment,
  RoomMessage,
  RoomMessageSource,
} from '../types/index.js';

export interface RoomMessageInput {
  id: string;
  from: string;
  to?: string;
  timestamp: string;
  text: string;
  reply_to?: string | null;
  source: RoomMessageSource;
  priority?: Priority;
  attachments?: RoomAttachment[];
  /** Explicit room. Omit for a 1:1, whose id is derived from from/to. */
  roomId?: string;
}

/** Pure translator: bus inbox envelope -> room input. No I/O. */
export function inboxMessageToRoomInput(msg: InboxMessage): RoomMessageInput {
  return {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    timestamp: msg.timestamp,
    text: msg.text,
    reply_to: msg.reply_to,
    source: 'bus',
    priority: msg.priority,
  };
}

/**
 * Derive the room, index it if it is new, and append one line to its log.
 * Returns the RoomMessage that was written.
 *
 * @throws if the room id is not a safe path segment, or the log is unwritable.
 *   Every caller wraps this — a recording failure must never reach delivery.
 */
export function recordRoomMessage(ctxRoot: string, input: RoomMessageInput): RoomMessage {
  const from = normalizeMember(input.from);
  const to = input.to ? normalizeMember(input.to) : undefined;

  let roomId: string;
  if (input.roomId) {
    roomId = validateRoomId(input.roomId);
  } else {
    if (!to) throw new Error(`recordRoomMessage: message ${input.id} has no room and no recipient`);
    roomId = dmRoomId(from, to);
  }

  if (!getRoom(ctxRoot, roomId)) {
    const room: Room = {
      id: roomId,
      kind: roomId.startsWith('dm-') ? 'dm' : roomId.startsWith('agent-') ? 'agent' : 'channel',
      title: to ? [from, to].sort().join(' ↔ ') : roomId,
      members: to ? [from, to].sort() : [from],
      created_at: input.timestamp,
      created_by: from,
    };
    upsertRoom(ctxRoot, room);
  }

  const reply_to = input.reply_to ?? null;
  const msg: RoomMessage = {
    id: input.id,
    room_id: roomId,
    from,
    ...(to ? { to } : {}),
    timestamp: input.timestamp,
    text: input.text,
    reply_to,
    thread_id: reply_to ?? input.id,
    source: input.source,
    attachments: input.attachments ?? [],
    ...(input.priority ? { priority: input.priority } : {}),
  };

  appendRoomMessage(ctxRoot, msg);
  return msg;
}

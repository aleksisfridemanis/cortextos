/**
 * thread_id inheritance — a chain of replies has ONE root.
 *
 * `thread_id = reply_to ?? id` (what inc1 shipped) re-roots the thread at every
 * hop. These tests pin the inherited form, and pin the two properties a later
 * refactor is most likely to break without any other test noticing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recordRoomMessage } from '../../../src/rooms/record';
import { roomLogPath } from '../../../src/rooms/log';
import type { RoomMessageInput } from '../../../src/rooms/record';

const ROOM = 'dm-boris--nick';

function input(over: Partial<RoomMessageInput> & { id: string }): RoomMessageInput {
  return {
    from: 'boris',
    to: 'nick',
    timestamp: '2026-08-19T10:00:00.000Z',
    text: 'x',
    source: 'bus',
    ...over,
  };
}

describe('resolveThreadId', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-thread-id-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 1
  it('roots a 3-deep chain at one thread_id', () => {
    const a = recordRoomMessage(root, input({ id: 'a', text: 'first' }));
    const b = recordRoomMessage(root, input({ id: 'b', from: 'nick', to: 'boris', text: 'second', reply_to: 'a' }));
    const c = recordRoomMessage(root, input({ id: 'c', text: 'third', reply_to: 'b' }));

    expect(a.thread_id).toBe('a');
    expect(b.thread_id).toBe('a');
    // The case `thread_id = reply_to` gets wrong: without inheritance this is 'b'.
    expect(c.thread_id).toBe('a');
    expect(new Set([a, b, c].map(m => m.thread_id)).size).toBe(1);
  });

  // 2
  it('falls back to reply_to when the parent is not yet recorded', () => {
    const orphan = recordRoomMessage(root, input({ id: 'z', reply_to: 'never-written' }));
    expect(orphan.thread_id).toBe('never-written');

    // and the chain stays together from the orphan onwards
    const child = recordRoomMessage(root, input({ id: 'z2', reply_to: 'z' }));
    expect(child.thread_id).toBe('never-written');
  });

  // 3 PRESERVE+control
  it('roots a message with no reply_to at its own id', () => {
    const m = recordRoomMessage(root, input({ id: 'solo' }));
    expect(m.thread_id).toBe('solo');
    expect(m.reply_to).toBeNull();
  });

  // 4 PRESERVE+control
  it('writes no kind field for a plain message', () => {
    recordRoomMessage(root, input({ id: 'plain' }));

    const line = readFileSync(roomLogPath(root, ROOM), 'utf-8').trim();
    const parsed = JSON.parse(line);
    // Asserted on the ON-DISK object, not the return value: the point is that an
    // inc1 reader sees a line it already understands.
    //
    // Control that reddens this: `kind: input.kind ?? null`. NOT `kind: input.kind`
    // — JSON.stringify drops an undefined property, so that mutation leaves the
    // line byte-identical and the test correctly stays green.
    expect('kind' in parsed).toBe(false);
    expect(line).not.toContain('kind');
  });

  it('writes kind through when the caller sets one', () => {
    const m = recordRoomMessage(root, input({ id: 'run1', kind: 'tool_run' }));
    expect(m.kind).toBe('tool_run');
    expect(JSON.parse(readFileSync(roomLogPath(root, ROOM), 'utf-8').trim()).kind).toBe('tool_run');
  });
});

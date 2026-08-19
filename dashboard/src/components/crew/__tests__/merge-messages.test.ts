import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeMessages, fetchMessagesInto } from '../crew-chat';

interface Msg {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

function msg(id: string, timestamp: string, text = id): Msg {
  return { id, from: 'james', to: 'boris', priority: 'normal', timestamp, text, reply_to: null };
}

describe('mergeMessages', () => {
  it('keeps an unconfirmed echo when a SUCCESSFUL response is empty', () => {
    // NOTE: this is not the blanking guard. This is the empty-but-ok path.
    // The blanking fix lives in fetchMessagesInto and is tested below.
    const local = new Set(['local-1']);
    const prev = [msg('local-1', '2026-08-19T10:00:00Z')];
    expect(mergeMessages(prev, [], local).map(m => m.id)).toEqual(['local-1']);
  });

  it('replaces an optimistic echo with the server copy exactly once', () => {
    const local = new Set(['s1']);
    const prev = [msg('s1', '2026-08-19T10:00:00Z', 'optimistic')];
    const server = [msg('s1', '2026-08-19T10:00:00Z', 'from server')];

    const first = mergeMessages(prev, server, local);
    expect(first).toHaveLength(1);
    expect(first[0].text).toBe('from server');
    // Confirmed: the id is no longer tracked as a pending local echo.
    expect(local.has('s1')).toBe(false);

    // A later poll that has not yet caught up must not resurrect the echo.
    expect(mergeMessages(first, [], local)).toEqual([]);
  });

  it('keeps an unconfirmed local echo alongside server messages', () => {
    const local = new Set(['local-2']);
    const prev = [msg('local-2', '2026-08-19T10:05:00Z', 'just sent')];
    const server = [msg('s1', '2026-08-19T10:00:00Z')];

    expect(mergeMessages(prev, server, local).map(m => m.id)).toEqual(['s1', 'local-2']);
  });

  it('drops previous messages the server no longer lists and we never sent', () => {
    const local = new Set<string>();
    const prev = [msg('ghost', '2026-08-19T10:00:00Z')];
    expect(mergeMessages(prev, [msg('s1', '2026-08-19T10:01:00Z')], local).map(m => m.id))
      .toEqual(['s1']);
  });

  it('sorts the merged result by timestamp', () => {
    const local = new Set(['local-3']);
    const prev = [msg('local-3', '2026-08-19T10:01:00Z', 'my message')];
    const server = [
      msg('s2', '2026-08-19T10:02:00Z'),
      msg('s1', '2026-08-19T10:00:00Z'),
    ];

    // The agent's reply (s2) arrived after our echo (local-3) was queued, so
    // appending pending after server would have put them out of order.
    expect(mergeMessages(prev, server, local).map(m => m.id)).toEqual(['s1', 'local-3', 's2']);
  });

  it('collapses a duplicated id in the server payload', () => {
    const local = new Set<string>();
    const server = [msg('d1', '2026-08-19T10:00:00Z', 'first'), msg('d1', '2026-08-19T10:00:00Z', 'second')];
    const merged = mergeMessages([], server, local);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('first');
  });
});

describe('fetchMessagesInto — the blanking guard', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function stubFetch(response: { ok: boolean; body?: unknown }) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: response.ok,
      json: async () => response.body,
    }) as unknown as typeof fetch;
  }

  it('does not touch the thread when the response is not ok', async () => {
    // AC3: force the message fetch to fail; the thread MUST retain what it has.
    // Asserted on the post-state of the setter, not on the DOM: setMessages is
    // the only way this code can change what is rendered.
    stubFetch({ ok: false, body: [] });
    const setMessages = vi.fn();
    const setLoading = vi.fn();

    await fetchMessagesInto('boris--james', setMessages, setLoading, new Set());

    expect(setMessages).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it('does not touch the thread when the body is not an array', async () => {
    stubFetch({ ok: true, body: { error: 'boom' } });
    const setMessages = vi.fn();

    await fetchMessagesInto('boris--james', setMessages, vi.fn(), new Set());

    expect(setMessages).not.toHaveBeenCalled();
  });

  it('does not touch the thread when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const setMessages = vi.fn();
    const setLoading = vi.fn();

    await fetchMessagesInto('boris--james', setMessages, setLoading, new Set());

    expect(setMessages).not.toHaveBeenCalled();
    expect(setLoading).toHaveBeenCalledWith(false);
  });

  it('DOES apply an ok array response (positive control)', async () => {
    // Without this, the three assertions above are satisfied by a function
    // that never applies anything at all.
    stubFetch({ ok: true, body: [msg('s1', '2026-08-19T10:00:00Z')] });
    const setMessages = vi.fn();

    await fetchMessagesInto('boris--james', setMessages, vi.fn(), new Set());

    expect(setMessages).toHaveBeenCalledTimes(1);
    const updater = setMessages.mock.calls[0][0] as (prev: Msg[]) => Msg[];
    expect(updater([]).map(m => m.id)).toEqual(['s1']);
  });
});

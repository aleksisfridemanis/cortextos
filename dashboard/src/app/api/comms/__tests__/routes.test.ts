/**
 * Tests for the Comms Hub API routes.
 *
 * Each test spins up a fresh temp CTX_ROOT, seeds it with a minimal set
 * of agent registry + message history + inbox files, then invokes the
 * route handler directly and asserts on the Response.
 *
 * We set CTX_ROOT + ADMIN_USERNAME before importing the handlers so the
 * route modules pick them up at evaluation time.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { appendRoomMessage } from '../../../../../../src/rooms/log';
import type { RoomMessage } from '../../../../../../src/types';

vi.mock('@/lib/work-session-owner', () => ({
  authenticatedWorkSessionOwner: vi.fn(async () => 'owner:test'),
  ownsWorkSessionRoom: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Global setup — one shared tmp root across all tests in this file.
// Each test isolates itself by writing into its own subpath or clearing files.
// ---------------------------------------------------------------------------
const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-routes-'));
process.env.CTX_ROOT = rootTmp;
process.env.ADMIN_USERNAME = 'james';
process.env.AUTH_SECRET = 'comms-test-cleanup-secret';

// Dynamic imports AFTER env vars are set.
type FeedRoute = typeof import('../feed/route');
type ChannelsRoute = typeof import('../channels/route');
type ChannelRoute = typeof import('../channel/[pair]/route');
type UploadRoute = typeof import('../upload/route');

let feed: FeedRoute;
let channels: ChannelsRoute;
let channel: ChannelRoute;
let upload: UploadRoute;

beforeAll(async () => {
  feed = await import('../feed/route');
  channels = await import('../channels/route');
  channel = await import('../channel/[pair]/route');
  upload = await import('../upload/route');
});

afterAll(() => {
  try { fs.rmSync(rootTmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Wipe and re-seed CTX_ROOT before each test so state does not leak.
beforeEach(() => {
  for (const entry of fs.readdirSync(rootTmp)) {
    fs.rmSync(path.join(rootTmp, entry), { recursive: true, force: true });
  }
  // Always seed an empty enabled-agents.json so resolveIdentity has agents.
  fs.mkdirSync(path.join(rootTmp, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(rootTmp, 'config', 'enabled-agents.json'),
    JSON.stringify({ boris: {}, nick: {} }),
  );
  // Empty inbox base exists so the "no inboxBase" short-circuit doesn't fire.
  fs.mkdirSync(path.join(rootTmp, 'inbox'), { recursive: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeHistory(messages: Array<Record<string, unknown>>) {
  const logDir = path.join(rootTmp, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, 'message-history.jsonl'), lines);
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'));
}

/** Write a raw bus message file into one of the flat per-agent queues. */
function writeQueueMessage(
  queue: 'inbox' | 'inflight' | 'processed',
  agent: string,
  msg: Record<string, unknown>,
) {
  const dir = path.join(rootTmp, queue, agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2-${msg.id}.json`), JSON.stringify(msg));
}

/** Append entries to an agent's Telegram-style inbound/outbound JSONL. */
function writeAgentLog(
  agent: string,
  file: 'inbound-messages.jsonl' | 'outbound-messages.jsonl',
  entries: Array<Record<string, unknown>>,
) {
  const dir = path.join(rootTmp, 'logs', agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

/**
 * Seed a canonical room log through the REAL daemon-side writer, not a
 * hand-rolled JSON dump. This is what makes the route's read-only
 * reimplementation (dashboard/src/lib/rooms.ts) a conformance check rather
 * than a second guess: if the two ever disagree on layout or admission rules,
 * these tests break.
 */
function writeRoomLog(roomId: string, messages: Array<Record<string, unknown>>) {
  for (const m of messages) {
    appendRoomMessage(rootTmp, m as unknown as RoomMessage);
  }
}

// ---------------------------------------------------------------------------
// GET /api/comms/feed
// ---------------------------------------------------------------------------
describe('GET /api/comms/feed', () => {
  it('returns messages from history log sorted newest-first', async () => {
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2026-04-15T09:00:00Z', text: 'hello', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: '2026-04-15T10:00:00Z', text: 'world', reply_to: null },
    ]);

    const res = await feed.GET(makeRequest('/api/comms/feed'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('m2'); // newest first
    expect(data[1].id).toBe('m1');
  });

  it('returns an empty array when there is no inbox directory', async () => {
    // Wipe the inbox dir seeded by beforeEach to hit the short-circuit.
    fs.rmSync(path.join(rootTmp, 'inbox'), { recursive: true, force: true });

    const res = await feed.GET(makeRequest('/api/comms/feed'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it('applies the search filter to message text', async () => {
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2026-04-15T09:00:00Z', text: 'hello world', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: '2026-04-15T10:00:00Z', text: 'unrelated', reply_to: null },
    ]);

    const res = await feed.GET(makeRequest('/api/comms/feed?search=hello'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('m1');
  });
});

// ---------------------------------------------------------------------------
// GET /api/comms/channels
// ---------------------------------------------------------------------------
describe('GET /api/comms/channels', () => {
  it('groups messages by pair and reports last-message metadata', async () => {
    const t1 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: t1, text: 'hi', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: t2, text: 'reply', reply_to: null },
    ]);

    const res = await channels.GET(makeRequest('/api/comms/channels'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].pair).toBe('boris--nick');
    expect(data[0].message_count).toBe(2);
    expect(data[0].last_message.from).toBe('nick');
    expect(data[0].archived).toBe(false);
  });

  it('hides channels older than the archive threshold by default', async () => {
    writeHistory([
      { id: 'old', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2020-01-01T00:00:00Z', text: 'ancient', reply_to: null },
    ]);

    const defaultRes = await channels.GET(makeRequest('/api/comms/channels'));
    expect(await defaultRes.json()).toEqual([]);

    const includeRes = await channels.GET(makeRequest('/api/comms/channels?include_archived=true'));
    const data = await includeRes.json();
    expect(data).toHaveLength(1);
    expect(data[0].archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/comms/channel/[pair]
// ---------------------------------------------------------------------------
describe('GET /api/comms/channel/[pair]', () => {
  it('returns only messages matching the pair, oldest-first', async () => {
    writeHistory([
      { id: 'm1', from: 'boris', to: 'nick', priority: 'normal', timestamp: '2026-04-15T09:00:00Z', text: 'first', reply_to: null },
      { id: 'm2', from: 'nick', to: 'boris', priority: 'normal', timestamp: '2026-04-15T10:00:00Z', text: 'second', reply_to: null },
      { id: 'm3', from: 'boris', to: 'james', priority: 'normal', timestamp: '2026-04-15T11:00:00Z', text: 'other pair', reply_to: null },
    ]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('m1');
    expect(data[1].id).toBe('m2');
  });

  it('rejects malformed pair strings with a 400', async () => {
    // "only-one-side" has no `--` separator.
    const res = await channel.GET(
      makeRequest('/api/comms/channel/only-one-side'),
      { params: Promise.resolve({ pair: 'only-one-side' }) },
    );
    expect(res.status).toBe(400);

    // Uppercase / special chars should also be rejected.
    const res2 = await channel.GET(
      makeRequest('/api/comms/channel/Boris--NICK'),
      { params: Promise.resolve({ pair: 'Boris--NICK' }) },
    );
    expect(res2.status).toBe(400);
  });

  // A dashboard-sent message exists TWICE on disk: once as the inbox file the
  // agent consumes, and once as an inbound-messages.jsonl entry carrying the
  // same `id` but no `message_id`. The Telegram synthesis path used to ignore
  // `id` and mint `tg-in-<agent>-<timestamp>`, which can never collide with
  // the inbox id — so the same message rendered twice.
  it('renders a dashboard-sent message once, not twice', async () => {
    const ts = '2026-04-15T09:00:00.000Z';
    writeQueueMessage('inbox', 'boris', {
      id: '1755600000000-james-abcde',
      from: 'james',
      to: 'boris',
      priority: 'normal',
      timestamp: ts,
      text: 'hello from the dashboard',
      reply_to: null,
    });
    writeAgentLog('boris', 'inbound-messages.jsonl', [{
      id: '1755600000000-james-abcde',
      timestamp: ts,
      agent: 'boris',
      direction: 'inbound',
      type: 'text',
      text: 'hello from the dashboard',
      from_name: 'james',
      source: 'dashboard',
    }]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--james'),
      { params: Promise.resolve({ pair: 'boris--james' }) },
    );
    const data = await res.json();
    expect(data.filter((m: { text: string }) => m.text === 'hello from the dashboard')).toHaveLength(1);
    expect(data).toHaveLength(1);
  });

  // Positive control for the test above: a REAL Telegram entry has no `id`,
  // so it must still be synthesized from message_id and rendered.
  it('still synthesizes an id for a real Telegram entry that has none', async () => {
    writeAgentLog('boris', 'inbound-messages.jsonl', [{
      message_id: 42,
      from_name: 'james',
      chat_id: 1,
      text: 'sent from Telegram',
      timestamp: '2026-04-15T09:00:00.000Z',
    }]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--james'),
      { params: Promise.resolve({ pair: 'boris--james' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tg-in-boris-42');
    expect(data[0].text).toBe('sent from Telegram');
  });

  // Agent↔agent bus messages live in <ctxRoot>/{processed,inflight}/<agent>,
  // NOT <ctxRoot>/inbox/<agent>/{processed,inflight}. Scanning the wrong base
  // made them vanish from the channel ~1s after send, as soon as the
  // fast-checker moved them out of the inbox.
  it('finds messages that have already moved to processed/inflight', async () => {
    // No inbox/ at all: the sibling queues must still be scanned.
    fs.rmSync(path.join(rootTmp, 'inbox'), { recursive: true, force: true });
    writeQueueMessage('processed', 'boris', {
      id: 'p1',
      from: 'boris',
      to: 'nick',
      priority: 'normal',
      timestamp: '2026-04-15T09:00:00Z',
      text: 'already acked',
      reply_to: null,
    });
    writeQueueMessage('inflight', 'nick', {
      id: 'f1',
      from: 'nick',
      to: 'boris',
      priority: 'normal',
      timestamp: '2026-04-15T10:00:00Z',
      text: 'mid-delivery',
      reply_to: null,
    });

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    const data = await res.json();
    expect(data.map((m: { id: string }) => m.id)).toEqual(['p1', 'f1']);
  });

  it('serves the canonical room log and does not double it against its inbox twin', async () => {
    writeRoomLog('dm-boris--nick', [{
      id: 'r1',
      room_id: 'dm-boris--nick',
      from: 'boris',
      to: 'nick',
      timestamp: '2026-04-15T09:00:00Z',
      text: 'canonical',
      reply_to: null,
      thread_id: 'r1',
      source: 'bus',
      attachments: [],
      priority: 'normal',
    }]);
    // The same message, still sitting in the queue it was delivered through.
    writeQueueMessage('processed', 'boris', {
      id: 'r1',
      from: 'boris',
      to: 'nick',
      priority: 'normal',
      timestamp: '2026-04-15T09:00:00Z',
      text: 'canonical',
      reply_to: null,
    });

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('r1');
    expect(data[0].text).toBe('canonical');
  });

  // TC2 discriminator: this case has NO queue or JSONL twin, so it can only
  // pass if the route actually reads the canonical room log. The "does not
  // double it against its inbox twin" test below is satisfied by the queue
  // fallback alone and proves nothing on its own.
  it('renders a message that exists ONLY in the room log', async () => {
    writeRoomLog('dm-boris--nick', [{
      id: 'only1', room_id: 'dm-boris--nick', from: 'boris', to: 'nick',
      timestamp: '2026-04-15T09:00:00Z', text: 'room-log only', reply_to: null,
      thread_id: 'only1', source: 'bus', attachments: [],
    }]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('only1');
    expect(data[0].text).toBe('room-log only');
  });

  // The bus envelope has no media_type, so the room log cannot carry it. The
  // room log claims the id first, so without enrichment the mic indicator
  // disappears the moment the daemon records a dashboard voice message.
  it('keeps media_type and local_file from the queue copy of a recorded message', async () => {
    writeRoomLog('dm-boris--james', [{
      id: 'v1', room_id: 'dm-boris--james', from: 'james', to: 'boris',
      timestamp: '2026-04-15T09:00:00Z', text: 'spoken words', reply_to: null,
      thread_id: 'v1', source: 'bus', attachments: [],
    }]);
    writeQueueMessage('processed', 'boris', {
      id: 'v1',
      from: 'james',
      to: 'boris',
      priority: 'normal',
      timestamp: '2026-04-15T09:00:00Z',
      text: 'spoken words',
      reply_to: null,
      media_type: 'voice',
      local_file: '/tmp/v1.webm',
    });

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--james'),
      { params: Promise.resolve({ pair: 'boris--james' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].media_type).toBe('voice');
    expect(data[0].local_file).toBe('/tmp/v1.webm');
  });

  // 15
  it('carries thread_id and kind through from the room log', async () => {
    writeRoomLog('dm-boris--nick', [
      {
        id: 'run-1', room_id: 'dm-boris--nick', from: 'boris', to: 'nick',
        timestamp: '2026-04-15T09:00:00Z', text: 'deploy', reply_to: null,
        thread_id: 'run-1', source: 'bus', attachments: [], kind: 'tool_run',
      },
      {
        id: 's0', room_id: 'dm-boris--nick', from: 'boris', to: 'nick',
        timestamp: '2026-04-15T09:00:01Z', text: 'build', reply_to: 'run-1',
        thread_id: 'run-1', source: 'bus', attachments: [], kind: 'tool_step',
      },
    ]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data.map((m: Record<string, unknown>) => m.kind)).toEqual(['tool_run', 'tool_step']);
    expect(data.map((m: Record<string, unknown>) => m.thread_id)).toEqual(['run-1', 'run-1']);
  });

  // 16 PRESERVE+control
  it('still renders an inc1 room-log line that has no kind', async () => {
    writeRoomLog('dm-boris--nick', [{
      id: 'inc1', room_id: 'dm-boris--nick', from: 'boris', to: 'nick',
      timestamp: '2026-04-15T09:00:00Z', text: 'written before inc2', reply_to: null,
      thread_id: 'inc1', source: 'bus', attachments: [],
    }]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].text).toBe('written before inc2');
    // Absent, not null — the UI branches on falsiness of `kind`.
    expect(data[0].kind).toBeUndefined();
  });

  // 17 — DOCUMENTS a known limitation, deliberately not fixed.
  it('limit truncation can separate a run root from its steps', async () => {
    writeRoomLog('dm-boris--nick', [
      {
        id: 'run-1', room_id: 'dm-boris--nick', from: 'boris', to: 'nick',
        timestamp: '2026-04-15T09:00:00Z', text: 'deploy', reply_to: null,
        thread_id: 'run-1', source: 'bus', attachments: [], kind: 'tool_run',
      },
      {
        id: 's0', room_id: 'dm-boris--nick', from: 'boris', to: 'nick',
        timestamp: '2026-04-15T09:00:01Z', text: 'build', reply_to: 'run-1',
        thread_id: 'run-1', source: 'bus', attachments: [], kind: 'tool_step',
      },
    ]);

    // limit slices the TAIL, so the root falls off and the step survives.
    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick?limit=1'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('s0');
    // The client folds this into a run row with a null root and the run's
    // label falls back to a generic one. Accepted: pagination is the fix, and
    // it is out of scope for this increment.
    expect(data.some((m: Record<string, unknown>) => m.kind === 'tool_run')).toBe(false);
  });

  it('does not render an empty-text room log entry', async () => {
    writeRoomLog('dm-boris--nick', [{
      id: 'stub',
      room_id: 'dm-boris--nick',
      from: 'boris',
      to: 'nick',
      timestamp: '2026-04-15T09:00:00Z',
      text: '',
      reply_to: null,
      thread_id: 'stub',
      source: 'telegram',
      attachments: [],
    }]);

    const res = await channel.GET(
      makeRequest('/api/comms/channel/boris--nick'),
      { params: Promise.resolve({ pair: 'boris--nick' }) },
    );
    expect(await res.json()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/comms/upload
// ---------------------------------------------------------------------------
describe('POST /api/comms/upload', () => {
  /** Build a POST request carrying a single-file multipart body. */
  function uploadRequest(file: File): NextRequest {
    const form = new FormData();
    form.append('file', file);
    return new NextRequest(new URL('http://localhost/api/comms/upload'), {
      method: 'POST',
      body: form,
    });
  }

  it('writes a PNG into media/dashboard-uploads and returns its URL', async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], 'shot.png', {
      type: 'image/png',
    });

    const res = await upload.POST(uploadRequest(png));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.path.startsWith('media/dashboard-uploads/')).toBe(true);
    expect(data.url.startsWith('/api/media/media/dashboard-uploads/')).toBe(true);
    expect(data.filename.endsWith('.png')).toBe(true);

    const absPath = path.join(rootTmp, data.path);
    expect(fs.existsSync(absPath)).toBe(true);
  });

  it('publishes concurrent same-name uploads to distinct exclusive identities', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    const [left, right] = await Promise.all([
      upload.POST(uploadRequest(new File([bytes], 'same.png', { type: 'image/png' }))),
      upload.POST(uploadRequest(new File([bytes], 'same.png', { type: 'image/png' }))),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    const [a, b] = await Promise.all([left.json(), right.json()]);
    expect(a.path).not.toBe(b.path);
    expect(fs.readFileSync(path.join(rootTmp, a.path))).toEqual(Buffer.from(bytes));
    expect(fs.readFileSync(path.join(rootTmp, b.path))).toEqual(Buffer.from(bytes));
    expect(fs.readdirSync(path.join(rootTmp, 'media', 'dashboard-uploads')).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('deletes an unreferenced upload only with its returned cleanup capability', async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], 'orphan.png', { type: 'image/png' });
    const uploaded = await (await upload.POST(uploadRequest(png))).json();
    const cleanupRequest = new NextRequest(new URL('http://localhost/api/comms/upload'), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-cortext-intent': 'cleanup-chat-uploads' },
      body: JSON.stringify({ uploads: [{ url: uploaded.url, cleanup_token: uploaded.cleanup_token }] }),
    });
    expect((await upload.DELETE(cleanupRequest)).status).toBe(200);
    expect(fs.existsSync(path.join(rootTmp, uploaded.path))).toBe(false);
  });

  it('rejects unsupported MIME types (including SVG)', async () => {
    // SVG is now explicitly disallowed because it can carry inline <script>.
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'evil.svg', {
      type: 'image/svg+xml',
    });
    const svgRes = await upload.POST(uploadRequest(svg));
    expect(svgRes.status).toBe(400);

    const html = new File(['<html></html>'], 'page.html', { type: 'text/html' });
    const htmlRes = await upload.POST(uploadRequest(html));
    expect(htmlRes.status).toBe(400);
  });

  it('forces the server-chosen extension regardless of the uploaded filename', async () => {
    // Attacker attempts to smuggle an HTML-looking filename through a png MIME.
    const png = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], '../../evil.html', {
      type: 'image/png',
    });
    const res = await upload.POST(uploadRequest(png));
    expect(res.status).toBe(200);
    const data = await res.json();

    // Extension must be the MIME-derived .png, NOT .html.
    expect(data.filename.endsWith('.png')).toBe(true);
    expect(data.filename.includes('..')).toBe(false);
    expect(data.filename.includes('/')).toBe(false);

    // And the file must live inside the intended upload dir, not above it.
    const absPath = path.resolve(rootTmp, data.path);
    const uploadDir = path.resolve(rootTmp, 'media', 'dashboard-uploads');
    expect(absPath.startsWith(uploadDir + path.sep)).toBe(true);
  });

  it('rejects files over 10MB', async () => {
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.png', {
      type: 'image/png',
    });
    const res = await upload.POST(uploadRequest(big));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(String(data.error).toLowerCase()).toContain('too large');
  });

  it('accepts the same valid multipart upload in one body-sized stream chunk', async () => {
    const boundary = 'cortext-boundary';
    const bytes = Buffer.alloc(100 * 1024, 0x61);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await upload.POST(new NextRequest('http://localhost/api/comms/upload', {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
    }));
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(fs.readFileSync(path.join(rootTmp, saved.path))).toEqual(bytes);
  });

  it('parses the same multipart bytes across arbitrary transport chunk boundaries', async () => {
    const boundary = 'chunk-independent';
    const bytes = Buffer.from('exact-image-bytes');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="split.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) return controller.close();
        const size = (offset % 7) + 1;
        controller.enqueue(body.subarray(offset, Math.min(body.length, offset + size)));
        offset += size;
      },
    });
    const res = await upload.POST(new NextRequest('http://localhost/api/comms/upload', {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: stream,
    }));
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(rootTmp, (await res.json()).path))).toEqual(bytes);
  });

  it('keeps false boundary prefixes as file bytes and caps the whole request', async () => {
    const boundary = 'probe-boundary';
    const bytes = Buffer.from(`png\r\n--${boundary}Xstill-data`);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const accepted = await upload.POST(new NextRequest('http://localhost/api/comms/upload', {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
    }));
    expect(accepted.status).toBe(200);
    expect(fs.readFileSync(path.join(rootTmp, (await accepted.json()).path))).toEqual(bytes);

    const oversized = Buffer.concat([body, Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    const rejected = await upload.POST(new NextRequest('http://localhost/api/comms/upload', {
      method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: oversized,
    }));
    expect(rejected.status).toBe(400);
  });

  it('reaps expired unreferenced finals but preserves durable room references', async () => {
    const first = await (await upload.POST(uploadRequest(new File(['one'], 'one.png', { type: 'image/png' })))).json();
    const second = await (await upload.POST(uploadRequest(new File(['two'], 'two.png', { type: 'image/png' })))).json();
    writeRoomLog('room-upload', [{ id: 'm1', room_id: 'room-upload', from: 'ws-one', to: 'owner:test', text: second.url, timestamp: new Date().toISOString() }]);
    const dir = path.join(rootTmp, 'media', 'dashboard-uploads');
    expect(upload.sweepStaleUploads(dir, rootTmp, Date.now() + 2 * 60 * 60 * 1000)).toBe(1);
    expect(fs.existsSync(path.join(rootTmp, first.path))).toBe(false);
    expect(fs.existsSync(path.join(rootTmp, second.path))).toBe(true);
  });

  it('leaves malformed upload leases untouched and cannot traverse outside the upload directory', async () => {
    const uploaded = await (await upload.POST(uploadRequest(new File(['one'], 'one.png', { type: 'image/png' })))).json();
    const dir = path.join(rootTmp, 'media', 'dashboard-uploads');
    const uuid = uploaded.filename.slice(0, 36);
    const leasePath = path.join(dir, `.upload-lease-${uuid}.json`);
    const original = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    const outside = path.join(rootTmp, 'must-remain.txt');
    fs.writeFileSync(outside, 'keep');

    for (const corrupt of [
      { ...original, filename: `../${path.basename(outside)}` },
      { ...original, filename: `11111111-1111-4111-8111-111111111111-one.png` },
      { ...original, url: '/api/media/media/dashboard-uploads/not-the-file.png' },
      { ...original, expires_at: 'not-a-date' },
    ]) {
      fs.writeFileSync(leasePath, JSON.stringify(corrupt));
      expect(upload.sweepStaleUploads(dir, rootTmp, Date.now() + 2 * 60 * 60 * 1000)).toBe(0);
      expect(fs.existsSync(leasePath)).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);
      expect(fs.existsSync(path.join(rootTmp, uploaded.path))).toBe(true);
    }
  });

  it('sweeps only old validated upload temp identities', () => {
    const dir = path.join(rootTmp, 'media', 'dashboard-uploads');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, '.upload-11111111-1111-4111-8111-111111111111.tmp');
    const unrelated = path.join(dir, '.upload-not-a-uuid.tmp');
    fs.writeFileSync(stale, 'stale');
    fs.writeFileSync(unrelated, 'keep');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    expect(upload.sweepStaleUploadTemps(dir)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

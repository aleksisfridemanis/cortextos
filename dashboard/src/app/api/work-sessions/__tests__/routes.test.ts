import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { browseHostDirectory } from '@/lib/host-paths';

const authMock = vi.fn(async () => ({ user: { id: '42' } }));
const sendMock = vi.fn(async () => ({ success: true, data: { session: { id: 'ws-one' } } }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/ipc-client', () => ({ IPCClient: class { send = sendMock; } }));
vi.mock('@/lib/rate-limit', () => ({ checkCrewRateLimit: () => ({ allowed: true }) }));

const root = mkdtempSync(join(tmpdir(), 'cortext-browse-route-'));
process.env.CTX_ROOT = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/work-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cortext-intent': 'create-work-session', 'x-cortext-mutation-id': '11111111-1111-4111-8111-111111111111', ...headers },
    body: JSON.stringify(body),
  });
}

function exactBodyRequest(size: number) {
  const body = { display_name: 'x', org: 'platform', harness: 'codex-app-server', requested_cwd: root, padding: '' };
  const empty = JSON.stringify(body);
  body.padding = 'p'.repeat(size - Buffer.byteLength(empty));
  const raw = JSON.stringify(body);
  expect(Buffer.byteLength(raw)).toBe(size);
  return new NextRequest('http://localhost/api/work-sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cortext-intent': 'create-work-session',
      'x-cortext-mutation-id': '11111111-1111-4111-8111-111111111111',
    },
    body: raw,
  });
}

describe('Work Session routes', () => {
  beforeEach(() => { authMock.mockResolvedValue({ user: { id: '42' } }); sendMock.mockClear(); });

  it('derives the actor and never accepts a client resume handle', async () => {
    const { POST } = await import('../route');
    const response = await POST(request({ display_name: 'release', org: 'platform', harness: 'codex-app-server', requested_cwd: root }));
    expect(response.status).toBe(201);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'create-work-session', mutation_id: '11111111-1111-4111-8111-111111111111',
      data: expect.objectContaining({ actor: 'owner:42', requested_cwd: root }),
    }));
    expect((await POST(request({ display_name: 'x', harness: 'codex', requested_cwd: root, resume_handle: 'forged' }))).status).toBe(400);
  });

  it('exposes resumability without exposing the native continuation handle', async () => {
    const { publicWorkSession } = await import('../route');
    expect(publicWorkSession({ lifecycle: 'archived', resume_handle: { thread_id: 'secret-thread' }, runtime_owner: { pid: 42, started_at: 'private', mutation_id: 'private' }, requested_cwd: '/private' }))
      .toEqual({ lifecycle: 'archived', resumable: true });
    expect(publicWorkSession({ lifecycle: 'failed', resume_handle: null }))
      .toEqual({ lifecycle: 'failed', resumable: false });
    expect(publicWorkSession({ lifecycle: 'starting', resume_handle: { thread_id: 'secret-thread' } }))
      .toEqual({ lifecycle: 'starting', resumable: false });
  });

  it('binds list reads to the authenticated owner', async () => {
    const { GET } = await import('../route');
    expect((await GET()).status).toBe(200);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'list-work-sessions', data: { actor: 'owner:42' },
    }));
  });

  it('rejects unauthenticated and oversized create requests', async () => {
    const { POST } = await import('../route');
    authMock.mockResolvedValueOnce(null as never);
    expect((await POST(request({}))).status).toBe(401);
    expect((await POST(request({}, { 'content-length': '131073' }))).status).toBe(413);
  });

  it('accepts 131,072 body bytes and rejects 131,073 decoded body bytes', async () => {
    const { POST } = await import('../route');
    expect((await POST(exactBodyRequest(131_072))).status).toBe(201);
    expect((await POST(exactBodyRequest(131_073))).status).toBe(413);
  });

  it('returns 413 for oversized lifecycle requests', async () => {
    const { POST } = await import('../[id]/route');
    const oversized = request({ action: 'stop' }, {
      'content-length': '131073',
      'x-cortext-intent': 'stop-work-session',
    });
    expect((await POST(oversized, { params: Promise.resolve({ id: 'ws-one' }) })).status).toBe(413);
  });

  it.each(['RECOVERY_REQUIRED', 'MUTATION_PENDING'])('maps %s lifecycle recovery to 503', async code => {
    const { POST } = await import('../[id]/route');
    sendMock.mockResolvedValueOnce({ success: false, code } as never);
    const response = await POST(request({ action: 'resume' }, {
      'x-cortext-intent': 'resume-work-session',
    }), { params: Promise.resolve({ id: 'ws-one' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code });
  });

  it('maps cross-owner lifecycle rejection to 403', async () => {
    const { POST } = await import('../[id]/route');
    sendMock.mockResolvedValueOnce({ success: false, code: 'FORBIDDEN' } as never);
    const response = await POST(request({ action: 'stop' }, {
      'x-cortext-intent': 'stop-work-session',
    }), { params: Promise.resolve({ id: 'ws-one' }) });
    expect(response.status).toBe(403);
  });
});

describe('Work Session message route', () => {
  it('accepts 65,536 UTF-8 bytes, rejects 65,537, and surfaces archived conflict', async () => {
    const { POST } = await import('../../messages/send/route');
    const send = (text: string) => new NextRequest('http://localhost/api/messages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cortext-mutation-id': '22222222-2222-4222-8222-222222222222' },
      body: JSON.stringify({ target_kind: 'work_session', work_session_id: 'ws-one', text }),
    });
    expect((await POST(send('x'.repeat(65_536)))).status).toBe(200);
    expect((await POST(send('x'.repeat(65_537)))).status).toBe(413);
    sendMock.mockResolvedValueOnce({ success: false, code: 'INVALID_TRANSITION' } as never);
    expect((await POST(send('resume me'))).status).toBe(409);
  });
});

describe('fixed actor rate buckets', () => {
  it.each([
    ['lifecycle', 20],
    ['message', 60],
    ['browse', 60],
  ] as const)('enforces the %s boundary, isolates actors, and resets at 60 seconds', async (bucket, maximum) => {
    const { checkCrewRateLimit } = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
    const start = 10_000;
    const actor = `owner:boundary-${bucket}`;
    for (let index = 0; index < maximum; index++) expect(checkCrewRateLimit(actor, bucket, start).allowed).toBe(true);
    expect(checkCrewRateLimit(actor, bucket, start).allowed).toBe(false);
    expect(checkCrewRateLimit(`${actor}-other`, bucket, start).allowed).toBe(true);
    expect(checkCrewRateLimit(actor, bucket, start + 60_000).allowed).toBe(true);
  });
});

describe('metadata-only host browsing', () => {
  it('sorts directories first, warns on symlinks, and pages with an opaque bound cursor', () => {
    const dir = join(root, 'browse');
    mkdirSync(join(dir, 'b-dir'), { recursive: true });
    mkdirSync(join(dir, 'a-dir'), { recursive: true });
    writeFileSync(join(dir, 'a-file'), 'private contents never returned');
    symlinkSync(join(dir, 'a-dir'), join(dir, 'link-dir'));
    const first = browseHostDirectory(dir, { limit: 2, secret: 'strong-test-secret' });
    expect(first.entries.map(entry => entry.name)).toEqual(['a-dir', 'b-dir']);
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const second = browseHostDirectory(dir, { limit: 2000, cursor: first.next_cursor!, secret: 'strong-test-secret' });
    expect(second.entries.map(entry => entry.name)).toEqual(['link-dir', 'a-file']);
    expect(second.entries.find(entry => entry.name === 'link-dir')?.warning).toBe('symlink');
    expect(JSON.stringify([...first.entries, ...second.entries])).not.toContain('private contents');
    expect(() => browseHostDirectory(root, { cursor: first.next_cursor!, secret: 'strong-test-secret' })).toThrow('CURSOR_DIRECTORY_MISMATCH');
  });

  it('requires an absolute readable directory', () => {
    expect(() => browseHostDirectory('relative', { secret: 'x' })).toThrow('PATH_NOT_ABSOLUTE');
    expect(() => browseHostDirectory(join(root, 'missing'), { secret: 'x' })).toThrow('PATH_UNAVAILABLE');
  });
});

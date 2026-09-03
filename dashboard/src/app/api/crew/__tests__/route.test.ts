import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authMock = vi.fn();
const sendMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/config', () => ({ getCTXRoot: () => '/nonexistent/crew-test' }));
vi.mock('@/lib/comms-identity', () => ({ resolveIdentity: () => ({ canonicalUser: 'display-admin' }) }));
vi.mock('@/lib/rooms', () => ({ readPairSummary: () => ({ lastActivity: null, lastPreview: null }), readRoomLog: () => [] }));
vi.mock('@/lib/crew-avatars', () => ({ findAvatarFile: () => null }));
vi.mock('@/lib/ipc-client', () => ({ IPCClient: class { send = sendMock; } }));
vi.mock('@/lib/rate-limit', () => ({ checkCrewRateLimit: () => ({ allowed: true }) }));

describe('Crew roster Work Session ownership', () => {
  beforeEach(() => {
    authMock.mockReset();
    sendMock.mockReset().mockResolvedValue({ success: true, data: [] });
  });

  it.each(['1', '42'])('uses authenticated database user %s for both create and roster reload', async userId => {
    authMock.mockResolvedValue({ user: { id: userId } });
    sendMock.mockResolvedValueOnce({ success: true, data: { session: { id: `ws-${userId}` } } });
    const { POST } = await import('../../work-sessions/route');
    const create = new NextRequest('http://localhost/api/work-sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cortext-intent': 'create-work-session',
        'x-cortext-mutation-id': '11111111-1111-4111-8111-111111111111',
      },
      body: JSON.stringify({ display_name: 'Exact owner', org: 'platform', harness: 'codex-app-server', requested_cwd: '/tmp' }),
    });
    expect((await POST(create)).status).toBe(201);
    const { GET } = await import('../route');
    expect((await GET()).status).toBe(200);
    expect(sendMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'create-work-session', data: expect.objectContaining({ actor: `owner:${userId}` }),
    }));
    expect(sendMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'list-work-sessions', data: { actor: `owner:${userId}` },
    }));
  });

  it('rejects an unauthenticated roster read before IPC access', async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import('../route');
    expect((await GET()).status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

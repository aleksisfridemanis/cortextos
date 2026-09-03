import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ user: { id: '42' } })),
  rate: vi.fn(() => ({ allowed: true as boolean, retryAfter: undefined as number | undefined })),
  send: vi.fn(async () => ({ success: true, data: { status: 'created' } })),
}));

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/rate-limit', () => ({ checkCrewRateLimit: mocks.rate }));
vi.mock('@/lib/ipc-client', () => ({ IPCClient: class { send = mocks.send; } }));
vi.mock('@/lib/config', () => ({ getAllAgents: () => [] }));
vi.mock('@/lib/data/heartbeats', () => ({ getHeartbeat: vi.fn(), getHealthStatus: vi.fn() }));

function request() {
  return new NextRequest('http://localhost/api/agents', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cortext-intent': 'create-employee',
      'x-cortext-mutation-id': '11111111-1111-4111-8111-111111111111',
    },
    body: JSON.stringify({ name: 'ada', org: 'platform', runtime: 'claude-code', telegram_polling: false }),
  });
}

describe('Employee creation route rate limit', () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ user: { id: '42' } });
    mocks.rate.mockReturnValue({ allowed: true, retryAfter: undefined });
    mocks.send.mockClear();
  });

  it('charges the authenticated owner lifecycle bucket before dispatch', async () => {
    const { POST } = await import('../route');
    expect((await POST(request())).status).toBe(201);
    expect(mocks.rate).toHaveBeenCalledWith('owner:42', 'lifecycle');
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it('returns the shared Retry-After contract and does not dispatch when limited', async () => {
    mocks.rate.mockReturnValueOnce({ allowed: false, retryAfter: 17 });
    const { POST } = await import('../route');
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(await response.json()).toEqual({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(['MUTATION_OUTCOME_UNKNOWN', 'MUTATION_PENDING', 'RECOVERY_REQUIRED'])('returns retryable %s with the original mutation id', async code => {
    mocks.send.mockResolvedValueOnce({ success: false, code, error: 'pending' } as never);
    const { POST } = await import('../route');
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code, mutation_id: '11111111-1111-4111-8111-111111111111' });
  });
});

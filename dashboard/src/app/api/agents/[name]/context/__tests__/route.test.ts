import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
const mockSend = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/ipc-client', () => {
  function IPCClient() {}
  IPCClient.prototype.send = mockSend;
  return { IPCClient };
});

type RouteModule = typeof import('../route');
let route: RouteModule;

beforeEach(async () => {
  mockAuth.mockReset();
  mockSend.mockReset();
  route = await import('../route');
});

function request(method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/agents/ada/context', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Employee context ownership route', () => {
  it('requires authentication for review and decisions', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await route.GET(request('GET'), { params: Promise.resolve({ name: 'ada' }) })).status).toBe(401);
    expect((await route.POST(request('POST', {}), { params: Promise.resolve({ name: 'ada' }) })).status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('derives the actor and rejects forged actor or target properties', async () => {
    mockAuth.mockResolvedValue({ user: { id: '7' } });
    expect((await route.POST(request('POST', { actor: 'forged', decision: 'approve_merge' }), { params: Promise.resolve({ name: 'ada' }) })).status).toBe(400);
    mockSend.mockResolvedValueOnce({ success: true, data: { status: 'applied' } });
    const response = await route.POST(request('POST', {
      decision: 'approve_merge', rule_id: 'employee-core', proposal_digest: 'a'.repeat(64),
    }, { 'x-cortext-intent': 'context-owner-decision', 'x-cortext-mutation-id': '0a660181-a4fe-467a-a2f7-11299a7fb28a' }), { params: Promise.resolve({ name: 'ada' }) });
    expect(response.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context-owner-decision',
      data: expect.objectContaining({ agentName: 'ada', actor: 'owner:7' }),
    }));
  });

  it.each(['MUTATION_OUTCOME_UNKNOWN', 'MUTATION_PENDING', 'RECOVERY_REQUIRED'])('maps %s to retryable status with the request id', async code => {
    mockAuth.mockResolvedValue({ user: { id: '7' } });
    mockSend.mockResolvedValueOnce({ success: false, code, error: 'pending' });
    const response = await route.POST(request('POST', {
      decision: 'approve_merge', rule_id: 'employee-core', proposal_digest: 'a'.repeat(64),
    }, { 'x-cortext-intent': 'context-owner-decision', 'x-cortext-mutation-id': '0a660181-a4fe-467a-a2f7-11299a7fb28a' }), { params: Promise.resolve({ name: 'ada' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code, mutation_id: '0a660181-a4fe-467a-a2f7-11299a7fb28a' });
  });

  it('maps context source failure to 503 without echoing daemon error text', async () => {
    mockAuth.mockResolvedValue({ user: { id: '7' } });
    mockSend.mockResolvedValueOnce({ success: false, code: 'CONTEXT_SOURCE_UNAVAILABLE', error: '/private/host/template.md' });
    const response = await route.GET(request('GET'), { params: Promise.resolve({ name: 'ada' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'CONTEXT_SOURCE_UNAVAILABLE', error: 'Context review unavailable' });
  });
});

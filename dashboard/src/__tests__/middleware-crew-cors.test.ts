import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

afterEach(() => {
  delete process.env.MOBILE_APP_ORIGIN;
  vi.resetModules();
});

describe('mobile Crew CORS preflight', () => {
  it('allows the mutation intent and id headers required by authenticated writes', async () => {
    process.env.MOBILE_APP_ORIGIN = 'https://mobile.example';
    vi.resetModules();
    const { middleware } = await import('../middleware');
    const response = await middleware(new NextRequest('http://localhost/api/work-sessions', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://mobile.example',
        'access-control-request-headers': 'authorization,content-type,x-cortext-intent,x-cortext-mutation-id',
      },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://mobile.example');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-cortext-intent');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-cortext-mutation-id');
  });
});

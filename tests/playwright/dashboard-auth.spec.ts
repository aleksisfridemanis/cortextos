/**
 * Dashboard Authentication Tests
 * Tests 24.2 (wrong password rejected) and 24.4 (session/token handling)
 *
 * Runs only against the isolated Playwright supervisor at 127.0.0.1:39183.
 */
import { test, expect } from '@playwright/test';

const DASHBOARD_URL = process.env.DASHBOARD_URL!;
const ADMIN_USER = process.env.ADMIN_USERNAME!;
const ADMIN_PASS = process.env.ADMIN_PASSWORD!;

test.describe('Dashboard Auth (24.2, 24.4)', () => {
  test('24.2 - Wrong password returns 401 / shows error', async ({ page }) => {
    // Test via mobile auth API (CSRF-free)
    const resp = await page.request.post(`${DASHBOARD_URL}/api/auth/mobile`, {
      data: { username: ADMIN_USER, password: 'wrongpassword' },
      headers: { 'Content-Type': 'application/json' },
    });

    expect(resp.status()).toBe(401);
    const body = await resp.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toMatch(/invalid credentials/i);
  });

  test('24.2 - Missing credentials returns 400', async ({ page }) => {
    const resp = await page.request.post(`${DASHBOARD_URL}/api/auth/mobile`, {
      data: { username: ADMIN_USER },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(400);
  });

  test('24.2 - Correct credentials return JWT token', async ({ page }) => {
    const resp = await page.request.post(`${DASHBOARD_URL}/api/auth/mobile`, {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('user');
    expect(body.user).toHaveProperty('id');
    expect(body.user).toHaveProperty('name');
    // Token should be a non-empty JWT string (header.payload.signature)
    expect(body.token).toMatch(/^ey[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/);
  });

  test('24.4 - No Authorization header returns 401', async ({ browser }) => {
    // Without any token, middleware rejects with 401
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const resp = await context.request.get(`${DASHBOARD_URL}/api/tasks`);
    expect(resp.status()).toBe(401);
    await context.close();
  });

  test('24.4 - Authenticated request works with valid Bearer token', async ({ page }) => {
    // Get a valid token
    const authResp = await page.request.post(`${DASHBOARD_URL}/api/auth/mobile`, {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
      headers: { 'Content-Type': 'application/json' },
    });
    const { token } = await authResp.json() as { token: string };

    // Valid token works
    const validResp = await page.request.get(`${DASHBOARD_URL}/api/tasks`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(validResp.status()).toBe(200);
    const tasks = await validResp.json();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test('24.4 - CORS preflight echoes only a validated origin', async ({ page }) => {
    const allowed = await page.request.fetch(`${DASHBOARD_URL}/api/tasks`, {
      method: 'OPTIONS',
      headers: {
        'Origin': DASHBOARD_URL,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    });
    expect(allowed.status()).toBe(204);
    expect(allowed.headers()['access-control-allow-origin']).toBe(DASHBOARD_URL);
    expect(allowed.headers()['access-control-allow-headers']).toContain('Authorization');
    const denied = await page.request.fetch(`${DASHBOARD_URL}/api/tasks`, { method: 'OPTIONS', headers: { Origin: 'https://forged.invalid' } });
    expect(denied.headers()['access-control-allow-origin']).toBe('null');
    expect(denied.headers()['access-control-allow-origin']).not.toBe('*');
  });
});

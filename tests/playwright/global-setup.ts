import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

export default async function globalSetup(config: FullConfig) {
  const origin = process.env.DASHBOARD_URL!;
  const storageState = join(process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT!, 'auth', 'storage-state.json');
  mkdirSync(dirname(storageState), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/login`);
    await page.locator('input[name="username"]').fill(process.env.ADMIN_USERNAME!);
    await page.locator('input[name="password"]').fill(process.env.ADMIN_PASSWORD!);
    const callbackResponse = page.waitForResponse(response =>
      response.url().includes('/api/auth/callback/credentials'),
    );
    await page.locator('button[type="submit"]').click();
    const response = await callbackResponse;
    const redirectLocation = response.headers()['location'] ?? '';
    if (response.status() >= 400 || redirectLocation.includes('/login?error=')) {
      throw new Error(
        `Synthetic login callback failed with status ${response.status()} (${redirectLocation || 'no redirect'})`,
      );
    }
    await page.waitForTimeout(500);
    const sessionCookie = (await page.context().cookies()).some(cookie =>
      cookie.name.endsWith('authjs.session-token'),
    );
    if (!sessionCookie) {
      throw new Error(`Synthetic login did not issue a session cookie (${redirectLocation || 'no redirect'})`);
    }
    const crewResponse = await page.goto(`${origin}/api/crew`);
    if (!crewResponse?.ok()) {
      throw new Error(`Synthetic session could not authenticate /api/crew (${crewResponse?.status() ?? 'no response'})`);
    }
    await page.context().storageState({ path: storageState });
  } finally {
    await browser.close();
  }
  if (!config.projects[0]?.use.baseURL) throw new Error('Playwright baseURL is missing');
}

import { defineConfig } from '@playwright/test';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Playwright evaluates the config in the coordinator and worker processes. The
// coordinator owns the unique root; workers inherit it instead of creating a
// second fixture with no storage state.
const runRoot = realpathSync(
  process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT
    ?? mkdtempSync(join(tmpdir(), 'cortext-playwright-')),
);
const origin = 'http://127.0.0.1:39183';
const username = 'crew-test-admin';
const password = 'Crew-Test-Password-39183!';
process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT = runRoot;
process.env.DASHBOARD_URL = origin;
process.env.ADMIN_USERNAME = username;
process.env.ADMIN_PASSWORD = password;

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin,
    storageState: join(runRoot, 'auth', 'storage-state.json'),
  },
  globalSetup: './tests/playwright/global-setup.ts',
  globalTeardown: './tests/playwright/global-teardown.ts',
  webServer: {
    command: 'npm run test:playwright:server',
    url: `${origin}/api/workflows/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: {
      PATH: process.env.PATH ?? '', HOME: join(runRoot, 'home'), TMPDIR: tmpdir(),
      PORT: '39183', HOSTNAME: '127.0.0.1', DASHBOARD_URL: origin, NEXTAUTH_URL: origin,
      AUTH_SECRET: 'playwright-synthetic-auth-secret-39183-never-production',
      NEXTAUTH_SECRET: 'playwright-synthetic-auth-secret-39183-never-production',
      ADMIN_USERNAME: username, ADMIN_PASSWORD: password, SYNC_ADMIN_PASSWORD: 'true',
      CTX_ROOT: join(runRoot, 'ctx'), CTX_FRAMEWORK_ROOT: join(runRoot, 'framework'),
      CTX_PROJECT_ROOT: join(runRoot, 'framework'), CTX_INSTANCE_ID: 'playwright',
      CORTEXT_PLAYWRIGHT_RUN_ROOT: runRoot, CORTEXT_PLAYWRIGHT_FAKE_IPC: '1',
      CORTEXT_PLAYWRIGHT_IPC_PATH: join(runRoot, 'daemon.sock'),
      CORTEXT_BUILD_SHA: process.env.CORTEXT_BUILD_SHA ?? '',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '',
    },
  },
});

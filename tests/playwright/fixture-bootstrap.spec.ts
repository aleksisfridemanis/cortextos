import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

test('isolated fixture proves roots, socket, build, and auth', async ({ page }) => {
  const root = process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT!;
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  expect(manifest.root).toBe(root);
  expect(existsSync(manifest.socket)).toBe(true);
  expect(existsSync(join(root, 'ctx', 'config', 'enabled-agents.json'))).toBe(true);
  expect(manifest.live_api_keys_empty).toBe(true);
  expect(manifest.forwarded_environment_keys).not.toEqual(expect.arrayContaining([
    'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN', 'CTX_OPERATOR_BOT_TOKEN',
  ]));
  const build = await page.goto('/api/system/build');
  expect(build?.status()).toBe(200);
  expect((await build!.json()).sha).toBe(manifest.sha);
  expect((await page.goto('/api/crew'))?.status()).toBe(200);
});

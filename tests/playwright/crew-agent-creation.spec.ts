import { expect, test } from '@playwright/test';

for (const shell of ['/crew', '/crew-app']) {
  test(`${shell} creates a Work Session through the shared dialog`, async ({ page }) => {
    await page.goto(shell);
    await page.getByRole('button', { name: 'Create chat' }).click();
    await page.getByRole('button', { name: 'Work Session' }).click();
    await page.getByLabel('Session name').fill('Release repair');
    await page.getByLabel('Organization').fill('platform');
    await page.getByLabel('Harness', { exact: true }).selectOption('codex-app-server');
    await page.getByLabel(/Working directory/).fill(process.env.CORTEXT_PLAYWRIGHT_RUN_ROOT!);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Release repair').first()).toBeVisible();
    await expect(page.getByText(/Work Session/i).first()).toBeVisible();
  });
}

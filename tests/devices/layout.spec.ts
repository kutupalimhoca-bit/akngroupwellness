import { test, expect } from '@playwright/test';

test('sayfada yatay taşma olmaz', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('uygulama kök öğesi render edilir', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).not.toBeEmpty();
});

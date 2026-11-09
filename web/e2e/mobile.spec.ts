import { expect, test } from '@playwright/test';

test('mobile: menu is usable and has no horizontal scroll', async ({ page }) => {
  await page.goto('/menu');
  await expect(page.getByRole('heading', { name: 'Our menu' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('link', { name: 'Reserve' }).last()).toBeVisible();
});

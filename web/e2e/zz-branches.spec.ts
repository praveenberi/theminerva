import { expect, test } from '@playwright/test';

// Runs last: it switches the restaurant into multi-branch mode and back.
test('multi-branch: customer must pick a branch, branch price applies, owner sees branch filter', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'admin@theminerva.com', password: 'Minerva@12345' } });
  const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const mk = async (name: string, code: string) => (await (await request.post('/api/outlets', { data: { name, code }, headers: auth })).json()).id as string;
  const marina = await mk('E2E Marina', 'E2M');
  await mk('E2E Orchard', 'E2O');
  const products = await (await request.get('/api/products?pageSize=50', { headers: auth })).json();
  const soup = products.items.find((p: any) => p.slug === 'tomato-soup');
  await request.put(`/api/outlets/${marina}/products/${soup.id}`, { data: { price: 11, isAvailable: true }, headers: auth });
  await request.put('/api/restaurant/settings', { data: { site: { multiOutlet: true } }, headers: auth });

  try {
    await page.goto('/menu');
    await expect(page.getByText('Choose a branch')).toBeVisible();
    await page.getByRole('radio', { name: /E2E Marina/ }).click();
    await expect(page.getByText('$11.00').first()).toBeVisible(); // branch price override
    await page.getByRole('button', { name: 'Add Tomato Soup' }).click();
    await page.getByRole('button', { name: 'Checkout' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Branch Guest');
    await page.getByLabel('Mobile number').fill('+65 9000 6666');
    await page.getByText('Pay at the restaurant').click();
    await expect(page.getByRole('button', { name: /Place order · / })).toBeEnabled();
    await page.getByRole('button', { name: /Place order · / }).click();
    await expect(page).toHaveURL(/\/track\//);

    // owner: branch selector filters the order board
    await page.goto('/admin/login');
    await page.getByLabel('Email').fill('admin@theminerva.com');
    await page.getByLabel('Password').fill('Minerva@12345');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp('/admin(?!/login)'));
    await page.goto('/admin/orders');
    const sel = page.getByLabel('Branch');
    await expect(sel).toBeVisible();
    await sel.selectOption({ label: 'E2E Orchard' });
    await expect(page.getByText('Nothing here').first()).toBeVisible();
    await sel.selectOption({ label: 'E2E Marina' });
    await expect(page.getByRole('button', { name: /#\d+/ }).first()).toBeVisible();
  } finally {
    await request.put('/api/restaurant/settings', { data: { site: { multiOutlet: false } }, headers: auth });
  }
});

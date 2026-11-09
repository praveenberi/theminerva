import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'Minerva@12345';

async function staffLogin(page: Page, email: string) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp('/admin(?!/login)')); // any admin page except the login form
}

test('customer orders as a guest, staff process it end to end, customer sees completion', async ({ page, browser }) => {
  // customer journey
  await page.goto('/menu');
  await expect(page.getByRole('heading', { name: 'Tomato Soup' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Tomato Soup' }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('E2E Guest');
  await page.getByLabel('Mobile number').fill('+65 9000 7777');
  await page.getByText('Pay at the restaurant').click();
  await expect(page.getByRole('button', { name: /Place order · / })).toBeEnabled();
  await page.getByRole('button', { name: /Place order · / }).click();
  await expect(page).toHaveURL(/\/track\//);
  await expect(page.getByRole('heading', { name: /Order #\d+/ })).toBeVisible();
  const trackUrl = page.url();

  // staff journey in a separate browser context
  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  await staffLogin(staff, 'manager@theminerva.com');
  await staff.goto('/admin/orders');
  await staff.getByRole('button', { name: /#\d+/ }).first().click();
  for (const label of ['Accept', 'Mark preparing', 'Mark ready', 'Mark completed']) {
    await staff.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
    await staff.waitForTimeout(400);
  }
  await expect(staff.getByText('Completed').first()).toBeVisible();

  // customer sees the final status without a manual refresh (WebSocket / polling)
  await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 20_000 });
  void trackUrl;
  await ctx.close();
});

test('customer books a table and receives a reference', async ({ page }) => {
  await page.goto('/reservations');
  const tomorrow = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  await page.getByLabel('Date').fill(tomorrow);
  const slot = page.getByRole('radio').first();
  await expect(slot).toBeVisible();
  await slot.click();
  await page.getByLabel('Name').fill('Table Guest');
  await page.getByLabel('Mobile number').fill('+65 9000 8888');
  await page.getByRole('button', { name: 'Confirm reservation' }).click();
  await expect(page.getByText(/MIN-[A-F0-9]{6}/)).toBeVisible();
});

test('role permissions: kitchen sees the KDS but not settings', async ({ page }) => {
  await staffLogin(page, 'kitchen@theminerva.com');
  await expect(page.getByRole('link', { name: 'Kitchen display' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await page.goto('/admin/settings');
  await expect(page.getByText('No access')).toBeVisible();
});

test('owner adds a dish and it appears on the public menu', async ({ page }) => {
  await staffLogin(page, 'admin@theminerva.com');
  await page.goto('/admin/menu');
  await page.getByRole('button', { name: 'Add dish' }).click();
  await page.getByLabel('Name', { exact: true }).fill('E2E Special');
  await page.getByLabel('Price', { exact: true }).fill('12.5');
  await page.getByRole('button', { name: 'Create dish' }).click();
  await expect(page.getByText('E2E Special').first()).toBeVisible();
  await page.goto('/menu');
  await expect(page.getByRole('heading', { name: 'E2E Special' })).toBeVisible();
});

test('public pages render without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  for (const p of ['/', '/about', '/contact', '/privacy', '/terms', '/refunds', '/offers', '/gallery', '/events', '/loyalty', '/feedback']) {
    await page.goto(p);
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('dine-in without a QR code: customer picks a table number at checkout', async ({ page }) => {
  await page.goto('/menu');
  await page.getByRole('button', { name: 'Add Tomato Soup' }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByRole('button', { name: 'Dine in' }).click();
  await page.getByLabel('Your table number').selectOption('T3');
  await page.getByLabel('Name', { exact: true }).fill('Dine In Guest');
  await page.getByLabel('Mobile number').fill('+65 9000 5555');
  await page.getByText('Pay at the restaurant').click();
  await expect(page.getByRole('button', { name: /Place order · / })).toBeEnabled();
  await page.getByRole('button', { name: /Place order · / }).click();
  await expect(page).toHaveURL(/\/track\//);
  await expect(page.getByText('Dine in', { exact: false }).first()).toBeVisible();
});

test('scanning a table QR shows the menu straight away', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'admin@theminerva.com', password: 'Minerva@12345' } });
  const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const tables = await (await request.get('/api/tables', { headers: auth })).json();
  const t1 = tables.find((t: any) => t.label === 'T1');
  await page.goto(`/t/${t1.qrToken}`);
  await expect(page.getByRole('heading', { name: 'Our menu' })).toBeVisible();
  await expect(page.getByText('Table T1').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tomato Soup' })).toBeVisible();
});

test('second order from the same table reuses contact details and tracking merges both orders', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'admin@theminerva.com', password: 'Minerva@12345' } });
  const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const tables = await (await request.get('/api/tables', { headers: auth })).json();
  const t5 = tables.find((t: any) => t.label === 'T5');

  const order = async (item: string) => {
    await page.goto(`/t/${t5.qrToken}`);
    await page.getByRole('button', { name: `Add ${item}` }).first().click();
    await page.getByRole('button', { name: 'Checkout' }).click();
    return page;
  };
  await order('Tomato Soup');
  await page.getByLabel('Name', { exact: true }).fill('Table Five');
  await page.getByLabel('Mobile number').fill('+65 9000 4321');
  await page.getByText('Pay at the restaurant').click();
  await page.getByRole('button', { name: /Place order · / }).click();
  await expect(page).toHaveURL(/\/track\//);

  // second order: name is pre-filled, phone can stay empty
  await order('Flat White');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Table Five');
  await expect(page.getByLabel('Mobile number')).toHaveValue('+65 9000 4321');
  await page.getByText('Pay at the restaurant').click();
  await page.getByRole('button', { name: /Place order · / }).click();
  await expect(page).toHaveURL(/\/track\//);
  await expect(page.getByRole('heading', { name: 'Your table’s orders' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Order #\d+/ })).toHaveCount(2);
  await expect(page.locator('main').getByText('Tomato Soup')).toBeVisible();
  await expect(page.locator('main').getByText('Flat White')).toBeVisible();
  await expect(page.getByText('Total for all orders')).toBeVisible();
});

test('customer can get back to order status from the menu via My orders', async ({ page }) => {
  await page.goto('/menu');
  await page.getByRole('button', { name: 'Add Tomato Soup' }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Status Checker');
  await page.getByLabel('Mobile number').fill('+65 9000 3210');
  await page.getByText('Pay at the restaurant').click();
  await page.getByRole('button', { name: /Place order · / }).click();
  await expect(page).toHaveURL(new RegExp('/track/'));
  await page.goto('/menu'); // browse again
  await page.getByRole('button', { name: /^My orders/ }).click();
  const drawer = page.getByRole('dialog', { name: 'My orders' });
  await expect(drawer.getByText(new RegExp('Order #[0-9]+'))).toBeVisible();
  await expect(drawer.getByText('1× Tomato Soup')).toBeVisible();
  await expect(drawer.getByText('New')).toBeVisible();
  await drawer.getByRole('link', { name: 'Track' }).click();
  await expect(page).toHaveURL(new RegExp('/track/'));
});

test('status changes appear live on the customer table page, one order at a time', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'manager@theminerva.com', password: 'Minerva@12345' } });
  const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const table = await (await request.post('/api/tables', { data: { label: 'LIVE1', capacity: 2 }, headers: auth })).json();
  const products = await (await request.get('/api/products?pageSize=50', { headers: auth })).json();
  const soup = products.items.find((p: any) => p.slug === 'tomato-soup');
  const place = async () => (await request.post('/api/orders', { data: { type: 'DINE_IN', tableToken: table.qrToken, guest: { name: 'Live', phone: '+65 9000 1212' }, items: [{ productId: soup.id, quantity: 1 }] } })).json();
  const a = await place();
  const b = await place();
  const move = (id: string, status: string) => request.patch(`/api/orders/${id}/status`, { data: { status }, headers: auth });

  await page.goto(`/track/${a.trackingToken}`);
  await expect(page.getByRole('heading', { name: 'Your table’s orders' })).toBeVisible();
  // accept only the SECOND order — the first is still waiting, and the page must still update right away
  await move(b.id, 'ACCEPTED');
  await move(b.id, 'PREPARING');
  await expect(page.getByText('Preparing', { exact: true }).first()).toBeVisible({ timeout: 6000 });
  await expect(page.getByText('New', { exact: true })).toBeVisible(); // order A untouched
  await move(b.id, 'READY');
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 6000 });
});

test('saved name and phone are forgotten once the customer\'s orders are completed', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { email: 'manager@theminerva.com', password: 'Minerva@12345' } });
  const auth = { Authorization: `Bearer ${(await login.json()).accessToken}` };
  const table = await (await request.post('/api/tables', { data: { label: 'RST1', capacity: 2 }, headers: auth })).json();
  const products = await (await request.get('/api/products?pageSize=50', { headers: auth })).json();
  const soup = products.items.find((p: any) => p.slug === 'tomato-soup');
  const o = await (await request.post('/api/orders', { data: { type: 'DINE_IN', tableToken: table.qrToken, guest: { name: 'Reset', phone: '+65 9000 3434' }, items: [{ productId: soup.id, quantity: 1 }] } })).json();
  await page.addInitScript(([tok, num, tbl]) => {
    localStorage.setItem('minerva-my-orders-v1', JSON.stringify([{ token: tok, number: num, at: Date.now() }]));
    localStorage.setItem('minerva-table-contact-v1', JSON.stringify({ tableToken: tbl, name: 'Reset', phone: '+65 9000 3434', at: Date.now() }));
  }, [o.trackingToken, o.number, table.qrToken]);
  await page.goto('/menu');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => localStorage.getItem('minerva-table-contact-v1'))).not.toBeNull(); // still in progress
  for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED']) await request.patch(`/api/orders/${o.id}/status`, { data: { status: s }, headers: auth });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('minerva-table-contact-v1')), { timeout: 8000 }).toBeNull();
});

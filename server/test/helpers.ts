import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';

export const app = createApp();
export const api = () => request(app);
export const PASSWORD = 'Minerva@12345';

export async function login(email: string) {
  const r = await api().post('/api/auth/login').send({ email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.accessToken as string, auth: { Authorization: `Bearer ${r.body.accessToken}` } };
}

export async function productBySlug(slug: string) {
  return prisma.product.findUniqueOrThrow({ where: { slug }, include: { variants: true, addonGroups: { include: { addons: true } } } });
}

export async function localTomorrow() {
  const tz = (await prisma.restaurant.findUniqueOrThrow({ where: { id: 'minerva' } })).timezone;
  const d = new Date(Date.now() + 36 * 3600_000); // safely "tomorrow or the day after" in any zone
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

export { prisma };

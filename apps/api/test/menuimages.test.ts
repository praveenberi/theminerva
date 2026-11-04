import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';

const app = createApp();
const uid = Date.now().toString(36);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);

describe('menu item pictures', () => {
  let a: Record<string, string>, b: Record<string, string>, cat: string, kitchen: Record<string, string>;
  const upload = (body: Buffer, type = 'image/png', h = a) => request(app).post('/api/images').set(h).set('Content-Type', type).send(body);
  const product = (name: string, imageUrl?: string) => request(app).post('/api/products').set(a).send({ categoryId: cat, name, priceCents: 1000, imageUrl });
  const rows = (ids: string[]) => prisma.menuImage.count({ where: { id: { in: ids } } });
  const idOf = (url: string) => url.split('/').pop()!;

  beforeAll(async () => {
    const reg = async (tag: string) => {
      const r = await request(app).post('/api/auth/register').send({ restaurantName: `Img ${tag} ${uid}`, name: 'Owner', email: `img-${tag}-${uid}@example.com`, password: 'Password123!' });
      return { Authorization: `Bearer ${r.body.accessToken}` };
    };
    a = await reg('a'); b = await reg('b');
    cat = (await request(app).post('/api/categories').set(a).send({ name: 'Mains' })).body.id;
    const email = `img-k-${uid}@example.com`;
    await request(app).post('/api/staff').set(a).send({ name: 'Kay', email, password: 'Password123!', role: 'KITCHEN' });
    kitchen = { Authorization: `Bearer ${(await request(app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.accessToken}` };
  });

  it('stores JPEG, PNG and WebP pictures and serves them publicly with safe headers', async () => {
    for (const [buf, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']] as const) {
      const r = await upload(buf, type);
      expect(r.status).toBe(201);
      expect(r.body.url).toMatch(/^\/api\/public\/images\/[a-z0-9]+$/);
      const got = await request(app).get(r.body.url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toBe(type);
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.headers['content-security-policy']).toContain('sandbox');
      expect(got.headers['cache-control']).toContain('immutable');
      expect((got.body as Buffer).equals(buf)).toBe(true);
    }
    expect((await request(app).get('/api/public/images/doesnotexist')).status).toBe(404);
  });

  it('refuses anything that is not really a picture, even if it claims to be one', async () => {
    expect((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png')).status).toBe(400); // wrong bytes, right label
    expect((await upload(Buffer.from('GIF89a' + 'x'.repeat(30)), 'image/png')).status).toBe(400);
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
    expect((await upload(Buffer.from('{"a":1}'), 'application/json')).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(1_100_000)]);
    expect((await upload(big)).status).toBe(413);
  });

  it('is for owners and managers only', async () => {
    expect((await request(app).post('/api/images').set('Content-Type', 'image/png').send(PNG)).status).toBe(401);
    expect((await upload(PNG, 'image/png', kitchen)).status).toBe(403);
  });

  it('attaches a picture to an item, and only accepts uploaded pictures or http(s) links', async () => {
    const url = (await upload(PNG)).body.url;
    const p = await product('Pizza', url);
    expect(p.status).toBe(201);
    expect(p.body.imageUrl).toBe(url);
    const menu = (await request(app).get('/api/products').set(a)).body.find((x: any) => x.id === p.body.id);
    expect(menu.imageUrl).toBe(url);
    expect((await product('Link', 'https://example.com/pizza.jpg')).status).toBe(201);
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '/etc/passwd', '/api/public/images/../../x', 'ftp://example.com/a.png']) expect((await product('Bad', bad)).status).toBe(400);
  });

  it('removes the stored picture when it is replaced or the item is deleted, but not while another item uses it', async () => {
    const u1 = (await upload(PNG)).body.url, u2 = (await upload(JPEG, 'image/jpeg')).body.url;
    const p = (await product('Soup', u1)).body;
    expect(await rows([idOf(u1)])).toBe(1);
    expect((await request(app).put(`/api/products/${p.id}`).set(a).send({ ...p, imageUrl: u2 })).status).toBe(200);
    expect(await rows([idOf(u1)])).toBe(0); // replaced picture is gone
    expect(await rows([idOf(u2)])).toBe(1);
    const copy = (await request(app).post(`/api/products/${p.id}/duplicate`).set(a)).body;
    expect((await request(app).delete(`/api/products/${p.id}`).set(a)).status).toBe(204);
    expect(await rows([idOf(u2)])).toBe(1); // the copy still shows it
    expect((await request(app).delete(`/api/products/${copy.id}`).set(a)).status).toBe(204);
    expect(await rows([idOf(u2)])).toBe(0);
  });

  it('keeps one business from deleting or clearing another business\'s picture', async () => {
    const u = (await upload(PNG)).body.url;
    await product('Mine', u);
    // business b points an item at a's picture, then removes it: a's picture must survive because a's item still uses it
    const cb = (await request(app).post('/api/categories').set(b).send({ name: 'X' })).body.id;
    const theirs = (await request(app).post('/api/products').set(b).send({ categoryId: cb, name: 'Theirs', priceCents: 100, imageUrl: u })).body;
    expect((await request(app).delete(`/api/products/${theirs.id}`).set(b)).status).toBe(204);
    expect(await rows([idOf(u)])).toBe(1);
  });
});

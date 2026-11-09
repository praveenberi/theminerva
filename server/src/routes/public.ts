import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { attachAuth } from '../lib/auth.js';
import { badRequest, notFound, parse, wrap } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { priceCart } from '../services/pricing.js';
import { config } from '../config.js';
import { sessionContact } from '../services/orders.js';
import { inWindow, localParts } from '../services/pricing.js';

export const publicRouter = Router();

const productPublic = {
  images: { orderBy: { sortOrder: 'asc' as const } },
  variants: { orderBy: { sortOrder: 'asc' as const } },
  addonGroups: { include: { addons: true } },
  category: { select: { id: true, name: true, slug: true } },
};

function translate(p: any, lang?: string) {
  const t = lang && p.translations?.[lang];
  return t ? { ...p, name: t.name || p.name, description: t.description || p.description } : p;
}

async function bestSellers(limit = 6) {
  const since = new Date(Date.now() - 90 * 864e5);
  const rows = await prisma.orderItem.groupBy({
    by: ['productId'], where: { order: { status: 'COMPLETED', createdAt: { gte: since } } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: limit,
  });
  if (!rows.length) return [];
  const ps = await prisma.product.findMany({ where: { id: { in: rows.map((r) => r.productId) }, isPublished: true, isAvailable: true }, include: productPublic });
  return rows.map((r) => ps.find((p) => p.id === r.productId)).filter(Boolean);
}

publicRouter.get('/home', wrap(async (req, res) => {
  const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
  const now = new Date();
  const [restaurant, s, banners, featured, chef, testimonials, gallery, events, blocks, reviewAgg] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id: 'minerva' } }),
    getSettings(),
    prisma.banner.findMany({ where: { isActive: true, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] }, orderBy: { sortOrder: 'asc' } }),
    prisma.product.findMany({ where: { isFeatured: true, isPublished: true }, include: productPublic, take: 8, orderBy: { sortOrder: 'asc' } }),
    prisma.product.findMany({ where: { isChefPick: true, isPublished: true }, include: productPublic, take: 6 }),
    prisma.testimonial.findMany({ where: { isPublished: true }, take: 12 }),
    prisma.galleryImage.findMany({ where: { isPublished: true }, orderBy: { sortOrder: 'asc' }, take: 24 }),
    prisma.eventListing.findMany({ where: { isPublished: true }, orderBy: { eventDate: 'asc' }, take: 6 }),
    prisma.contentBlock.findMany({ where: { isPublished: true } }),
    prisma.review.aggregate({ where: { isPublished: true }, _avg: { rating: true }, _count: true }),
  ]);
  const categories = await prisma.category.findMany({ where: { isActive: true, parentId: null, menu: { isActive: true } }, orderBy: { sortOrder: 'asc' }, take: 8, select: { id: true, name: true, slug: true, imageUrl: true } });
  res.json({
    restaurant, categories, banners,
    featured: featured.map((p) => translate(p, lang)), chefPicks: chef.map((p) => translate(p, lang)),
    bestSellers: (await bestSellers()).map((p) => translate(p, lang)),
    testimonials, gallery, events,
    content: Object.fromEntries(blocks.map((b) => [b.key, { title: b.title, ...(b.body as object) }])),
    reviews: { average: reviewAgg._avg.rating, count: reviewAgg._count, googleUrl: s.site.googleReviewsUrl || null },
    config: {
      ordering: { dineIn: s.ordering.dineInEnabled, takeaway: s.ordering.takeawayEnabled, delivery: s.ordering.deliveryEnabled, guestCheckout: s.ordering.guestCheckout, tipOptions: s.ordering.tipOptions, scheduled: s.ordering.scheduledOrdersEnabled },
      payments: s.payments.enabledMethods, languages: s.site.languages, defaultLanguage: s.site.defaultLanguage,
      loyaltyEnabled: s.loyalty.enabled, reservationsEnabled: s.reservations.enabled,
      analytics: { ga: s.analytics.gaMeasurementId, metaPixel: s.analytics.metaPixelId, searchConsole: s.analytics.searchConsoleToken },
      whatsappMessage: s.site.whatsappOrderMessage,
      onlinePayments: { stripePublishableKey: config.STRIPE_PUBLISHABLE_KEY ?? null, stripeReady: !!(config.STRIPE_SECRET_KEY && config.STRIPE_PUBLISHABLE_KEY), razorpayReady: !!(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET) },
    },
  });
}));

publicRouter.get('/outlets', wrap(async (_req, res) => {
  const s = await getSettings();
  if (!s.site.multiOutlet) return res.json([]);
  res.json(await prisma.outlet.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, code: true, address: true, phone: true } }));
}));

publicRouter.get('/menu', wrap(async (req, res) => {
  const lang = typeof req.query.lang === 'string' ? req.query.lang : undefined;
  const outletId = typeof req.query.outletId === 'string' ? req.query.outletId : undefined;
  const overrides = outletId ? await prisma.outletProduct.findMany({ where: { outletId } }) : [];
  const restaurant = await prisma.restaurant.findUnique({ where: { id: 'minerva' } });
  const local = localParts(new Date(), restaurant?.timezone ?? 'Asia/Singapore');
  const menus = await prisma.menu.findMany({
    where: { isActive: true }, orderBy: { sortOrder: 'asc' },
    include: { categories: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, include: { products: { where: { isPublished: true }, orderBy: { sortOrder: 'asc' }, include: productPublic } } } },
  });
  res.json(menus.map((m) => ({
    id: m.id, name: m.name, description: m.description, availableNow: inWindow(local.minutes, m.availableFrom, m.availableTo), availableFrom: m.availableFrom, availableTo: m.availableTo,
    categories: m.categories.map((c) => ({
      id: c.id, name: c.name, slug: c.slug, description: c.description, imageUrl: c.imageUrl, parentId: c.parentId,
      products: c.products.filter((p) => overrides.find((o) => o.productId === p.id)?.isAvailable !== false).map((p) => { const ov = overrides.find((o) => o.productId === p.id); return ({ ...translate(p, lang), ...(ov?.price != null ? { price: ov.price, discountPrice: null } : {}), orderable: p.isAvailable && inWindow(local.minutes, p.availableFrom, p.availableTo) && inWindow(local.minutes, m.availableFrom, m.availableTo) }); }),
    })),
  })));
}));

publicRouter.get('/products/:slug', wrap(async (req, res) => {
  const p = await prisma.product.findFirst({ where: { slug: req.params.slug, isPublished: true }, include: { ...productPublic, reviews: { where: { isPublished: true }, take: 10, orderBy: { createdAt: 'desc' } } } });
  if (!p) throw notFound('Dish');
  // "frequently ordered together"
  const together = await prisma.$queryRaw<Array<{ productId: string; n: bigint }>>`
    SELECT b."productId", COUNT(*) n FROM "OrderItem" a JOIN "OrderItem" b ON a."orderId" = b."orderId" AND a."productId" <> b."productId"
    WHERE a."productId" = ${p.id} GROUP BY b."productId" ORDER BY n DESC LIMIT 4`;
  const rec = together.length ? await prisma.product.findMany({ where: { id: { in: together.map((t) => t.productId) }, isPublished: true, isAvailable: true }, include: productPublic }) : [];
  res.json({ ...translate(p, typeof req.query.lang === 'string' ? req.query.lang : undefined), recommendations: rec });
}));

publicRouter.post('/cart/price', attachAuth, wrap(async (req, res) => {
  const b = parse(z.object({
    items: z.array(z.object({ productId: z.string(), variantId: z.string().optional(), addonIds: z.array(z.string()).optional(), quantity: z.number().int(), notes: z.string().max(300).optional() })).min(1).max(60),
    type: z.enum(['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY']), couponCode: z.string().max(40).optional(), voucherCode: z.string().max(40).optional(),
    outletId: z.string().optional(), redeemPoints: z.number().int().min(0).optional(), tip: z.number().min(0).max(1000).optional(), deliveryPostal: z.string().max(12).optional(),
  }), req.body);
  res.json(await priceCart({ ...b, customerId: req.customer?.id }));
}));

publicRouter.get('/table/:token', wrap(async (req, res) => {
  const t = await prisma.diningTable.findUnique({ where: { qrToken: req.params.token } });
  if (!t || !t.isActive) throw notFound('Table');
  const session = await prisma.tableSession.findFirst({ where: { tableId: t.id, closedAt: null }, include: { orders: { include: { items: true } } } });
  const known = await sessionContact(t.id);
  const mask = (p?: string | null) => (p ? p.replace(/\d(?=(?:\D*\d){2})/g, '•') : null); // keep only the last 2 digits
  res.json({ knownGuest: known ? { name: known.name, phoneMasked: mask(known.phone), hasEmail: !!known.email } : null, table: { id: t.id, label: t.label, capacity: t.capacity }, session: session && { id: session.id, openedAt: session.openedAt, orders: session.orders.map((o) => ({ number: o.number, status: o.status, total: o.total, trackingToken: o.trackingToken, items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })) })), billRequested: !!session.billRequestedAt } });
}));

publicRouter.get('/tables', wrap(async (_req, res) => {
  res.json(await prisma.diningTable.findMany({ where: { isActive: true }, orderBy: { label: 'asc' }, select: { label: true, capacity: true } }));
}));

publicRouter.get('/delivery-zones', wrap(async (_req, res) => {
  const z2 = await prisma.deliveryZone.findMany({ where: { isActive: true }, select: { id: true, name: true, fee: true, minOrder: true, etaMinutes: true, postalPrefixes: true } });
  res.json(z2);
}));

publicRouter.get('/content/:key', wrap(async (req, res) => {
  const b = await prisma.contentBlock.findFirst({ where: { key: req.params.key, isPublished: true } });
  if (!b) throw notFound('Page');
  res.json({ key: b.key, title: b.title, ...(b.body as object) });
}));

publicRouter.post('/reviews', attachAuth, wrap(async (req, res) => {
  const b = parse(z.object({ authorName: z.string().trim().min(1).max(80), rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1500).optional(), productId: z.string().optional() }), req.body);
  const r = await prisma.review.create({ data: { ...b, customerId: req.customer?.id } }); // published after moderation
  res.status(201).json({ id: r.id, message: 'Thank you! Your feedback will appear once approved.' });
}));

publicRouter.post('/newsletter', wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  await prisma.newsletter.upsert({ where: { email }, create: { email }, update: { unsubscribedAt: null } });
  res.status(201).json({ ok: true });
}));
publicRouter.get('/newsletter/unsubscribe', wrap(async (req, res) => {
  const email = String(req.query.email ?? '').toLowerCase();
  if (!email) throw badRequest('Email required');
  await prisma.newsletter.updateMany({ where: { email }, data: { unsubscribedAt: new Date() } });
  await prisma.customer.updateMany({ where: { email }, data: { marketingConsent: false, unsubscribedAt: new Date() } });
  res.send('You have been unsubscribed.');
}));

publicRouter.get('/orders/:token', wrap(async (req, res) => {
  const o = await prisma.order.findUnique({ where: { trackingToken: req.params.token }, include: { items: true, history: { orderBy: { createdAt: 'asc' } }, payments: true, driver: { select: { name: true } } } });
  if (!o) throw notFound('Order');
  const present = (x: typeof o) => ({
    number: x.number, type: x.type, status: x.status, createdAt: x.createdAt, scheduledFor: x.scheduledFor, prepMinutes: x.prepMinutes,
    subtotal: x.subtotal, discount: x.discount, serviceCharge: x.serviceCharge, tax: x.tax, deliveryFee: x.deliveryFee, tip: x.tip, total: x.total,
    items: x.items.map((i) => ({ name: i.name, variantName: i.variantName, addons: i.addons, quantity: i.quantity, lineTotal: i.lineTotal, status: i.status })),
    history: x.history.map((h) => ({ status: h.status, at: h.createdAt })),
    payments: x.payments.map((p) => ({ method: p.method, status: p.status, amount: p.amount })),
  });
  // all orders placed during the same table visit are shown together
  const siblings = o.sessionId
    ? await prisma.order.findMany({ where: { sessionId: o.sessionId, status: { notIn: ['REJECTED', 'CANCELLED', 'COMPLETED'] } }, orderBy: { createdAt: 'asc' }, include: { items: true, history: { orderBy: { createdAt: 'asc' } }, payments: true, driver: { select: { name: true } } } })
    : [];
  const table = o.tableId ? await prisma.diningTable.findUnique({ where: { id: o.tableId }, select: { label: true } }) : null;
  const group = siblings.length > 1 || (siblings.length === 1 && siblings[0].id !== o.id)
    ? { tableLabel: table?.label ?? null, orders: siblings.map(present), total: siblings.reduce((a, x) => a + Number(x.total), 0).toFixed(2), thisOrder: o.number }
    : null;
  res.json({
    group,
    number: o.number, type: o.type, status: o.status, createdAt: o.createdAt, scheduledFor: o.scheduledFor, prepMinutes: o.prepMinutes,
    subtotal: o.subtotal, discount: o.discount, serviceCharge: o.serviceCharge, tax: o.tax, deliveryFee: o.deliveryFee, tip: o.tip, total: o.total,
    items: o.items.map((i) => ({ name: i.name, variantName: i.variantName, addons: i.addons, quantity: i.quantity, lineTotal: i.lineTotal, status: i.status })),
    history: o.history.map((h) => ({ status: h.status, at: h.createdAt })),
    payments: o.payments.map((p) => ({ method: p.method, status: p.status, amount: p.amount })),
    driverName: o.status === 'OUT_FOR_DELIVERY' ? o.driver?.name : undefined,
  });
}));

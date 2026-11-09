/**
 * Seed script.
 *   npm run db:seed        → production-safe: restaurant row, owner account, policy page templates. No demo data.
 *   npm run db:seed:demo   → also loads SAMPLE staff / menu / tables / stock for development and tests.
 * Demo content is placeholder data, NOT The Minerva's real menu, address or hours — edit or delete it in the dashboard.
 */
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const demo = process.argv.includes('--demo');
const D = (n: number) => new Prisma.Decimal(n);

const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? 'owner@theminerva.local';
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? 'Minerva@12345';

const POLICY = (title: string, body: string[]) => ({ title, body: { paragraphs: body } });

async function base() {
  await prisma.restaurant.upsert({ where: { id: 'minerva' }, create: { id: 'minerva', name: 'The Minerva' }, update: {} });
  await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    create: { email: OWNER_EMAIL, name: 'Owner', role: 'OWNER', passwordHash: await bcrypt.hash(OWNER_PASSWORD, 12) },
    update: {},
  });
  // Policy page templates: starting points only — the owner must review them (ideally with legal advice) and publish their own.
  const policies: Record<string, ReturnType<typeof POLICY>> = {
    'policy.privacy': POLICY('Privacy Policy', [
      'This is a template. The Minerva must review and complete it before launch.',
      'We collect the personal data you give us (name, phone, email, delivery address, allergies you volunteer) to take and deliver orders, manage reservations and, if you opt in, send offers.',
      'We process data under Singapore\'s PDPA and, where applicable, the GDPR. You can access, correct, export or delete your data from your account page, or contact us. Marketing messages need your consent and every message has an opt-out.',
      'Card details are handled by our payment provider and never stored on our servers.',
    ]),
    'policy.terms': POLICY('Terms and Conditions', [
      'This is a template. The Minerva must review and complete it before launch.',
      'Orders are confirmed only when you see a confirmation from us. Prices and availability may change. Allergen information is provided in good faith; please tell us about allergies when ordering.',
    ]),
    'policy.refunds': POLICY('Refund and Cancellation Policy', [
      'This is a template. The Minerva must review and complete it before launch.',
      'Orders can be cancelled until the kitchen starts preparing them. Refunds for paid orders are returned to the original payment method. Reservation deposit rules are shown at booking.',
    ]),
  };
  for (const [key, p] of Object.entries(policies))
    await prisma.contentBlock.upsert({ where: { key }, create: { key, title: p.title, body: p.body }, update: {} });
  await prisma.menu.count().then(async (n) => { if (!n) await prisma.menu.create({ data: { name: 'Main Menu' } }); });
}

async function demoData() {
  const pw = await bcrypt.hash(OWNER_PASSWORD, 10);
  const staff: Array<[string, string, any]> = [
    ['admin@theminerva.com', 'Demo Admin', 'OWNER'], ['manager@theminerva.com', 'Demo Manager', 'MANAGER'], ['kitchen@theminerva.com', 'Demo Kitchen', 'KITCHEN'],
    ['waiter@theminerva.com', 'Demo Waiter', 'WAITER'], ['cashier@theminerva.com', 'Demo Cashier', 'CASHIER'], ['driver@theminerva.com', 'Demo Driver', 'DELIVERY'],
  ];
  for (const [email, name, role] of staff) await prisma.user.upsert({ where: { email }, create: { email, name, role, passwordHash: pw }, update: {} });

  await prisma.restaurant.update({
    where: { id: 'minerva' },
    data: {
      tagline: 'Where Flavours Meet Elegance.\nIndian Veg & Non-Veg · Italian · Mexican · Food & Drinks', description: 'Sample description loaded by the demo seed.',
      openingHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '11:00', close: '22:00' }])),
    },
  });
  await prisma.setting.upsert({ where: { key: 'ordering' }, create: { key: 'ordering', value: { taxRate: 9, serviceChargePct: 10, tipOptions: [0, 5, 10, 15] } }, update: {} });
  await prisma.setting.upsert({ where: { key: 'payments' }, create: { key: 'payments', value: { enabledMethods: ['CASH_AT_RESTAURANT', 'CASH_ON_DELIVERY'] } }, update: {} });

  const menu = (await prisma.menu.findFirst())!;
  const cats: Record<string, string> = {};
  for (const [i, name] of ['Starters', 'Mains', 'Desserts', 'Drinks'].entries()) {
    const slug = name.toLowerCase();
    const c = await prisma.category.upsert({ where: { slug }, create: { menuId: menu.id, name, slug, sortOrder: i }, update: {} });
    cats[name] = c.id;
  }
  const ing: Record<string, string> = {};
  for (const [name, unit, stock, reorder] of [['Flour', 'kg', 20, 5], ['Tomato', 'kg', 15, 4], ['Chicken', 'kg', 12, 3], ['Cream', 'l', 6, 2], ['Coffee beans', 'kg', 5, 1]] as const) {
    const i = await prisma.ingredient.upsert({ where: { name }, create: { name, unit, stock: D(stock), reorderLevel: D(reorder) }, update: {} });
    ing[name] = i.id;
  }
  const dishes: Array<[string, string, string, number, any]> = [
    ['Starters', 'Tomato Soup', 'tomato-soup', 8, { veg: true, recipe: [['Tomato', 0.2], ['Cream', 0.03]], featured: true }],
    ['Mains', 'Roast Chicken', 'roast-chicken', 22, { recipe: [['Chicken', 0.35]], proteins: ['chicken'], chef: true, featured: true, variants: [['Half', 0], ['Whole', 14]], addons: [['Sides', 0, 2, [['Fries', 4], ['Salad', 5]]]] }],
    ['Mains', 'Margherita Pizza', 'margherita-pizza', 18, { veg: true, recipe: [['Flour', 0.25], ['Tomato', 0.15]], featured: true }],
    ['Desserts', 'Cream Pudding', 'cream-pudding', 9, { veg: true, recipe: [['Cream', 0.1]] }],
    ['Drinks', 'Flat White', 'flat-white', 5.5, { veg: true, recipe: [['Coffee beans', 0.018]] }],
  ];
  for (const [cat, name, slug, price, o] of dishes) {
    const exists = await prisma.product.findUnique({ where: { slug } });
    if (exists) continue;
    await prisma.product.create({
      data: {
        categoryId: cats[cat], name, slug, price: D(price), isVegetarian: !!o.veg, proteins: o.proteins ?? [], isFeatured: !!o.featured, isChefPick: !!o.chef,
        description: `Sample ${name.toLowerCase()} (demo data).`,
        recipe: { create: (o.recipe ?? []).map(([n, q]: [string, number]) => ({ ingredientId: ing[n], quantity: D(q) })) },
        variants: { create: (o.variants ?? []).map(([n, d]: [string, number], i: number) => ({ name: n, priceDelta: D(d), sortOrder: i })) },
        addonGroups: { create: (o.addons ?? []).map(([n, min, max, list]: any) => ({ name: n, minSelect: min, maxSelect: max, addons: { create: list.map(([an, ap]: [string, number]) => ({ name: an, price: D(ap) })) } })) },
      },
    });
  }
  for (const [label, capacity, x, y] of [['T1', 2, 40, 40], ['T2', 2, 140, 40], ['T3', 4, 40, 140], ['T4', 4, 140, 140], ['T5', 6, 260, 90]] as const)
    await prisma.diningTable.upsert({ where: { label }, create: { label, capacity, posX: x, posY: y }, update: {} });
  await prisma.deliveryZone.count().then(async (n) => { if (!n) await prisma.deliveryZone.create({ data: { name: 'Sample zone', postalPrefixes: ['01', '02'], fee: D(5), minOrder: D(25), etaMinutes: 45 } }); });
  await prisma.coupon.upsert({ where: { code: 'WELCOME10' }, create: { code: 'WELCOME10', description: 'Demo: 10% off', type: 'PERCENT', value: D(10), minSubtotal: D(20) }, update: {} });
  await prisma.testimonial.count().then(async (n) => { if (!n) await prisma.testimonial.create({ data: { author: 'Sample guest', quote: 'Demo testimonial — replace with real feedback.' } }); });
}

await base();
if (demo) await demoData();
console.log(`Seed complete${demo ? ' (with demo data)' : ''}. Owner: ${OWNER_EMAIL}`);
await prisma.$disconnect();

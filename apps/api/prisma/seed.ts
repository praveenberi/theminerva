import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // The demo data uses well-known passwords. On a real server only the platform admin may be created, from env-supplied credentials.
  if (process.env.NODE_ENV === 'production') {
    const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 14)
      throw new Error('Refusing to seed in production without ADMIN_EMAIL and an ADMIN_PASSWORD of at least 14 characters');
    await prisma.user.upsert({ where: { email: ADMIN_EMAIL.toLowerCase() }, update: {}, create: { email: ADMIN_EMAIL.toLowerCase(), name: 'Platform Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12) } });
    return console.log('Platform admin ensured. Demo data skipped in production.');
  }
  const hash = await bcrypt.hash('Password123!', 12);
  await prisma.user.upsert({
    where: { email: 'admin@theminerva.test' }, update: {},
    create: { email: 'admin@theminerva.test', name: 'Platform Admin', role: 'SUPER_ADMIN', passwordHash: hash, emailVerifiedAt: new Date() },
  });
  if (await prisma.restaurant.findUnique({ where: { slug: 'the-minerva' } })) return console.log('Seed already applied');

  const tenant = await prisma.tenant.create({ data: { name: 'The Minerva', plan: 'GROWTH', maxOutlets: 3 } });
  // every business needs a subscription or it is treated as inactive; the plans themselves come from the migrations
  const growth = await prisma.plan.findUniqueOrThrow({ where: { code: 'GROWTH' } });
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: growth.id, status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000) } });
  const r = await prisma.restaurant.create({
    data: {
      tenantId: tenant.id, slug: 'the-minerva', name: 'The Minerva', category: 'Cafe', published: true,
      description: 'Fresh pasta, wood-fired pizza and great coffee.', address: '12 Market Street', phone: '+91 90000 00000',
      orderTypes: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'], deliveryFeeCents: 4000, minDeliveryCents: 20000, taxPercent: 5,
    },
  });
  for (const [email, name, role] of [
    ['owner@demo.test', 'Olivia Owner', 'OWNER'], ['manager@demo.test', 'Max Manager', 'MANAGER'],
    ['kitchen@demo.test', 'Kim Kitchen', 'KITCHEN'], ['waiter@demo.test', 'Will Waiter', 'WAITER'],
  ] as const) await prisma.user.create({ data: { tenantId: tenant.id, email, name, role, passwordHash: hash, emailVerifiedAt: new Date() } });

  const menu: Record<string, [string, string, number, string[]][]> = {
    Starters: [
      ['Garlic Bread', 'Toasted ciabatta with garlic butter', 14900, ['VEG']],
      ['Tomato Soup', 'Roasted tomato, basil, cream', 17900, ['VEG']],
    ],
    Mains: [
      ['Margherita Pizza', 'San Marzano tomato, fior di latte, basil', 34900, ['VEG']],
      ['Penne Arrabbiata', 'Chilli, garlic, tomato', 29900, ['VEGAN']],
      ['Grilled Chicken', 'Herb marinade, roast vegetables', 42900, ['NON_VEG']],
    ],
    Drinks: [
      ['Cold Coffee', 'Single-origin, over ice', 15900, ['VEG']],
      ['Fresh Lime Soda', 'Sweet or salted', 9900, ['VEGAN']],
    ],
  };
  let sort = 0;
  for (const [name, items] of Object.entries(menu)) {
    const c = await prisma.category.create({ data: { restaurantId: r.id, name, sort: sort++ } });
    for (const [pn, description, priceCents, dietary] of items) {
      await prisma.product.create({
        data: {
          restaurantId: r.id, categoryId: c.id, name: pn, description, priceCents, dietary,
          variants: pn.includes('Pizza') ? [{ id: 'reg', name: 'Regular', priceCents: 0 }, { id: 'lrg', name: 'Large', priceCents: 10000 }] : [],
          addons: pn.includes('Pizza') ? [{ id: 'xc', name: 'Extra cheese', priceCents: 4000 }] : [],
        },
      });
    }
  }
  for (let i = 1; i <= 6; i++) await prisma.diningTable.create({ data: { restaurantId: r.id, label: `T${i}`, capacity: i <= 4 ? 4 : 6 } });
  await prisma.coupon.create({ data: { restaurantId: r.id, code: 'WELCOME10', type: 'PERCENT', value: 10 } });
  console.log('Seeded. Logins (password Password123!): owner@demo.test, manager@demo.test, kitchen@demo.test, waiter@demo.test, admin@theminerva.test');
}

main().finally(() => prisma.$disconnect());

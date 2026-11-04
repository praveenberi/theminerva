import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';

process.env.ENABLE_TEST_MESSAGING = '1';

import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';
import { inWindow, localClock, promoDiscount, type PromoRule } from '../src/lib/promo';
import { testOutbox } from '../src/lib/messaging';
import { issueBirthdayVouchers } from '../src/lib/loyalty';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('promotion rules', () => {
  const rule = (o: Partial<PromoRule> = {}): PromoRule => ({ type: 'PERCENT', value: 10, minSubtotalCents: 0, daysOfWeek: [], ...o });
  const lines = [{ categoryId: 'food', unitCents: 10000, quantity: 3 }, { categoryId: 'drink', unitCents: 5000, quantity: 1 }];

  it('limits a discount to its category but checks the minimum on the whole cart', () => {
    expect(promoDiscount(rule({ categoryId: 'drink', value: 20 }), lines)).toBe(1000);
    expect(promoDiscount(rule({ categoryId: 'drink', minSubtotalCents: 40000 }), lines)).toBe(0);
    expect(promoDiscount(rule({ categoryId: 'drink', minSubtotalCents: 35000 }), lines)).toBe(500);
    expect(promoDiscount(rule({ categoryId: 'nothing' }), lines)).toBe(0);
  });
  it('BOGO makes the cheapest of each pair free; fixed never exceeds the eligible total', () => {
    expect(promoDiscount(rule({ type: 'BOGO', value: 1, categoryId: 'food' }), lines)).toBe(10000); // 3 units -> 1 free
    expect(promoDiscount(rule({ type: 'BOGO', value: 1 }), lines)).toBe(5000 + 10000); // 4 units: 5000 + one 10000 free
    expect(promoDiscount(rule({ type: 'BOGO', value: 1, categoryId: 'drink' }), lines)).toBe(0); // only one drink
    expect(promoDiscount(rule({ type: 'FIXED', value: 99999, categoryId: 'drink' }), lines)).toBe(5000);
  });
  it('handles happy-hour windows, including ones that cross midnight', () => {
    const at = (iso: string) => new Date(iso); // offset 0 below, so UTC is local time
    const happy = { daysOfWeek: [1], startMinute: 16 * 60, endMinute: 19 * 60 }; // Mondays 16:00–19:00
    expect(inWindow(happy, at('2026-11-02T17:00:00Z'), 0)).toBe(true); // Monday
    expect(inWindow(happy, at('2026-11-02T19:00:00Z'), 0)).toBe(false); // end is exclusive
    expect(inWindow(happy, at('2026-11-03T17:00:00Z'), 0)).toBe(false); // Tuesday
    expect(inWindow(happy, at('2026-11-02T22:00:00Z'), 330)).toBe(false); // 03:30 Tuesday local
    const late = { daysOfWeek: [5], startMinute: 22 * 60, endMinute: 2 * 60 }; // Fridays 22:00–02:00
    expect(inWindow(late, at('2026-11-06T23:00:00Z'), 0)).toBe(true); // Friday night
    expect(inWindow(late, at('2026-11-07T01:00:00Z'), 0)).toBe(true); // still Friday's window, after midnight
    expect(inWindow(late, at('2026-11-07T23:00:00Z'), 0)).toBe(false); // Saturday night
    expect(localClock(at('2026-11-02T20:00:00Z'), 330)).toEqual({ day: 2, minute: 90 });
  });
});

describe('loyalty, referrals and promotions through the API', () => {
  let token: string, slug: string, restaurantId: string, tenantId: string;
  let food: string, pizza: string, drink: string, drinkCat: string;
  const auth = () => bearer(token);

  const order = (phone: string, name: string, extra: object = {}, items?: object[]) =>
    request(app).post(`/api/public/${slug}/orders`).send({
      type: 'TAKEAWAY', customerName: name, customerPhone: phone, items: items ?? [{ productId: pizza, quantity: 1 }], ...extra,
    });
  const customer = async (phone: string) => (await request(app).get('/api/customers').set(auth())).body.find((c: any) => c.phone === phone);
  const complete = async (trackingCode: string) => {
    const o = (await request(app).get('/api/orders?pageSize=100').set(auth())).body.items.find((x: any) => x.trackingCode === trackingCode);
    for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      const r = await request(app).patch(`/api/orders/${o.id}/status`).set(auth()).send({ status: s });
      expect(r.status).toBe(200);
    }
  };
  const detail = async (id: string) => (await request(app).get(`/api/customers/${id}`).set(auth())).body;

  beforeAll(async () => {
    const r = await request(app).post('/api/auth/register').send({ restaurantName: `Mkt ${uid}`, name: 'Owner', email: `mkt-${uid}@example.com`, password: 'Password123!' });
    token = r.body.accessToken; slug = r.body.restaurant.slug; restaurantId = r.body.restaurant.id;
    tenantId = (await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } })).tenantId;
    food = (await request(app).post('/api/categories').set(auth()).send({ name: 'Food' })).body.id;
    drinkCat = (await request(app).post('/api/categories').set(auth()).send({ name: 'Drinks' })).body.id;
    pizza = (await request(app).post('/api/products').set(auth()).send({ categoryId: food, name: 'Pizza', priceCents: 30000 })).body.id;
    drink = (await request(app).post('/api/products').set(auth()).send({ categoryId: drinkCat, name: 'Cola', priceCents: 5000 })).body.id;
    await request(app).put('/api/restaurant').set(auth()).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
  });

  it('earns configurable points with tier multipliers, exactly once per order', async () => {
    await request(app).put('/api/loyalty/config').set(auth()).send({ enabled: true, config: { pointsPer100: 2, silverAt: 10, goldAt: 1000 } });
    const o1 = await order('+919100000001', 'Earl Earner');
    await complete(o1.body.trackingCode);
    expect((await customer('+919100000001')).loyaltyPoints).toBe(6); // 300 units × 2 per 100
    expect((await customer('+919100000001')).tier).toBe('Member'); // 6 lifetime points < silverAt (10)
    const o2 = await order('+919100000001', 'Earl Earner');
    await complete(o2.body.trackingCode);
    // still Member when the order was placed (6 lifetime): another 6, now 12 lifetime -> Silver
    expect((await customer('+919100000001')).loyaltyPoints).toBe(12);
    expect((await customer('+919100000001')).tier).toBe('Silver'); // 12 lifetime >= 10
    const o3 = await order('+919100000001', 'Earl Earner');
    await complete(o3.body.trackingCode);
    expect((await customer('+919100000001')).loyaltyPoints).toBe(12 + 7); // Silver ×1.25 -> 7.5 floored
    const c = await customer('+919100000001');
    const ledger = (await detail(c.id)).ledger.filter((l: any) => l.reason === 'EARN');
    expect(ledger).toHaveLength(3);
    expect((await request(app).put('/api/loyalty/config').set(auth()).send({ enabled: true, config: { silverAt: 500, goldAt: 100 } })).status).toBe(400);
  });

  it('redeems points into a single-use voucher bound to the customer, and never double-spends', async () => {
    await request(app).put('/api/loyalty/config').set(auth()).send({ enabled: true, config: { pointsPer100: 2, silverAt: 10, goldAt: 1000, minRedeemPoints: 10, pointValueCents: 100 } });
    const c = await customer('+919100000001'); // 19 points
    expect((await request(app).post(`/api/customers/${c.id}/redeem`).set(auth()).send({ points: 5 })).status).toBe(400); // below minimum
    expect((await request(app).post(`/api/customers/${c.id}/redeem`).set(auth()).send({ points: 500 })).status).toBe(409);
    const race = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/customers/${c.id}/redeem`).set(auth()).send({ points: 12 })));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1); // 19 points only cover one 12-point redemption
    const v = race.find((r) => r.status === 201)!.body;
    expect(v).toMatchObject({ valueCents: 1200, pointsSpent: 12 });
    expect((await customer('+919100000001')).loyaltyPoints).toBe(7);

    const use = (phone: string | undefined) => order('+919100000001', 'Earl Earner', { couponCode: v.code }).then((r) => r); // same phone
    const wrongPhone = await order('+919100000002', 'Someone Else', { couponCode: v.code });
    expect(wrongPhone.status).toBe(400); // stolen code is useless on another number
    const ok = await use('+919100000001');
    expect(ok.status).toBe(201);
    expect(ok.body.discountCents).toBe(1200);
    expect((await order('+919100000001', 'Earl Earner', { couponCode: v.code })).status).toBe(400); // single use
    const tracked = await request(app).get(`/api/public/orders/track/${ok.body.trackingCode}`);
    expect(tracked.body.rewards.points).toBe(7);
    expect(tracked.body.rewards.referralCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('pays referral bonuses once, to both friends, and rejects self/repeat/farmed referrals', async () => {
    await request(app).put('/api/loyalty/config').set(auth()).send({ enabled: true, config: { pointsPer100: 1, referralBonusPoints: 40, referralMinOrderCents: 20000, referralMaxRewards: 1 } });
    const host = await order('+919100000010', 'Host Hannah');
    const code = (await request(app).get(`/api/public/orders/track/${host.body.trackingCode}`)).body.rewards.referralCode;
    await complete(host.body.trackingCode);
    const hostBefore = (await customer('+919100000010')).loyaltyPoints;

    const selfUse = await order('+919100000010', 'Host Hannah', { referralCode: code }); // existing customer
    expect(selfUse.body.referral).toBe('ignored');
    const sameNumberFormat = await order('+91 91000 00010', 'Host Hannah', { referralCode: code }); // new row, same digits
    expect(sameNumberFormat.body.referral).toBe('ignored');
    expect((await order('+919100000011', 'Fake Code', { referralCode: 'ZZZZZZ' })).body.referral).toBe('ignored');

    const friend = await order('+919100000012', 'Friend Fred', { referralCode: code });
    expect(friend.body.referral).toBe('applied');
    expect((await customer('+919100000010')).loyaltyPoints).toBe(hostBefore); // nothing before the friend completes an order
    await complete(friend.body.trackingCode);
    expect((await customer('+919100000012')).loyaltyPoints).toBe(3 + 40);
    expect((await customer('+919100000010')).loyaltyPoints).toBe(hostBefore + 40);

    const second = await order('+919100000012', 'Friend Fred', {}, [{ productId: pizza, quantity: 2 }]);
    await complete(second.body.trackingCode);
    expect((await customer('+919100000010')).loyaltyPoints).toBe(hostBefore + 40); // not paid again

    // cap of 1 reward per referrer: the next friend gets nothing and the referrer is not paid
    const friend2 = await order('+919100000013', 'Friend Gina', { referralCode: code });
    await complete(friend2.body.trackingCode);
    expect((await customer('+919100000013')).loyaltyPoints).toBe(3);
    expect((await customer('+919100000010')).loyaltyPoints).toBe(hostBefore + 40);
    // a friend whose first order is under the minimum spend is not rewarded either
    await request(app).put('/api/loyalty/config').set(auth()).send({ enabled: true, config: { referralBonusPoints: 40, referralMinOrderCents: 50000, referralMaxRewards: 10 } });
    const small = await order('+919100000014', 'Small Sam', { referralCode: code });
    await complete(small.body.trackingCode);
    expect((await customer('+919100000014')).loyaltyPoints).toBe(3);
  });

  it('applies customer-specific, category and BOGO offers on the server', async () => {
    const mk = (b: object) => request(app).post('/api/coupons').set(auth()).send({ minSubtotalCents: 0, ...b });
    expect((await mk({ code: `VIP${uid}`.toUpperCase().slice(0, 12), type: 'PERCENT', value: 50, customerPhone: '+919100000020' })).status).toBe(201);
    const vip = `VIP${uid}`.toUpperCase().slice(0, 12);
    expect((await order('+919100000021', 'Not Vip', { couponCode: vip })).status).toBe(400);
    expect((await order('+919100000020', 'Vera Vip', { couponCode: vip })).body.discountCents).toBe(15000);

    expect((await mk({ code: 'COLA20', type: 'PERCENT', value: 20, categoryId: drinkCat })).status).toBe(201);
    const withBoth = await order('+919100000022', 'Cat Test', { couponCode: 'cola20' }, [{ productId: pizza, quantity: 1 }, { productId: drink, quantity: 2 }]);
    expect(withBoth.body.discountCents).toBe(2000); // 20% of the drinks only
    expect((await order('+919100000022', 'Cat Test', { couponCode: 'COLA20' })).body.error.code).toBe('coupon_not_applicable'); // no drinks in cart

    expect((await mk({ code: 'BOGOCOLA', type: 'BOGO', value: 1, categoryId: drinkCat })).status).toBe(201);
    const bogo = await order('+919100000023', 'Bogo Bob', { couponCode: 'BOGOCOLA' }, [{ productId: drink, quantity: 3 }]);
    expect(bogo.body.discountCents).toBe(5000);
    expect(bogo.body.totalCents).toBe(10000);
    expect((await mk({ code: 'BADCAT', type: 'PERCENT', value: 5, categoryId: 'not-mine' })).status).toBe(400);
    expect((await mk({ code: 'HALF', type: 'PERCENT', value: 5, startTime: '10:00' })).status).toBe(400); // needs both times

    // happy hour: a window around "now" works, today's weekday only, and a window elsewhere does not
    const clock = localClock(new Date(), 330);
    const around = { startTime: '00:00', endTime: '23:59' };
    expect((await mk({ code: 'HAPPYNOW', type: 'PERCENT', value: 10, daysOfWeek: [clock.day], ...around })).status).toBe(201);
    expect((await mk({ code: 'HAPPYTMRW', type: 'PERCENT', value: 10, daysOfWeek: [(clock.day + 1) % 7], ...around })).status).toBe(201);
    expect((await order('+919100000024', 'Happy Hal', { couponCode: 'HAPPYNOW' })).status).toBe(201);
    const wrongDay = await order('+919100000024', 'Happy Hal', { couponCode: 'HAPPYTMRW' });
    expect(wrongDay.status).toBe(400);
    expect(wrongDay.body.error.code).toBe('coupon_window');
  });

  it('issues one birthday voucher per customer per year, to the right people', async () => {
    const todayLocal = new Date(Date.now() + 330 * 60_000).toISOString().slice(5, 10);
    const bday = (md: string) => `1990-${md}`;
    const celebrating = await order('+919100000030', 'Birthday Bea', { birthday: bday(todayLocal) });
    const other = await order('+919100000031', 'Other Olly', { birthday: todayLocal === '01-01' ? '1990-02-02' : '1990-01-01' });
    expect([celebrating.status, other.status]).toEqual([201, 201]);

    expect((await issueBirthdayVouchers(restaurantId)).issued).toBe(0); // switched off by default
    await request(app).put('/api/loyalty/config').set(auth()).send({ enabled: true, config: { birthdayEnabled: true, birthdayType: 'PERCENT', birthdayValue: 25 } });
    expect((await request(app).post('/api/loyalty/run-birthdays').set(auth())).body.issued).toBe(1);
    expect((await request(app).post('/api/loyalty/run-birthdays').set(auth())).body.issued).toBe(0); // idempotent

    const bea = await customer('+919100000030');
    const vouchers = (await detail(bea.id)).vouchers;
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]).toMatchObject({ type: 'PERCENT', value: 25, used: false, source: 'birthday' });
    expect((await detail((await customer('+919100000031')).id)).vouchers).toHaveLength(0);
    const redeem = await order('+919100000030', 'Birthday Bea', { couponCode: vouchers[0].code });
    expect(redeem.body.discountCents).toBe(7500);
  });

  describe('campaigns', () => {
    let optedIn: string[];

    beforeAll(async () => {
      // three customers who agreed to marketing (one with a failing address), one who did not
      const mk = (phone: string, name: string, email: string, consent: boolean) => order(phone, name, { email, marketingConsent: consent });
      await mk('+919100000040', 'Ada Active', `ada-${uid}@example.com`, true);
      await mk('+919100000041', 'Ben Bounce', `fail-${uid}@example.com`, true);
      await mk('+919100000042', 'Cy Consent', `cy-${uid}@example.com`, true);
      await mk('+919100000043', 'Nia NoConsent', `nia-${uid}@example.com`, false);
      optedIn = ['+919100000040', '+919100000041', '+919100000042'];
      await request(app).post('/api/coupons').set(auth()).send({ code: 'COMEBACK', type: 'PERCENT', value: 10 });
    });

    const create = (b: object = {}) => request(app).post('/api/campaigns').set(auth()).send({ name: 'Autumn offer', channel: 'EMAIL', segment: 'NEW', subject: 'We miss you', body: 'Hi {{name}}, use {{code}} for 10% off.', couponCode: 'COMEBACK', ...b });
    const waitSent = async (id: string) => {
      for (let i = 0; i < 40; i++) {
        const c = (await request(app).get(`/api/campaigns/${id}`).set(auth())).body;
        if (c.status === 'SENT') return c;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('campaign did not finish');
    };

    it('validates the campaign and refuses unknown coupons', async () => {
      expect((await create({ subject: undefined })).status).toBe(400);
      expect((await create({ couponCode: 'NOPE' })).status).toBe(400);
      expect((await create()).status).toBe(201);
    });

    it('sends only to consenting customers, reports failures honestly, and cannot be sent twice', async () => {
      testOutbox.length = 0;
      const c = (await create({ name: 'Send test' })).body;
      const send = await request(app).post(`/api/campaigns/${c.id}/send`).set(auth());
      expect(send.status).toBe(202);
      expect(send.body.recipients).toBe(optedIn.length); // Nia never agreed
      const done = await waitSent(c.id);
      expect(done.stats).toMatchObject({ sent: 2, failed: 1, queued: 0 });
      expect(done.messages.find((m: any) => m.recipient.startsWith('fail-'))).toMatchObject({ status: 'FAILED', error: 'Simulated provider rejection' });
      const mail = testOutbox.find((m) => m.to === `ada-${uid}@example.com`)!;
      expect(mail.text).toContain('Hi Ada, use COMEBACK for 10% off.'); // first name + coupon code filled in
      expect(mail.text).toMatch(/\/api\/public\/unsubscribe\/[a-f0-9]{20,}/);
      expect(testOutbox.some((m) => m.to.startsWith('nia-'))).toBe(false);
      expect((await request(app).post(`/api/campaigns/${c.id}/send`).set(auth())).status).toBe(409);
      expect((await request(app).delete(`/api/campaigns/${c.id}`).set(auth())).status).toBe(409); // sent campaigns stay on record
    });

    it('honours one-click unsubscribe and attributes revenue to the campaign', async () => {
      const ada = (await prisma.customer.findFirstOrThrow({ where: { restaurantId, phone: '+919100000040' } }));
      const cy = (await prisma.customer.findFirstOrThrow({ where: { restaurantId, phone: '+919100000042' } }));

      // Cy buys using the campaign code after receiving it; Nia (never messaged) uses the same code
      const cyOrder = await order('+919100000042', 'Cy Consent', { couponCode: 'COMEBACK' });
      await order('+919100000043', 'Nia NoConsent', { couponCode: 'COMEBACK' });
      const list = (await request(app).get('/api/campaigns').set(auth())).body.find((x: any) => x.name === 'Send test');
      expect(list.stats.orders).toBe(1);
      expect(list.stats.revenueCents).toBe(cyOrder.body.totalCents);

      const un = await request(app).post(`/api/public/unsubscribe/${ada.unsubscribeToken}`); // GET only shows a confirmation page
      expect(un.status).toBe(200);
      expect(un.text).toContain('unsubscribed');
      expect((await request(app).get('/api/public/unsubscribe/not-a-token')).status).toBe(404);
      expect((await request(app).post('/api/public/unsubscribe/not-a-token')).status).toBe(404);

      testOutbox.length = 0;
      const c2 = (await create({ name: 'Second wave', segment: 'ALL' })).body; // Cy now has 2 orders, so is no longer "NEW"
      expect((await request(app).post(`/api/campaigns/${c2.id}/send`).set(auth())).body.recipients).toBe(2); // Ada is out
      await waitSent(c2.id);
      expect(testOutbox.some((m) => m.to === `ada-${uid}@example.com`)).toBe(false);
      const adaNow = (await customer('+919100000040'));
      expect(adaNow).toMatchObject({ marketingConsent: false, optedOut: true });

      // a fresh, explicit opt-in at checkout is respected again
      await order('+919100000040', 'Ada Active', { email: `ada-${uid}@example.com`, marketingConsent: true });
      expect((await customer('+919100000040')).marketingConsent).toBe(true);
      void cy;
    });

    it('refuses to send when the channel is not configured, and tells staff which channels exist', async () => {
      const c = (await create({ name: 'No channel' })).body;
      process.env.ENABLE_TEST_MESSAGING = '0';
      try {
        const r = await request(app).post(`/api/campaigns/${c.id}/send`).set(auth());
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('channel_unavailable');
        expect((await request(app).get('/api/marketing/channels').set(auth())).body).toEqual({ EMAIL: null, WHATSAPP: null });
        expect((await request(app).get(`/api/campaigns/${c.id}`).set(auth())).body.status).toBe('DRAFT'); // nothing was marked sent
      } finally {
        process.env.ENABLE_TEST_MESSAGING = '1';
      }
    });

    it('keeps other restaurants out', async () => {
      const o = await request(app).post('/api/auth/register').send({ restaurantName: `Other ${uid}`, name: 'Other', email: `mkt-other-${uid}@example.com`, password: 'Password123!' });
      const h = bearer(o.body.accessToken);
      expect((await request(app).get('/api/campaigns').set(h)).body).toEqual([]);
      const c = (await create({ name: 'Mine' })).body;
      expect((await request(app).post(`/api/campaigns/${c.id}/send`).set(h)).status).toBe(404);
      const cust = await customer('+919100000040');
      expect((await request(app).get(`/api/customers/${cust.id}`).set(h)).status).toBe(404);
      expect((await request(app).post(`/api/customers/${cust.id}/redeem`).set(h).send({ points: 50 })).status).toBe(404);
    });
  });

  it('lets the owner correct points but never below zero, and staff cannot', async () => {
    const c = await customer('+919100000010');
    const before = c.loyaltyPoints;
    expect((await request(app).post(`/api/customers/${c.id}/adjust`).set(auth()).send({ points: -9999, note: 'too much' })).status).toBe(409);
    expect((await request(app).post(`/api/customers/${c.id}/adjust`).set(auth()).send({ points: -1, note: 'x' })).status).toBe(400); // note required
    expect((await request(app).post(`/api/customers/${c.id}/adjust`).set(auth()).send({ points: 5, note: 'goodwill gesture' })).status).toBe(200);
    expect((await customer('+919100000010')).loyaltyPoints).toBe(before + 5);
    const w = await request(app).post('/api/staff').set(auth()).send({ name: 'Wally Waiter', email: `mkt-w-${uid}@example.com`, password: 'Password123!', role: 'WAITER' });
    expect(w.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: `mkt-w-${uid}@example.com`, password: 'Password123!' });
    expect((await request(app).post(`/api/customers/${c.id}/adjust`).set(bearer(login.body.accessToken)).send({ points: 5, note: 'sneaky' })).status).toBe(403);
    expect((await request(app).get('/api/campaigns').set(bearer(login.body.accessToken))).status).toBe(403);
    void tenantId;
  });
});

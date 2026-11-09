import { prisma } from '../db.js';

export const DEFAULTS = {
  ordering: {
    dineInEnabled: true, takeawayEnabled: true, deliveryEnabled: true,
    guestCheckout: true, taxRate: 0, taxInclusive: false, serviceChargePct: 0,
    minOrder: 0, tipOptions: [0, 5, 10, 15], scheduledOrdersEnabled: true,
  },
  loyalty: {
    enabled: true, pointsPerCurrency: 1, minRedeemPoints: 100, pointValue: 0.05,
    pointsExpiryDays: 365, referralBonus: 100, birthdayBonus: 50,
    tiers: [
      { name: 'Member', minLifetime: 0, multiplier: 1 },
      { name: 'Silver', minLifetime: 1000, multiplier: 1.25 },
      { name: 'Gold', minLifetime: 3000, multiplier: 1.5 },
    ],
  },
  reservations: {
    enabled: true, slotMinutes: 90, intervalMinutes: 30, maxPartySize: 12, advanceDays: 60,
    depositPerGuest: 0, depositFromGuests: 0, minNoticeMinutes: 60,
  },
  payments: { enabledMethods: ['CASH_AT_RESTAURANT', 'CASH_ON_DELIVERY'] as string[] },
  site: { multiOutlet: false, defaultLanguage: 'en', languages: ['en'], googleReviewsUrl: '', whatsappOrderMessage: 'Hello The Minerva!' },
  analytics: { gaMeasurementId: '', metaPixelId: '', searchConsoleToken: '' },
  kds: { lateAfterMinutes: 5 },
};
export type SettingsShape = typeof DEFAULTS;
export type SettingKey = keyof SettingsShape;

let cache: { at: number; value: SettingsShape } | null = null;

export async function getSettings(): Promise<SettingsShape> {
  if (cache && Date.now() - cache.at < 3000) return cache.value;
  const rows = await prisma.setting.findMany();
  const out: any = structuredClone(DEFAULTS);
  for (const r of rows) if (r.key in out) out[r.key] = { ...out[r.key], ...(r.value as object) };
  cache = { at: Date.now(), value: out };
  return out;
}
export async function setSetting(key: SettingKey, value: object) {
  const cur = (await getSettings())[key];
  const merged = { ...cur, ...value };
  await prisma.setting.upsert({ where: { key }, create: { key, value: merged }, update: { value: merged } });
  cache = null;
  return merged;
}
export const resetSettingsCache = () => { cache = null; };

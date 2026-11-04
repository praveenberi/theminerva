export interface PromoRule {
  type: 'PERCENT' | 'FIXED' | 'BOGO';
  value: number;
  minSubtotalCents: number;
  categoryId?: string | null;
  daysOfWeek: number[]; // 0 = Sunday … 6 = Saturday, in the restaurant's local time; empty = every day
  startMinute?: number | null; // minutes after local midnight; both null = all day
  endMinute?: number | null; // may be earlier than start for windows that cross midnight
}

export interface PromoLine {
  categoryId: string;
  unitCents: number;
  quantity: number;
}

/** Local weekday and minute-of-day at `now` for a restaurant whose clock is UTC+offsetMinutes. */
export function localClock(now: Date, offsetMinutes: number) {
  const t = new Date(now.getTime() + offsetMinutes * 60_000);
  return { day: t.getUTCDay(), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export function inWindow(r: Pick<PromoRule, 'daysOfWeek' | 'startMinute' | 'endMinute'>, now: Date, offsetMinutes: number): boolean {
  const { day, minute } = localClock(now, offsetMinutes);
  const { startMinute: s, endMinute: e } = r;
  if (s == null || e == null) return r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day);
  if (s <= e) return (r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day)) && minute >= s && minute < e;
  // crosses midnight (e.g. 22:00–02:00): the after-midnight part belongs to the previous day's window
  if (minute >= s) return r.daysOfWeek.length === 0 || r.daysOfWeek.includes(day);
  if (minute < e) return r.daysOfWeek.length === 0 || r.daysOfWeek.includes((day + 6) % 7);
  return false;
}

/**
 * Discount in minor units for the cart. The minimum applies to the whole cart; the discount itself only
 * touches lines in the offer's category (if it has one). BOGO makes the cheapest unit of every pair free.
 */
export function promoDiscount(r: PromoRule, lines: PromoLine[]): number {
  const subtotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  if (subtotal < r.minSubtotalCents) return 0;
  const eligible = r.categoryId ? lines.filter((l) => l.categoryId === r.categoryId) : lines;
  const base = eligible.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  if (base <= 0) return 0;
  switch (r.type) {
    case 'PERCENT': return Math.min(base, Math.round((base * r.value) / 100));
    case 'FIXED': return Math.min(base, r.value);
    case 'BOGO': {
      const units = eligible.flatMap((l) => Array<number>(l.quantity).fill(l.unitCents)).sort((a, b) => a - b);
      return units.slice(0, Math.floor(units.length / 2)).reduce((s, c) => s + c, 0);
    }
  }
}

export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

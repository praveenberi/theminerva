let currency = 'SGD';
let locale = 'en-SG';
let timezone = 'Asia/Singapore';
export const setLocaleConfig = (c: { currency?: string; locale?: string; timezone?: string }) => {
  if (c.currency) currency = c.currency;
  if (c.locale) locale = c.locale;
  if (c.timezone) timezone = c.timezone;
};
export const getTimezone = () => timezone;
export const money = (v: unknown) => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(v ?? 0));
export const dateTime = (v: string | Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(v));
export const dateOnly = (v: string | Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: timezone }).format(new Date(v));
export const timeOnly = (v: string | Date) => new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: timezone }).format(new Date(v));
export const statusLabel = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const cn = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(' ');
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

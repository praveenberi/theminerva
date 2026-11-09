import crypto from 'node:crypto';
import type { ReservationKind } from '@prisma/client';
import { prisma, dec } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { localDate, weekdayOf, zonedToUtc, addDays } from '../lib/time.js';
import { notify, staffAlert } from './notify.js';
import { broadcast } from '../lib/events.js';

const ACTIVE = ['PENDING', 'CONFIRMED', 'SEATED'] as const;

type Hours = Record<string, { open: string; close: string; closed?: boolean } | undefined>;

async function ctx() {
  const [r, s] = await Promise.all([prisma.restaurant.findUnique({ where: { id: 'minerva' } }), getSettings()]);
  return { tz: r?.timezone ?? 'Asia/Singapore', hours: (r?.openingHours ?? {}) as Hours, cfg: s.reservations };
}
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export async function availability(date: string, guests: number) {
  const { tz, hours, cfg } = await ctx();
  if (!cfg.enabled) return { date, slots: [], reason: 'Online reservations are currently disabled' };
  if (guests < 1 || guests > cfg.maxPartySize) throw badRequest(`Parties of 1–${cfg.maxPartySize} can book online. For larger groups please enquire about private dining.`);
  const today = localDate(new Date(), tz);
  if (date < today || date > addDays(today, cfg.advanceDays)) return { date, slots: [], reason: 'Date outside the booking window' };

  const day = hours[weekdayOf(date)];
  if (!day || day.closed || !day.open || !day.close) return { date, slots: [], reason: 'The restaurant is closed on this day (or opening hours are not configured)' };

  const [oh, om] = day.open.split(':').map(Number);
  const [ch, cm] = day.close.split(':').map(Number);
  const first = oh * 60 + om;
  const lastStart = ch * 60 + cm - cfg.slotMinutes;
  const tables = await prisma.diningTable.findMany({ where: { isActive: true, capacity: { gte: guests } } });
  if (!tables.length) return { date, slots: [], reason: 'No tables can seat this party size' };

  const dayStart = zonedToUtc(date, '00:00', tz);
  const dayEnd = zonedToUtc(addDays(date, 1), '00:00', tz);
  const booked = await prisma.reservation.findMany({
    where: { status: { in: [...ACTIVE] }, startAt: { lt: dayEnd }, endAt: { gt: dayStart }, tableId: { not: null } },
  });

  const slots: Array<{ time: string; startAt: string; tablesLeft: number }> = [];
  for (let m = first; m <= lastStart; m += cfg.intervalMinutes) {
    const startAt = zonedToUtc(date, hhmm(m), tz);
    const endAt = new Date(startAt.getTime() + cfg.slotMinutes * 60_000);
    if (startAt.getTime() < Date.now() + cfg.minNoticeMinutes * 60_000) continue;
    const free = tables.filter((t) => !booked.some((b) => b.tableId === t.id && b.startAt < endAt && b.endAt > startAt));
    if (free.length) slots.push({ time: hhmm(m), startAt: startAt.toISOString(), tablesLeft: free.length });
  }
  return { date, slots, depositRequired: depositFor(guests, cfg), slotMinutes: cfg.slotMinutes };
}

function depositFor(guests: number, cfg: { depositPerGuest: number; depositFromGuests: number }) {
  return cfg.depositPerGuest > 0 && guests >= Math.max(1, cfg.depositFromGuests) ? cfg.depositPerGuest * guests : 0;
}

export interface BookArgs {
  kind?: ReservationKind; date: string; time: string; guests: number; name: string; phone: string; email?: string;
  notes?: string; customerId?: string; tableId?: string;
}

export async function book(a: BookArgs) {
  const { tz, cfg, hours } = await ctx();
  const kind = a.kind ?? 'TABLE';
  const startAt = zonedToUtc(a.date, a.time, tz);
  const endAt = new Date(startAt.getTime() + cfg.slotMinutes * 60_000);
  if (isNaN(startAt.getTime())) throw badRequest('Invalid date or time');
  if (startAt.getTime() < Date.now()) throw badRequest('That time has already passed');
  if (!cfg.enabled && kind === 'TABLE') throw badRequest('Online reservations are currently disabled');

  if (kind !== 'TABLE') {
    // events / private dining are requests the team confirms manually
    const res = await prisma.reservation.create({
      data: { reference: ref(), kind, name: a.name, phone: a.phone, email: a.email?.toLowerCase(), guests: a.guests, startAt, endAt, notes: a.notes, status: 'PENDING', customerId: a.customerId },
    });
    void staffAlert('reservation', `New ${kind.replace('_', ' ').toLowerCase()} request from ${a.name} (${a.guests} guests)`);
    broadcast('staff', 'reservation.new', { id: res.id });
    return res;
  }

  if (a.guests > cfg.maxPartySize) throw badRequest(`Online bookings are limited to ${cfg.maxPartySize} guests`);
  const day = hours[weekdayOf(a.date)];
  if (!day || day.closed) throw badRequest('The restaurant is closed on that day');
  const close = zonedToUtc(a.date, day.close, tz);
  if (endAt > close) throw badRequest('That slot ends after closing time');

  const deposit = depositFor(a.guests, cfg);
  const res = await prisma.$transaction(async (tx) => {
    // serialise bookings for the same calendar day so two requests can never take the same table
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'resv:' + a.date}))`;
    const tables = await tx.diningTable.findMany({
      where: { isActive: true, capacity: { gte: a.guests }, ...(a.tableId ? { id: a.tableId } : {}) },
      orderBy: { capacity: 'asc' },
    });
    for (const t of tables) {
      const clash = await tx.reservation.count({ where: { tableId: t.id, status: { in: [...ACTIVE] }, startAt: { lt: endAt }, endAt: { gt: startAt } } });
      if (clash === 0) {
        return tx.reservation.create({
          data: {
            reference: ref(), kind, name: a.name, phone: a.phone, email: a.email?.toLowerCase(), guests: a.guests, tableId: t.id,
            startAt, endAt, notes: a.notes, customerId: a.customerId, depositAmount: dec(deposit), status: deposit > 0 ? 'PENDING' : 'CONFIRMED',
          },
          include: { table: true },
        });
      }
    }
    throw conflict('Sorry, that time is no longer available. Please choose another slot.');
  });

  void notify('reservation.confirmed', { name: res.name, phone: res.phone, email: res.email }, vars(res, tz));
  void staffAlert('reservation', `New reservation: ${res.name}, ${res.guests} guests, ${a.date} ${a.time}`);
  broadcast('staff', 'reservation.new', { id: res.id });
  return res;
}

export const vars = (r: { reference: string; guests: number; startAt: Date }, tz = 'Asia/Singapore') => ({
  reference: r.reference, guests: r.guests,
  when: new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(r.startAt),
});
const ref = () => 'MIN-' + crypto.randomBytes(3).toString('hex').toUpperCase();

export async function cancel(id: string) {
  const r = await prisma.reservation.findUnique({ where: { id } });
  if (!r) throw notFound('Reservation');
  if (!['PENDING', 'CONFIRMED'].includes(r.status)) throw conflict('This reservation can no longer be cancelled');
  const up = await prisma.reservation.update({ where: { id }, data: { status: 'CANCELLED' } });
  const { tz } = await ctx();
  void notify('reservation.cancelled', { name: r.name, phone: r.phone, email: r.email }, vars(r, tz));
  void staffAlert('reservation', `Reservation ${r.reference} cancelled`);
  return up;
}

export async function reschedule(id: string, date: string, time: string) {
  const { tz, cfg } = await ctx();
  const startAt = zonedToUtc(date, time, tz);
  const endAt = new Date(startAt.getTime() + cfg.slotMinutes * 60_000);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'resv:' + date}))`;
    const r = await tx.reservation.findUnique({ where: { id } });
    if (!r) throw notFound('Reservation');
    if (!['PENDING', 'CONFIRMED'].includes(r.status)) throw conflict('This reservation can no longer be changed');
    if (r.tableId) {
      const clash = await tx.reservation.count({ where: { id: { not: id }, tableId: r.tableId, status: { in: [...ACTIVE] }, startAt: { lt: endAt }, endAt: { gt: startAt } } });
      if (clash) throw conflict('That table is not free at the new time');
    }
    return tx.reservation.update({ where: { id }, data: { startAt, endAt } });
  });
}

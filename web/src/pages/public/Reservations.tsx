import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { CalendarCheck } from 'lucide-react';
import { Button, Card, ErrorState, Field, Input, Select, Skeleton, Textarea, Tabs } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useHome, useSeo } from '@/lib/hooks';
import { cn, dateTime, money } from '@/lib/format';

const today = () => new Intl.DateTimeFormat('en-CA').format(new Date());
const schema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')),
  notes: z.string().max(1000).optional(),
});

export default function Reservations() {
  useSeo('Reserve a table', 'Book a table at The Minerva.');
  const { user } = useAuth();
  const { data: home } = useHome();
  const [kind, setKind] = useState<'TABLE' | 'EVENT' | 'PRIVATE_DINING'>('TABLE');
  const [date, setDate] = useState(today());
  const [guests, setGuests] = useState(2);
  const [slot, setSlot] = useState<string>('');
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState('19:00');
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: user?.name ?? '', phone: '', email: user?.email ?? '', notes: '' } });
  const av = useQuery({ queryKey: ['avail', date, guests], enabled: kind === 'TABLE' && guests >= 1, retry: false, queryFn: () => api('/api/reservations/availability', { query: { date, guests } }) });
  useEffect(() => setSlot(''), [date, guests, kind]);

  const submit = form.handleSubmit(async (v) => {
    setBusy(true); setErr(null);
    try {
      const t = kind === 'TABLE' ? slot : time;
      if (!t) throw new Error('Please choose a time');
      setDone(await api('/api/reservations', { body: { kind, date, time: t, guests, name: v.name, phone: v.phone, email: v.email || undefined, notes: v.notes || undefined } }));
    } catch (e) { setErr(e); av.refetch(); }
    finally { setBusy(false); }
  });

  if (done) return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-success/15 text-success"><CalendarCheck className="h-8 w-8" /></motion.div>
      <h1 className="text-4xl">{done.status === 'CONFIRMED' ? 'You’re booked' : 'Request received'}</h1>
      <p className="mt-2 text-muted">{done.status === 'CONFIRMED' ? 'Your table is confirmed.' : done.kind !== 'TABLE' ? 'Our team will contact you to confirm the details.' : 'A deposit is required to confirm your booking — we will contact you.'}</p>
      <Card className="mt-6 p-5 text-left text-sm"><p>Reference <strong className="font-mono">{done.reference}</strong></p><p>{dateTime(done.startAt)} · {done.guests} guests</p>
        {Number(done.depositAmount) > 0 && <p>Deposit: {money(done.depositAmount)}</p>}</Card>
      <p className="mt-4 text-xs text-muted">Keep your reference to change or cancel your booking.</p>
    </div>
  );

  const e = form.formState.errors;
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-4xl">Reserve</h1>
      <div className="mt-6"><Tabs value={kind} onChange={setKind} tabs={[{ id: 'TABLE', label: 'Table' }, { id: 'EVENT', label: 'Event' }, { id: 'PRIVATE_DINING', label: 'Private dining' }]} /></div>
      {home && !home.config.reservationsEnabled && kind === 'TABLE' && <div className="mt-6"><ErrorState error={new Error('Online table reservations are currently unavailable. Please contact us.')} /></div>}
      <form onSubmit={submit} className="mt-6 space-y-6" noValidate>
        <Card className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="Date">{(id) => <Input id={id} type="date" min={today()} value={date} onChange={(ev) => setDate(ev.target.value)} />}</Field>
          <Field label="Guests">{(id) => <Select id={id} value={guests} onChange={(ev) => setGuests(+ev.target.value)}>{Array.from({ length: kind === 'TABLE' ? 12 : 60 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select>}</Field>
          {kind !== 'TABLE' && <Field label="Preferred time">{(id) => <Input id={id} type="time" value={time} onChange={(ev) => setTime(ev.target.value)} />}</Field>}
        </Card>

        {kind === 'TABLE' && (
          <section aria-live="polite">
            <h2 className="mb-3 text-xl">Available times</h2>
            {av.isLoading ? <div className="flex flex-wrap gap-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-10 w-20" />)}</div>
              : av.error ? <ErrorState error={av.error} retry={() => av.refetch()} />
              : av.data.slots.length === 0 ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">{av.data.reason ?? 'No tables are free on this date for that party size. Try another day.'}</p>
              : <div role="radiogroup" aria-label="Time" className="flex flex-wrap gap-2">{av.data.slots.map((s: any) => (
                  <button type="button" role="radio" aria-checked={slot === s.time} key={s.time} onClick={() => setSlot(s.time)} className={cn('rounded-xl border px-4 py-2 text-sm font-medium', slot === s.time ? 'border-brand bg-brand text-brand-fg' : 'border-border hover:bg-surface-2')}>{s.time}</button>))}</div>}
            {av.data?.depositRequired > 0 && <p className="mt-2 text-sm text-muted">A deposit of {money(av.data.depositRequired)} applies to this booking.</p>}
          </section>
        )}

        <Card className="space-y-4 p-5">
          <h2 className="text-xl">Your details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={e.name?.message}>{(id) => <Input id={id} autoComplete="name" {...form.register('name')} />}</Field>
            <Field label="Mobile number" error={e.phone?.message}>{(id) => <Input id={id} type="tel" autoComplete="tel" {...form.register('phone')} />}</Field>
            <Field label="Email (optional)" error={e.email?.message} className="sm:col-span-2">{(id) => <Input id={id} type="email" autoComplete="email" {...form.register('email')} />}</Field>
            <Field label="Special requests" className="sm:col-span-2">{(id) => <Textarea id={id} placeholder="Occasion, seating, allergies…" {...form.register('notes')} />}</Field>
          </div>
        </Card>
        {!!err && <ErrorState error={new Error(errorMessage(err))} />}
        <Button size="lg" className="w-full" loading={busy} disabled={kind === 'TABLE' && !slot}>{kind === 'TABLE' ? 'Confirm reservation' : 'Send request'}</Button>
      </form>
    </div>
  );
}

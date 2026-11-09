import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Bike, ShoppingBag, Store, Tag, UtensilsCrossed } from 'lucide-react';
import { Button, Card, ErrorState, Field, Input, Select, Skeleton, Textarea, useToast } from '@/components/ui';
import { PayOnline } from '@/components/PayOnline';
import { BranchPicker } from '@/components/BranchPicker';
import { usePublicOutlets } from '@/lib/outlet';
import { recallContact, rememberContact, rememberOrder } from '@/lib/myorders';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart, type OrderMode } from '@/lib/cart';
import { useHome, useSeo } from '@/lib/hooks';
import { cn, money, statusLabel } from '@/lib/format';

const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');
const schema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  phone, email: z.string().trim().email('Enter a valid email').or(z.literal('')),
  address: z.string().trim().max(300).optional(), postal: z.string().trim().max(12).optional(),
  deliveryNotes: z.string().max(300).optional(), notes: z.string().max(500).optional(),
  scheduledFor: z.string().optional(),
});
// when this table already has an open order, name/phone are reused from it and become optional
const relaxed = schema.extend({ name: z.string().trim().max(80), phone: phone.or(z.literal('')) });
type Form = z.infer<typeof schema>;

export default function Checkout() {
  useSeo('Checkout');
  const { state, dispatch } = useCart();
  const { user } = useAuth();
  const { data: home } = useHome();
  const nav = useNavigate();
  const toast = useToast();
  const [coupon, setCoupon] = useState('');
  const [appliedCoupon, setApplied] = useState('');
  const [couponError, setCouponError] = useState('');
  const [tip, setTip] = useState(0);
  const [redeem, setRedeem] = useState(0);
  const [voucher, setVoucher] = useState('');
  const [method, setMethod] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [placed, setPlaced] = useState<{ order: any; pay?: any } | null>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const tables = useQuery({ queryKey: ['public-tables'], queryFn: () => api('/api/public/tables'), staleTime: 60_000 });
  const [tableLabel, setTableLabel] = useState('');
  const [idem] = useState(() => crypto.randomUUID());
  const mode = state.mode;
  const outlets = usePublicOutlets();
  const outletId = mode === 'DINE_IN' ? undefined : state.outletId;
  const needsBranch = (outlets.data?.length ?? 0) > 0 && mode !== 'DINE_IN' && !state.outletId;
  const customer = user?.kind === 'customer';

  const profile = useQuery({ queryKey: ['me-profile'], queryFn: () => api('/api/customers/me/profile'), enabled: customer });
  const tableInfo = useQuery({ queryKey: ['table', state.tableToken], enabled: !!state.tableToken && mode === 'DINE_IN', queryFn: () => api(`/api/public/table/${state.tableToken}`), retry: false });
  const known = !customer && mode === 'DINE_IN' && state.tableToken ? tableInfo.data?.knownGuest : null;
  const knownRef = useRef<any>(null);
  knownRef.current = known;
  const form = useForm<Form>({ resolver: ((v: any, c: any, o: any) => zodResolver(knownRef.current ? relaxed : schema)(v, c, o)) as any, defaultValues: { name: '', phone: '', email: '', address: '', postal: '', deliveryNotes: '', notes: '', scheduledFor: '' } });
  useEffect(() => {
    if (profile.data) { form.reset({ ...form.getValues(), name: profile.data.name ?? '', phone: profile.data.phone ?? '', email: profile.data.email ?? '' }); }
  }, [profile.data]); // eslint-disable-line

  // second order at the same table: fill name / phone / email from this device's earlier order, else the name from the open order
  const mine = state.tableToken && mode === 'DINE_IN' && !customer && tableInfo.data?.knownGuest ? recallContact(state.tableToken, tableInfo.data?.session?.openedAt) : null;
  useEffect(() => {
    if (mine) {
      if (!form.getValues('name') && mine.name) form.setValue('name', mine.name);
      if (!form.getValues('phone') && mine.phone) form.setValue('phone', mine.phone);
      if (!form.getValues('email') && mine.email) form.setValue('email', mine.email);
    } else if (known?.name && !form.getValues('name')) form.setValue('name', known.name);
  }, [mine?.phone, mine?.name, known?.name]); // eslint-disable-line
  const postal = form.watch('postal');
  const items = state.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes }));
  const quoteKey = JSON.stringify({ outletId, items, mode, appliedCoupon, tip, redeem, voucher, postal: mode === 'DELIVERY' ? postal : '' });
  const quote = useQuery({
    queryKey: ['quote', quoteKey], enabled: state.lines.length > 0 && !needsBranch && (mode !== 'DELIVERY' || !!postal), retry: false,
    queryFn: () => api('/api/orders/quote', { body: { items, type: mode, outletId, couponCode: appliedCoupon || undefined, voucherCode: voucher || undefined, redeemPoints: redeem || undefined, tip: tip || undefined, deliveryPostal: mode === 'DELIVERY' ? postal : undefined } }),
  });
  const q = quote.data;

  const allowed = home?.config.payments ?? [];
  const methods = useMemo(() => allowed.filter((m: string) => (mode === 'DELIVERY' ? m !== 'CASH_AT_RESTAURANT' : m !== 'CASH_ON_DELIVERY')), [allowed, mode]);
  useEffect(() => { if (!methods.includes(method)) setMethod(methods[0] ?? ''); }, [methods]); // eslint-disable-line

  if (placed) return <PlacedView placed={placed} home={home} />;
  if (!state.lines.length) return (
    <div className="mx-auto max-w-lg px-4 py-20 text-center"><h1 className="text-3xl">Your cart is empty</h1><Link to="/menu"><Button className="mt-6">Browse the menu</Button></Link></div>
  );

  const modes: Array<[OrderMode, string, typeof Store, boolean]> = [
    ['DINE_IN', 'Dine in', UtensilsCrossed, home?.config.ordering.dineIn !== false], ['TAKEAWAY', 'Takeaway', ShoppingBag, home?.config.ordering.takeaway !== false],
    ['DELIVERY', 'Delivery', Bike, home?.config.ordering.delivery !== false],
  ];

  const submit = form.handleSubmit(async (v) => {
    setSubmitting(true); setFormError(null);
    try {
      if (mode === 'DINE_IN' && !state.tableToken && !tableLabel) throw new Error('Please choose your table number');
      if (mode === 'DELIVERY' && (!v.address || !v.postal)) throw new Error('Delivery address and postal code are required');
      const order = await api('/api/orders', {
        headers: { 'Idempotency-Key': idem },
        body: {
          items, type: mode, outletId, tableToken: mode === 'DINE_IN' ? state.tableToken : undefined, tableLabel: mode === 'DINE_IN' && !state.tableToken ? tableLabel : undefined,
          guest: { name: v.name || undefined, phone: v.phone || undefined, email: v.email || undefined },
          deliveryAddress: mode === 'DELIVERY' ? v.address : undefined, deliveryPostal: mode === 'DELIVERY' ? v.postal : undefined, deliveryNotes: v.deliveryNotes || undefined,
          scheduledFor: v.scheduledFor ? new Date(v.scheduledFor).toISOString() : undefined, notes: v.notes || undefined,
          couponCode: appliedCoupon || undefined, voucherCode: voucher || undefined, redeemPoints: redeem || undefined, tip: tip || undefined,
        },
      });
      rememberOrder({ token: order.trackingToken, number: order.number });
      if (state.tableToken && mode === 'DINE_IN') rememberContact(state.tableToken, { name: v.name, phone: v.phone, email: v.email || undefined });
      let pay: any;
      if (method) {
        try { pay = await api('/api/payments/create', { headers: { 'Idempotency-Key': `${idem}-pay` }, body: { orderToken: order.trackingToken, method } }); }
        catch (e) { toast('error', `Your order was placed, but payment could not start: ${errorMessage(e)}. You can pay at the restaurant or retry from the tracking page.`); }
      }
      dispatch({ t: 'clear' });
      setPlaced({ order, pay });
      if (!pay || (!pay.clientSecret && !pay.razorpay)) nav(`/track/${order.trackingToken}`);
    } catch (e) { setFormError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    finally { setSubmitting(false); }
  });

  const e = form.formState.errors;
  return (
    <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 lg:grid-cols-[1fr_380px]">
      <form onSubmit={submit} className="space-y-6" noValidate>
        <h1 className="text-4xl">Checkout</h1>
        {!!formError && <ErrorState error={formError} />}

        {mode !== 'DINE_IN' && <BranchPicker required />}
        <fieldset className="space-y-2"><legend className="mb-2 font-medium">How would you like your order?</legend>
          <div className="grid grid-cols-3 gap-2">
            {modes.map(([m, label, Icon, ok]) => (
              <button type="button" key={m} disabled={!ok} aria-pressed={mode === m} onClick={() => dispatch({ t: 'mode', mode: m })}
                className={cn('flex flex-col items-center gap-1 rounded-xl border p-3 text-sm font-medium disabled:opacity-40', mode === m ? 'border-accent bg-accent/10' : 'border-border')}><Icon className="h-5 w-5" />{label}</button>
            ))}
          </div>
          {mode === 'DINE_IN' && state.tableToken && <p className="text-sm text-muted">Serving to table {state.tableLabel}. <button type="button" className="underline" onClick={() => dispatch({ t: 'table' })}>Not your table?</button></p>}
          {mode === 'DINE_IN' && !state.tableToken && (
            <Field label="Your table number" hint="Printed on your table. Scanning the table QR code fills this in automatically.">{(id) => <Select id={id} value={tableLabel} onChange={(e) => setTableLabel(e.target.value)}><option value="">Choose table…</option>{(tables.data ?? []).map((t: any) => <option key={t.label} value={t.label}>Table {t.label} ({t.capacity} seats)</option>)}</Select>}</Field>
          )}
        </fieldset>

        <Card className="space-y-4 p-5">
          <h2 className="text-xl">Your details</h2>
          {!customer && <p className="text-sm text-muted">Checking out as a guest. <Link className="underline" to="/login">Sign in</Link> to earn rewards.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={e.name?.message}>{(id) => <Input id={id} autoComplete="name" {...form.register('name')} aria-invalid={!!e.name} />}</Field>
            <Field label="Mobile number" error={e.phone?.message} hint={known ? `Leave blank to keep using ${known.phoneMasked ?? 'the contact'} from your earlier order at this table` : 'For order updates'}>{(id) => <Input id={id} type="tel" autoComplete="tel" {...form.register('phone')} aria-invalid={!!e.phone} />}</Field>
            <Field label="Email (optional)" error={e.email?.message} className="sm:col-span-2">{(id) => <Input id={id} type="email" autoComplete="email" {...form.register('email')} />}</Field>
          </div>
          {mode === 'DELIVERY' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Delivery address" className="sm:col-span-2">{(id) => <Input id={id} autoComplete="street-address" {...form.register('address')} />}</Field>
              <Field label="Postal code">{(id) => <Input id={id} autoComplete="postal-code" {...form.register('postal')} />}</Field>
              <Field label="Delivery instructions" className="sm:col-span-3">{(id) => <Input id={id} placeholder="Gate code, leave at door…" {...form.register('deliveryNotes')} />}</Field>
            </div>
          )}
          {mode !== 'DINE_IN' && home?.config.ordering.scheduled && (
            <Field label="Schedule for later (optional)" hint="Leave empty for as soon as possible">{(id) => <Input id={id} type="datetime-local" {...form.register('scheduledFor')} />}</Field>
          )}
          <Field label="Order notes (optional)">{(id) => <Textarea id={id} {...form.register('notes')} />}</Field>
        </Card>

        {customer && profile.data?.loyalty.enabled && profile.data.loyaltyPoints >= profile.data.loyalty.minRedeemPoints && (
          <Card className="space-y-3 p-5">
            <h2 className="text-xl">Use your rewards</h2>
            <p className="text-sm text-muted">You have {profile.data.loyaltyPoints} points (worth {money(profile.data.loyaltyPoints * profile.data.loyalty.pointValue)}).</p>
            <div className="flex flex-wrap gap-3">
              <Field label="Points to redeem">{(id) => <Input id={id} type="number" min={0} max={profile.data.loyaltyPoints} step={10} value={redeem || ''} onChange={(ev) => setRedeem(Math.max(0, Math.min(profile.data.loyaltyPoints, Number(ev.target.value) || 0)))} className="w-40" />}</Field>
              <Field label="Voucher code">{(id) => <Input id={id} value={voucher} onChange={(ev) => setVoucher(ev.target.value.toUpperCase())} className="w-40" />}</Field>
            </div>
          </Card>
        )}

        <Card className="space-y-3 p-5">
          <h2 className="text-xl">Payment</h2>
          {methods.length === 0 ? <p className="text-sm text-muted">No payment methods are enabled. Please contact the restaurant.</p> : (
            <div className="grid gap-2 sm:grid-cols-2">
              {methods.map((m: string) => (
                <label key={m} className="flex cursor-pointer items-center gap-2 rounded-xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10">
                  <input type="radio" name="pay" checked={method === m} onChange={() => setMethod(m)} className="accent-[hsl(var(--accent))]" />{m === 'CARD' ? 'Credit / debit card' : m === 'CASH_AT_RESTAURANT' ? 'Pay at the restaurant' : m === 'CASH_ON_DELIVERY' ? 'Cash on delivery' : statusLabel(m)}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">Online payments are confirmed by our payment provider before your order is accepted. Card details never touch our servers.</p>
        </Card>

        <Button size="lg" className="w-full" loading={submitting} disabled={quote.isError || !q || needsBranch}>Place order{q ? ` · ${money(q.total)}` : ''}</Button>
      </form>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <Card className="space-y-4 p-5">
          <h2 className="text-xl">Order summary</h2>
          <ul className="space-y-2 text-sm">
            {state.lines.map((l) => <li key={l.key} className="flex justify-between gap-3"><span>{l.quantity} × {l.name}{l.variantName ? ` (${l.variantName})` : ''}</span><span>{money(l.unitPrice * l.quantity)}</span></li>)}
          </ul>
          <form className="flex gap-2" onSubmit={async (ev) => { ev.preventDefault(); setCouponError(''); if (!coupon.trim()) return; setApplied(coupon.trim().toUpperCase()); }}>
            <div className="relative flex-1"><Tag className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><Input aria-label="Promo code" placeholder="Promo code" className="pl-9" value={coupon} onChange={(ev) => setCoupon(ev.target.value)} /></div>
            <Button type="submit" variant="outline">Apply</Button>
          </form>
          {couponError && <p className="text-sm text-danger" role="alert">{couponError}</p>}
          {quote.isLoading && <Skeleton className="h-28" />}
          {quote.error && <div role="alert" className="space-y-2 text-sm text-danger">{errorMessage(quote.error)}{appliedCoupon && <button type="button" className="ml-2 underline" onClick={() => { setApplied(''); setCoupon(''); }}>Remove code</button>}</div>}
          {mode === 'DELIVERY' && !postal && <p className="text-sm text-muted">Enter your postal code to see the delivery fee.</p>}
          {q && (
            <dl className="space-y-1.5 text-sm">
              <Row k="Subtotal" v={money(q.subtotal)} />
              {q.discount > 0 && <Row k="Discount" v={`− ${money(q.discount)}`} tone="success" />}
              {q.serviceCharge > 0 && <Row k="Service charge" v={money(q.serviceCharge)} />}
              {q.deliveryFee > 0 && <Row k="Delivery" v={money(q.deliveryFee)} />}
              {q.tax > 0 && <Row k="Tax" v={money(q.tax)} />}
              {home?.config.ordering.tipOptions?.length > 1 && (
                <div className="flex items-center justify-between gap-2 py-1"><dt>Tip</dt>
                  <dd className="flex gap-1">{home.config.ordering.tipOptions.map((p: number) => <button type="button" key={p} aria-pressed={tip === +(q.subtotal * p / 100).toFixed(2) && p > 0 || (p === 0 && tip === 0)} onClick={() => setTip(+(q.subtotal * p / 100).toFixed(2))} className="rounded-full border border-border px-2 py-0.5 text-xs aria-pressed:border-accent aria-pressed:bg-accent/10">{p === 0 ? 'None' : `${p}%`}</button>)}</dd></div>
              )}
              {q.tip > 0 && <Row k="Tip" v={money(q.tip)} />}
              <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><dt>Total</dt><dd>{money(q.total)}</dd></div>
              <p className="pt-1 text-xs text-muted">Estimated preparation: {q.prepMinutes} min</p>
            </dl>
          )}
        </Card>
      </aside>
    </div>
  );
}

const Row = ({ k, v, tone }: { k: string; v: string; tone?: 'success' }) => <div className={cn('flex justify-between', tone === 'success' && 'text-success')}><dt>{k}</dt><dd>{v}</dd></div>;

function PlacedView({ placed, home }: { placed: { order: any; pay?: any }; home: any }) {
  const nav = useNavigate();
  const url = `${location.origin}/track/${placed.order.trackingToken}`;
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-12">
      <div className="text-center"><h1 className="text-4xl">Order #{placed.order.number} received</h1><p className="mt-2 text-muted">Complete your payment to send it to the kitchen.</p></div>
      <Card className="p-5">
        <PayOnline result={placed.pay} publishableKey={home?.config.onlinePayments.stripePublishableKey} returnUrl={url} onSubmitted={() => nav(`/track/${placed.order.trackingToken}`)} />
        <Button variant="ghost" className="mt-3 w-full" onClick={() => nav(`/track/${placed.order.trackingToken}`)}>Track this order</Button>
      </Card>
    </div>
  );
}

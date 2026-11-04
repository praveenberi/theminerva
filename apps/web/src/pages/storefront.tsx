import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, Check, Leaf, Minus, Phone, Plus, Search, ShoppingBag } from 'lucide-react';
import { api, errMsg, money, safeRedirect } from '../lib';
import { Empty, Field, Modal, Page, Skeleton, useToast } from '../ui';

interface Opt { id: string; name: string; priceCents: number }
interface Product { id: string; name: string; description: string; priceCents: number; discountPriceCents: number | null; imageUrl: string | null; available: boolean; dietary: string[]; allergens: string[]; variants: Opt[]; addons: Opt[] }
interface Menu { restaurant: any; categories: { id: string; name: string; products: Product[] }[] }
interface Line { key: string; productId: string; name: string; unitCents: number; quantity: number; variantId?: string; addonIds: string[]; options: string[]; notes?: string }

const unitOf = (p: Product, v?: Opt, addons: Opt[] = []) => (p.discountPriceCents ?? p.priceCents) + (v?.priceCents ?? 0) + addons.reduce((s, a) => s + a.priceCents, 0);

function useCart(slug: string) {
  const k = `cart:${slug}`;
  const [lines, setLines] = useState<Line[]>(() => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } });
  useEffect(() => { try { localStorage.setItem(k, JSON.stringify(lines)); } catch { /* storage unavailable */ } }, [k, lines]);
  const add = (l: Line) => setLines((cur) => {
    const i = cur.findIndex((x) => x.key === l.key);
    return i < 0 ? [...cur, l] : cur.map((x, j) => (j === i ? { ...x, quantity: x.quantity + l.quantity } : x));
  });
  const setQty = (key: string, q: number) => setLines((cur) => (q <= 0 ? cur.filter((x) => x.key !== key) : cur.map((x) => (x.key === key ? { ...x, quantity: q } : x))));
  return { lines, add, setQty, clear: () => setLines([]), count: lines.reduce((s, l) => s + l.quantity, 0), subtotal: lines.reduce((s, l) => s + l.unitCents * l.quantity, 0) };
}

export function Storefront() {
  const { slug = '' } = useParams();
  const [sp] = useSearchParams();
  const { data, isLoading, error } = useQuery({ queryKey: ['menu', slug], queryFn: () => api<Menu>(`/public/${slug}`) });
  const cart = useCart(slug);
  const [q, setQ] = useState('');
  const [veg, setVeg] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [picked, setPicked] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);

  const cur = data?.restaurant.currency ?? 'INR';
  const cats = useMemo(() => (data?.categories ?? []).map((c) => ({
    ...c, products: c.products.filter((p) => (!q || (p.name + p.description).toLowerCase().includes(q.toLowerCase())) && (!veg || p.dietary.includes('VEG') || p.dietary.includes('VEGAN'))),
  })).filter((c) => c.products.length && (!active || c.id === active)), [data, q, veg, active]);

  if (isLoading) return <div className="mx-auto max-w-2xl space-y-3 p-4"><Skeleton className="h-32" /><Skeleton /><Skeleton /></div>;
  if (error || !data) return <div className="mx-auto max-w-md p-8"><Empty title="Restaurant not found" hint="This storefront does not exist or is not published yet."><Link className="btn-primary" to="/">Go home</Link></Empty></div>;
  const r = data.restaurant;

  return (
    <Page>
      <div className="mx-auto max-w-2xl pb-28">
        <div className="bg-gradient-to-br from-brand-500 to-brand-700 px-5 pb-6 pt-10 text-white">
          <h1 className="text-3xl font-extrabold">{r.name}</h1>
          {r.acceptingOrders === false && <p className="mt-2 rounded-lg bg-black/30 px-3 py-1.5 text-sm font-semibold">Not taking online orders right now</p>}
          {r.bannerText && <p className="mt-2 inline-block rounded-lg bg-white/20 px-3 py-1.5 text-sm font-semibold">{r.bannerText}</p>}
          <p className="mt-1 text-white/90">{r.description}</p>
          <p className="mt-2 text-sm text-white/80">{r.address} · {r.openTime}–{r.closeTime}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {r.phone && <a className="btn bg-white/20 text-white hover:bg-white/30" href={`tel:${r.phone}`}><Phone size={16} /> Call</a>}
            {r.whatsapp && <a className="btn bg-white/20 text-white hover:bg-white/30" href={`https://wa.me/${r.whatsapp.replace(/\D/g, '')}`}>WhatsApp</a>}
            {r.reservations && <button className="btn bg-white text-brand-700" onClick={() => setReserveOpen(true)}><CalendarDays size={16} /> Book a table</button>}
          </div>
          {sp.get('table') && <p className="mt-3 inline-block rounded-full bg-black/25 px-3 py-1 text-sm font-semibold">Ordering for table {sp.get('table')}</p>}
        </div>

        <div className="sticky top-0 z-10 space-y-2 bg-stone-50/95 p-3 backdrop-blur">
          <div className="flex gap-2">
            <div className="relative flex-1"><Search className="absolute left-3 top-3 text-stone-400" size={16} /><input className="input pl-9" placeholder="Search the menu" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the menu" /></div>
            <button className={`btn ${veg ? 'bg-green-600 text-white' : 'btn-ghost'}`} onClick={() => setVeg(!veg)} aria-pressed={veg}><Leaf size={16} /> Veg</button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[{ id: null as string | null, name: 'All' }, ...data.categories].map((c) => (
              <button key={c.id ?? 'all'} onClick={() => setActive(c.id)} className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold ${active === c.id ? 'bg-stone-900 text-white' : 'bg-white ring-1 ring-stone-200'}`}>{c.name}</button>
            ))}
          </div>
        </div>

        <div className="space-y-6 px-3">
          {cats.length === 0 && <Empty title="Nothing matches" hint="Try a different search or clear the filters." />}
          {cats.map((c) => (
            <section key={c.id}>
              <h2 className="mb-2 text-lg font-bold">{c.name}</h2>
              <div className="space-y-2">
                {c.products.map((p) => (
                  <motion.button layout key={p.id} whileTap={{ scale: 0.98 }} disabled={!p.available} onClick={() => setPicked(p)}
                    className="card flex w-full items-start justify-between gap-3 p-4 text-left disabled:opacity-50">
                    <div>
                      <p className="font-semibold">{p.name} {p.dietary.includes('VEG') || p.dietary.includes('VEGAN') ? <Leaf className="inline text-green-600" size={14} /> : null}</p>
                      <p className="mt-0.5 text-sm text-stone-600">{p.description}</p>
                      {!p.available && <p className="mt-1 text-xs font-semibold text-red-600">Currently unavailable</p>}
                    </div>
                    <div className="shrink-0 text-right font-semibold">
                      {money(p.discountPriceCents ?? p.priceCents, cur)}
                      {p.discountPriceCents != null && <div className="text-xs font-normal text-stone-400 line-through">{money(p.priceCents, cur)}</div>}
                    </div>
                  </motion.button>
                ))}
              </div>
            </section>
          ))}
        </div>

        <AnimatePresence>
          {cart.count > 0 && (
            <motion.div initial={{ y: 80 }} animate={{ y: 0 }} exit={{ y: 80 }} className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-2xl p-3">
              <button className="btn-primary w-full justify-between py-4 text-base shadow-xl" onClick={() => setCartOpen(true)}>
                <span className="flex items-center gap-2"><ShoppingBag size={18} /> {cart.count} item{cart.count > 1 ? 's' : ''}</span><span>View cart · {money(cart.subtotal, cur)}</span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <ProductModal product={picked} cur={cur} onClose={() => setPicked(null)} onAdd={(l) => { cart.add(l); setPicked(null); }} />
      <CartModal open={cartOpen} onClose={() => setCartOpen(false)} cart={cart} restaurant={r} slug={slug} table={sp.get('table') ?? ''} />
      <ReserveModal open={reserveOpen} onClose={() => setReserveOpen(false)} slug={slug} />
    </Page>
  );
}

function ProductModal({ product: p, cur, onClose, onAdd }: { product: Product | null; cur: string; onClose: () => void; onAdd: (l: Line) => void }) {
  const [variant, setVariant] = useState<string>('');
  const [addons, setAddons] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  useEffect(() => { setVariant(p?.variants[0]?.id ?? ''); setAddons([]); setQty(1); setNotes(''); }, [p]);
  if (!p) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const v = p.variants.find((x) => x.id === variant);
  const chosen = p.addons.filter((a) => addons.includes(a.id));
  const unit = unitOf(p, v, chosen);
  return (
    <Modal open onClose={onClose} title={p.name}>
      <p className="text-sm text-stone-600">{p.description}</p>
      {p.allergens.length > 0 && <p className="mt-2 text-xs font-semibold text-amber-700">Contains: {p.allergens.join(', ')}</p>}
      {p.variants.length > 0 && (
        <fieldset className="mt-4"><legend className="label">Size</legend>
          {p.variants.map((o) => (
            <label key={o.id} className="flex items-center justify-between py-1.5 text-sm"><span><input type="radio" className="mr-2" checked={variant === o.id} onChange={() => setVariant(o.id)} />{o.name}</span><span>{o.priceCents ? `+${money(o.priceCents, cur)}` : ''}</span></label>
          ))}
        </fieldset>
      )}
      {p.addons.length > 0 && (
        <fieldset className="mt-4"><legend className="label">Add-ons</legend>
          {p.addons.map((o) => (
            <label key={o.id} className="flex items-center justify-between py-1.5 text-sm"><span><input type="checkbox" className="mr-2" checked={addons.includes(o.id)} onChange={(e) => setAddons(e.target.checked ? [...addons, o.id] : addons.filter((x) => x !== o.id))} />{o.name}</span><span>+{money(o.priceCents, cur)}</span></label>
          ))}
        </fieldset>
      )}
      <div className="mt-4"><Field label="Special instructions"><input className="input" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. no onions" /></Field></div>
      <div className="mt-5 flex items-center gap-3">
        <div className="flex items-center gap-3 rounded-xl ring-1 ring-stone-300">
          <button className="p-3" aria-label="Decrease" onClick={() => setQty(Math.max(1, qty - 1))}><Minus size={16} /></button>
          <span className="w-5 text-center font-semibold">{qty}</span>
          <button className="p-3" aria-label="Increase" onClick={() => setQty(Math.min(50, qty + 1))}><Plus size={16} /></button>
        </div>
        <button className="btn-primary flex-1" onClick={() => onAdd({
          key: [p.id, variant, [...addons].sort().join(','), notes].join('|'), productId: p.id, name: p.name, unitCents: unit, quantity: qty,
          variantId: variant || undefined, addonIds: addons, options: [...(v ? [v.name] : []), ...chosen.map((a) => a.name)], notes: notes || undefined,
        })}>Add · {money(unit * qty, cur)}</button>
      </div>
    </Modal>
  );
}

function CartModal({ open, onClose, cart, restaurant: r, slug, table }: { open: boolean; onClose: () => void; cart: ReturnType<typeof useCart>; restaurant: any; slug: string; table: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [type, setType] = useState<string>(table ? 'DINE_IN' : r.orderTypes[0]);
  const [f, setF] = useState({ customerName: '', customerPhone: '', email: '', address: '', notes: '', tableLabel: table, marketingConsent: false });
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<{ code: string; discountCents: number } | null>(null);
  const [extra, setExtra] = useState({ referralCode: '', birthday: '' });
  const [tip, setTip] = useState(0);
  const [zoneId, setZoneId] = useState('');
  const [payMethod, setPayMethod] = useState<'CASH' | 'ONLINE'>('CASH');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const cur = r.currency;

  const discount = coupon?.discountCents ?? 0;
  const itemsPayload = cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, variantId: l.variantId, addonIds: l.addonIds }));
  const taxable = cart.subtotal - discount;
  const tax = Math.round(taxable * r.taxPercent / 100), service = Math.round(taxable * r.serviceChargePercent / 100);
  const zones: { id: string; name: string; feeCents: number; minOrderCents: number; etaMinutes: number }[] = r.deliveryZones ?? [];
  const zone = zones.find((x) => x.id === zoneId);
  const delivery = type === 'DELIVERY' ? (zones.length ? zone?.feeCents ?? 0 : r.deliveryFeeCents) : 0;
  const minOrder = type === 'DELIVERY' ? (zones.length ? zone?.minOrderCents ?? 0 : r.minDeliveryCents) : 0;
  const belowMin = cart.subtotal < minOrder;
  useEffect(() => {
    if (!coupon) return;
    const t = setTimeout(() => applyCoupon.mutate(coupon.code), 400);
    return () => clearTimeout(t);
  }, [cart.subtotal, f.customerPhone, type]); // eslint-disable-line react-hooks/exhaustive-deps
  const needZone = type === 'DELIVERY' && zones.length > 0 && !zone;
  const total = taxable + tax + service + delivery + tip;

  const applyCoupon = useMutation({
    mutationFn: (code: string) => api<{ code: string; discountCents: number }>(`/public/${slug}/coupon`, { body: { code, phone: f.customerPhone || undefined, items: itemsPayload } }),
    onSuccess: (c) => { setCoupon(c); toast(`${c.code} applied: you save ${money(c.discountCents, cur)}`); },
    onError: (e) => { setCoupon(null); toast(errMsg(e), 'err'); },
  });
  const place = useMutation({
    mutationFn: () => api<{ trackingCode: string; payUrl?: string; referral?: string }>(`/public/${slug}/orders`, {
      body: { type, ...f, email: f.email || undefined, tableLabel: type === 'DINE_IN' ? f.tableLabel : undefined, address: type === 'DELIVERY' ? f.address : undefined, zoneId: type === 'DELIVERY' && zoneId ? zoneId : undefined,
        couponCode: coupon?.code, referralCode: extra.referralCode || undefined, birthday: extra.birthday || undefined, tipCents: tip, paymentMethod: payMethod,
        items: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, variantId: l.variantId, addonIds: l.addonIds, notes: l.notes })) },
    }),
    onSuccess: (o) => {
      if (o.referral) toast(o.referral === 'applied' ? 'Referral applied. You and your friend get a bonus after your first order.' : 'Referral code was not applied (it only works for first-time customers).');
      cart.clear(); onClose();
      if (o.payUrl && safeRedirect(o.payUrl)) return; // hosted payment page; the provider returns to /track/:code
      if (o.payUrl) toast('The payment page link looks invalid. Please open your order and try again.', 'err');
      else nav(`/track/${o.trackingCode}`);
    },
    onError: (e: any) => { setErrors(e.details && !Array.isArray(e.details) ? e.details : {}); toast(errMsg(e), 'err'); },
  });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  return (
    <Modal open={open} onClose={onClose} title="Your order">
      <div className="space-y-2">
        {cart.lines.map((l) => (
          <div key={l.key} className="flex items-center justify-between gap-2 text-sm">
            <div><p className="font-semibold">{l.name}</p>{l.options.length > 0 && <p className="text-xs text-stone-500">{l.options.join(', ')}</p>}{l.notes && <p className="text-xs italic text-stone-500">“{l.notes}”</p>}</div>
            <div className="flex items-center gap-2">
              <button className="rounded-lg p-1.5 ring-1 ring-stone-300" aria-label={`Remove one ${l.name}`} onClick={() => cart.setQty(l.key, l.quantity - 1)}><Minus size={14} /></button>
              <span className="w-4 text-center">{l.quantity}</span>
              <button className="rounded-lg p-1.5 ring-1 ring-stone-300" aria-label={`Add one ${l.name}`} onClick={() => cart.setQty(l.key, l.quantity + 1)}><Plus size={14} /></button>
              <span className="w-16 text-right font-semibold">{money(l.unitCents * l.quantity, cur)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-3 gap-2">
        {r.orderTypes.map((t: string) => (
          <button key={t} onClick={() => setType(t)} className={`rounded-xl px-2 py-2 text-xs font-semibold ${type === t ? 'bg-stone-900 text-white' : 'ring-1 ring-stone-300'}`}>{t.replace('_', ' ')}</button>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        <Field label="Name" error={errors.customerName?.[0]}><input className="input" value={f.customerName} onChange={set('customerName')} autoComplete="name" /></Field>
        <Field label="Phone" error={errors.customerPhone?.[0]}><input className="input" type="tel" value={f.customerPhone} onChange={set('customerPhone')} autoComplete="tel" /></Field>
        {type === 'DINE_IN' && <Field label="Table" error={errors.tableLabel?.[0]}><input className="input" value={f.tableLabel} onChange={set('tableLabel')} placeholder="e.g. T3" /></Field>}
        {type === 'DELIVERY' && zones.length > 0 && (
          <Field label="Delivery area" error={errors.zoneId?.[0]}><select className="input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">Choose your area…</option>{zones.map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.feeCents, cur)} · ~{x.etaMinutes} min</option>)}</select></Field>)}
        {type === 'DELIVERY' && <Field label="Delivery address" error={errors.address?.[0]}><textarea className="input" rows={2} value={f.address} onChange={set('address')} /></Field>}
        {type === 'DELIVERY' && belowMin && !needZone && <p className="err" role="alert">Minimum order for delivery here is {money(minOrder, cur)}. Add {money(minOrder - cart.subtotal, cur)} more.</p>}
        <Field label="Order notes"><input className="input" value={f.notes} onChange={set('notes')} maxLength={300} /></Field>
        <div className="flex gap-2">
          <input className="input" placeholder="Coupon code" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} aria-label="Coupon code" />
          <button className="btn-ghost" disabled={!couponInput || applyCoupon.isPending} onClick={() => applyCoupon.mutate(couponInput)}>Apply</button>
        </div>
        <div className="flex gap-2">
          <span className="self-center text-sm">Tip</span>
          {[0, 5, 10].map((pct) => { const c = Math.round(cart.subtotal * pct / 100); return <button key={pct} onClick={() => setTip(c)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tip === c ? 'bg-stone-900 text-white' : 'ring-1 ring-stone-300'}`}>{pct ? `${pct}%` : 'None'}</button>; })}
        </div>
        {r.loyalty && <div className="grid grid-cols-2 gap-2"><Field label="Friend’s referral code"><input className="input uppercase" maxLength={12} value={extra.referralCode} onChange={(e) => setExtra({ ...extra, referralCode: e.target.value })} placeholder="Optional" /></Field>
          <Field label="Birthday (for a treat)"><input className="input" type="date" max={new Date().toISOString().slice(0, 10)} value={extra.birthday} onChange={(e) => setExtra({ ...extra, birthday: e.target.value })} /></Field></div>}
        <label className="flex items-start gap-2 text-xs text-stone-600"><input type="checkbox" className="mt-0.5" checked={f.marketingConsent} onChange={(e) => setF({ ...f, marketingConsent: e.target.checked })} />I’d like to receive offers from {r.name}. You can opt out at any time.</label>
      </div>
      <dl className="mt-5 space-y-1 text-sm">
        <Row k="Subtotal" v={money(cart.subtotal, cur)} />
        {discount > 0 && <Row k={`Discount (${coupon?.code})`} v={`−${money(discount, cur)}`} />}
        <Row k={`Tax (${r.taxPercent}%)`} v={money(tax, cur)} />
        {service > 0 && <Row k="Service charge" v={money(service, cur)} />}
        {delivery > 0 && <Row k="Delivery" v={money(delivery, cur)} />}
        {tip > 0 && <Row k="Tip" v={money(tip, cur)} />}
        <div className="flex justify-between border-t pt-2 text-base font-bold"><dt>Total</dt><dd>{money(total, cur)}</dd></div>
      </dl>
      <fieldset className="mt-4"><legend className="label">Payment</legend>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={payMethod === 'CASH'} onClick={() => setPayMethod('CASH')} className={`rounded-xl px-2 py-2 text-xs font-semibold ${payMethod === 'CASH' ? 'bg-stone-900 text-white' : 'ring-1 ring-stone-300'}`}>Cash {type === 'DELIVERY' ? 'on delivery' : 'at restaurant'}</button>
          {r.onlinePayments && <button type="button" aria-pressed={payMethod === 'ONLINE'} onClick={() => setPayMethod('ONLINE')} className={`rounded-xl px-2 py-2 text-xs font-semibold ${payMethod === 'ONLINE' ? 'bg-stone-900 text-white' : 'ring-1 ring-stone-300'}`}>Pay online now</button>}
        </div>
      </fieldset>
      <p className="mt-2 text-xs text-stone-500">The final total is calculated by the restaurant’s server.{payMethod === 'ONLINE' && ' You’ll be taken to a secure payment page; your order is sent to the kitchen once payment is confirmed.'}</p>
      <button className="btn-primary mt-4 w-full py-3" disabled={place.isPending || cart.lines.length === 0 || needZone || (type === 'DELIVERY' && belowMin)} onClick={() => place.mutate()}>{place.isPending ? 'Placing order…' : payMethod === 'ONLINE' ? `Pay ${money(total, cur)}` : 'Place order'}</button>
    </Modal>
  );
}
const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between text-stone-600"><dt>{k}</dt><dd>{v}</dd></div>;

function ReserveModal({ open, onClose, slug }: { open: boolean; onClose: () => void; slug: string }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [party, setParty] = useState(2);
  const [slot, setSlot] = useState('');
  const [f, setF] = useState({ name: '', phone: '', notes: '' });
  const [done, setDone] = useState<any>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const slots = useQuery({
    queryKey: ['slots', slug, date, party], enabled: open,
    queryFn: () => api<{ slots: { startsAt: string; available: boolean }[] }>(`/public/${slug}/availability?date=${date}&partySize=${party}&tzOffset=${new Date().getTimezoneOffset()}`),
  });
  const book = useMutation({
    mutationFn: () => api(`/public/${slug}/reservations`, { body: { ...f, notes: f.notes || undefined, partySize: party, startsAt: slot } }),
    onSuccess: (r) => setDone(r),
    onError: (e: any) => { setErrors(e.details && !Array.isArray(e.details) ? e.details : {}); toast(errMsg(e), 'err'); if (e.status === 409) { setSlot(''); slots.refetch(); } },
  });
  return (
    <Modal open={open} onClose={() => { setDone(null); onClose(); }} title="Book a table">
      {done ? (
        <div className="py-6 text-center"><Check className="mx-auto mb-2 text-green-600" size={36} /><p className="font-bold">You’re booked!</p>
          <p className="mt-1 text-sm text-stone-600">{new Date(done.startsAt).toLocaleString()} · {done.partySize} guests · table {done.table}</p></div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><input type="date" className="input" min={today} value={date} onChange={(e) => { setDate(e.target.value); setSlot(''); }} /></Field>
            <Field label="Guests"><input type="number" min={1} max={20} className="input" value={party} onChange={(e) => { setParty(Math.max(1, Number(e.target.value) || 1)); setSlot(''); }} /></Field>
          </div>
          <div>
            <p className="label">Time</p>
            {slots.isLoading ? <Skeleton className="h-16" /> : slots.data?.slots.length ? (
              <div className="grid grid-cols-4 gap-2">
                {slots.data.slots.map((s) => (
                  <button key={s.startsAt} disabled={!s.available} onClick={() => setSlot(s.startsAt)}
                    className={`rounded-lg py-2 text-xs font-semibold disabled:text-stone-300 disabled:line-through ${slot === s.startsAt ? 'bg-stone-900 text-white' : 'ring-1 ring-stone-300'}`}>
                    {new Date(s.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </button>
                ))}
              </div>
            ) : <p className="text-sm text-stone-500">No slots on this day.</p>}
          </div>
          <Field label="Name" error={errors.name?.[0]}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Phone" error={errors.phone?.[0]}><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Special requests"><input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <button className="btn-primary w-full" disabled={!slot || book.isPending} onClick={() => book.mutate()}>{book.isPending ? 'Booking…' : 'Confirm reservation'}</button>
        </div>
      )}
    </Modal>
  );
}

const STEPS = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'];
/** Stand-in hosted payment page for the dev-only "test" provider. Real providers host their own page. */
export function TestPay() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { data, error } = useQuery({ queryKey: ['testpay', id], queryFn: () => api<any>(`/public/payments/test/${id}`) });
  const act = useMutation({ mutationFn: (outcome: string) => api(`/public/payments/test/${id}`, { body: { outcome } }), onSuccess: () => nav(data.returnPath ?? `/track/${data.trackingCode}`) });
  if (error) return <div className="mx-auto max-w-md p-8"><Empty title="Test payments are not enabled" /></div>;
  if (!data) return <div className="mx-auto max-w-md p-4"><Skeleton /></div>;
  return (
    <div className="mx-auto max-w-sm p-4"><div className="card text-center">
      <p className="mb-2 rounded-lg bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">TEST MODE — no real money moves</p>
      <p className="text-sm text-stone-500">{data.restaurant}</p><p className="my-2 text-3xl font-extrabold">{money(data.amountCents, data.currency)}</p>
      {data.status !== 'PENDING' ? <p className="text-sm">Payment already {data.status.toLowerCase()}.</p> : (
        <div className="space-y-2"><button className="btn-primary w-full" disabled={act.isPending} onClick={() => act.mutate('paid')}>Simulate successful payment</button>
          <button className="btn-ghost w-full" disabled={act.isPending} onClick={() => act.mutate('failed')}>Simulate failed payment</button></div>)}
      {act.error && <p className="err">{errMsg(act.error)}</p>}
    </div></div>
  );
}

export function Track() {
  const { code = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['track', code], queryFn: () => api<any>(`/public/orders/track/${code}`), refetchInterval: (q) => (['COMPLETED', 'CANCELLED'].includes(q.state.data?.status) ? false : 5000) });
  if (error) return <div className="mx-auto max-w-md p-8"><Empty title="Order not found" hint="Check the link and try again." /></div>;
  if (!data) return <div className="mx-auto max-w-md space-y-3 p-4"><Skeleton /><Skeleton /></div>;
  const idx = STEPS.indexOf(data.status === 'SERVED' || data.status === 'OUT_FOR_DELIVERY' ? 'READY' : data.status);
  const awaiting = data.status === 'PENDING_PAYMENT';
  return (
    <Page>
      <div className="mx-auto max-w-md space-y-4 p-4">
        <div className="card text-center"><p className="text-sm text-stone-500">{data.restaurant.name}</p><h1 className="text-2xl font-extrabold">Order #{data.number}</h1>
          <p className="mt-1 text-lg font-semibold text-brand-600" aria-live="polite">{data.status === 'CANCELLED' ? 'Cancelled' : data.status.replace(/_/g, ' ')}</p></div>
        {data.etaAt && !['COMPLETED', 'CANCELLED', 'PENDING_PAYMENT'].includes(data.status) && <div className="card text-center text-sm">Estimated delivery by <b>{new Date(data.etaAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div>}
        {data.rider && <div className="card text-sm"><p className="font-semibold">Your order is on its way</p><p className="mt-1 text-stone-600">Rider: {data.rider.name} · <a className="font-semibold text-brand-600" href={`tel:${data.rider.phone}`}>{data.rider.phone}</a></p></div>}
        {data.rewards && (
          <div className="card space-y-2 text-sm">
            <p className="font-semibold">Your rewards · {data.rewards.tier} · {data.rewards.points} points</p>
            {data.rewards.vouchers.map((v: any) => (
              <p key={v.code} className="rounded-lg bg-green-50 p-2 text-green-800">Voucher <b className="font-mono">{v.code}</b>: {v.type === 'PERCENT' ? `${v.value}% off` : money(v.value, data.restaurant.currency)}{v.expiresAt && ` · expires ${new Date(v.expiresAt).toLocaleDateString()}`}. Use it with this phone number.</p>))}
            {data.rewards.referralBonusPoints > 0 && <p className="text-stone-600">Share code <b className="font-mono">{data.rewards.referralCode}</b>: when a friend’s first order is completed, you both get {data.rewards.referralBonusPoints} points.</p>}
          </div>
        )}
        {awaiting && (
          <div className="card text-center text-sm"><p className="font-semibold">Waiting for your payment to be confirmed</p>
            <p className="mt-1 text-stone-600">The restaurant receives your order as soon as the payment provider confirms it. This page updates automatically.</p>
            {data.payUrl && /^https?:\/\//i.test(data.payUrl) && <a className="btn-primary mt-3" href={data.payUrl} rel="noopener noreferrer">Complete payment</a>}</div>
        )}
        {data.status !== 'CANCELLED' && !awaiting && (
          <ol className="card space-y-3">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex items-center gap-3 text-sm ${i <= idx ? 'font-semibold' : 'text-stone-400'}`}>
                <motion.span layout className={`grid h-6 w-6 place-items-center rounded-full text-xs ${i <= idx ? 'bg-brand-500 text-white' : 'bg-stone-200'}`}>{i < idx ? <Check size={14} /> : i + 1}</motion.span>{s[0] + s.slice(1).toLowerCase()}
              </li>
            ))}
          </ol>
        )}
        <div className="card text-sm">
          {data.items.map((i: any, k: number) => <div key={k} className="flex justify-between py-0.5"><span>{i.quantity} × {i.name}</span><span>{money(i.unitPriceCents * i.quantity, data.restaurant.currency)}</span></div>)}
          <div className="mt-2 flex justify-between border-t pt-2 font-bold"><span>Total ({data.paymentMethod.toLowerCase()} · {data.paymentStatus.toLowerCase()})</span><span>{money(data.totalCents, data.restaurant.currency)}</span></div>
        </div>
      </div>
    </Page>
  );
}

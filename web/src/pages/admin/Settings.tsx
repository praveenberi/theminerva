import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ImagePlus, Plus, XCircle } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Field, Input, Modal, QueryBoundary, Select, Switch, Tabs, Textarea, useToast } from '@/components/ui';
import { useUpload } from '@/pages/admin/Content';
import Branches from '@/pages/admin/Branches';
import { api, errorMessage } from '@/lib/api';
import { dateTime, money, setLocaleConfig, statusLabel, WEEKDAYS } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

type Tab = 'branches' | 'profile' | 'hours' | 'ordering' | 'payments' | 'loyalty' | 'reservations' | 'delivery' | 'site' | 'notifications' | 'integrations' | 'audit' | 'data';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'profile', label: 'Restaurant' }, { id: 'hours', label: 'Opening hours' }, { id: 'ordering', label: 'Ordering & tax' }, { id: 'payments', label: 'Payments' }, { id: 'loyalty', label: 'Loyalty' },
  { id: 'reservations', label: 'Reservations' }, { id: 'delivery', label: 'Delivery' }, { id: 'branches', label: 'Branches' }, { id: 'site', label: 'Website & SEO' }, { id: 'notifications', label: 'Notifications' }, { id: 'integrations', label: 'Integrations' }, { id: 'audit', label: 'Audit log' }, { id: 'data', label: 'Backup & data' },
];

export default function SettingsPage() {
  useSeo('Settings');
  const [tab, setTab] = useState<Tab>('profile');
  return <div className="space-y-4"><Tabs value={tab} onChange={setTab} tabs={TABS} />
    {tab === 'profile' ? <Profile /> : tab === 'hours' ? <Hours /> : tab === 'delivery' ? <Delivery /> : tab === 'branches' ? <Branches /> : tab === 'notifications' ? <Notifications /> : tab === 'integrations' ? <Integrations /> : tab === 'audit' ? <Audit /> : tab === 'data' ? <DataTab /> : <SettingsSection section={tab} />}</div>;
}

function useRestaurant() { return useQuery({ queryKey: ['restaurant'], queryFn: () => api('/api/restaurant') }); }

function Profile() {
  const qc = useQueryClient(); const toast = useToast(); const upload = useUpload();
  const q = useRestaurant();
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => api('/api/restaurant', { method: 'PUT', body: { name: v.name, tagline: v.tagline || null, description: v.description || null, story: v.story || null, phone: v.phone || null, email: v.email || '', whatsapp: v.whatsapp || null, address: v.address || null, mapEmbedUrl: v.mapEmbedUrl || '', currency: v.currency, locale: v.locale, timezone: v.timezone, logoUrl: v.logoUrl || null, heroImageUrl: v.heroImageUrl || null, social: v.social ?? {}, seo: v.seo ?? {}, latitude: v.latitude === '' || v.latitude == null ? null : Number(v.latitude), longitude: v.longitude === '' || v.longitude == null ? null : Number(v.longitude) } }), onSuccess: (r) => { setLocaleConfig(r); setF(null); qc.invalidateQueries({ queryKey: ['restaurant'] }); qc.invalidateQueries({ queryKey: ['home'] }); toast('success', 'Restaurant details saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (<QueryBoundary q={q}>{(r) => { const v = f ?? r; const set = (k: string, val: any) => setF({ ...v, [k]: val }); const soc = v.social ?? {}; const seo = v.seo ?? {};
    return (<Card className="p-5"><form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(v); }}>
      <Field label="Restaurant name">{(id) => <Input id={id} required value={v.name} onChange={(e) => set('name', e.target.value)} />}</Field>
      <Field label="Tagline">{(id) => <Input id={id} value={v.tagline ?? ''} onChange={(e) => set('tagline', e.target.value)} />}</Field>
      <Field label="Short description" className="sm:col-span-2">{(id) => <Textarea id={id} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} />}</Field>
      <Field label="Our story" className="sm:col-span-2">{(id) => <Textarea id={id} className="min-h-32" value={v.story ?? ''} onChange={(e) => set('story', e.target.value)} />}</Field>
      <Field label="Phone">{(id) => <Input id={id} type="tel" value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />}</Field>
      <Field label="Email">{(id) => <Input id={id} type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} />}</Field>
      <Field label="WhatsApp number" hint="International format, e.g. +65…">{(id) => <Input id={id} value={v.whatsapp ?? ''} onChange={(e) => set('whatsapp', e.target.value)} />}</Field>
      <Field label="Address">{(id) => <Textarea id={id} value={v.address ?? ''} onChange={(e) => set('address', e.target.value)} />}</Field>
      <Field label="Google Maps embed URL" hint="Google Maps → Share → Embed a map → copy the src" className="sm:col-span-2">{(id) => <Input id={id} value={v.mapEmbedUrl ?? ''} onChange={(e) => set('mapEmbedUrl', e.target.value)} />}</Field>
      <Field label="Latitude">{(id) => <Input id={id} type="number" step="any" value={v.latitude ?? ''} onChange={(e) => set('latitude', e.target.value)} />}</Field><Field label="Longitude">{(id) => <Input id={id} type="number" step="any" value={v.longitude ?? ''} onChange={(e) => set('longitude', e.target.value)} />}</Field>
      <Field label="Currency (ISO code)">{(id) => <Input id={id} maxLength={3} value={v.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} />}</Field><Field label="Locale">{(id) => <Input id={id} value={v.locale} onChange={(e) => set('locale', e.target.value)} />}</Field>
      <Field label="Time zone (reports, hours, reservations)" className="sm:col-span-2">{(id) => <Input id={id} value={v.timezone} onChange={(e) => set('timezone', e.target.value)} />}</Field>
      {([['logoUrl', 'Logo'], ['heroImageUrl', 'Homepage hero image']] as const).map(([k, l]) => <div key={k} className="flex items-center gap-3"><div className="text-sm font-medium">{l}</div>{v[k] && <img src={v[k]} alt="" className="h-12 w-12 rounded-lg object-cover" />}<label className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-border px-3 py-2 text-sm hover:bg-surface-2"><ImagePlus className="h-4 w-4" /> Upload<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={async (e) => { const u = e.target.files?.[0] && (await upload(e.target.files[0])); if (u) set(k, u); }} /></label></div>)}
      <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-2"><legend className="mb-1 font-medium">Social links</legend>{['instagram', 'facebook', 'tiktok', 'x', 'youtube'].map((s) => <Field key={s} label={s[0].toUpperCase() + s.slice(1)}>{(id) => <Input id={id} type="url" placeholder="https://…" value={soc[s] ?? ''} onChange={(e) => set('social', { ...soc, [s]: e.target.value })} />}</Field>)}</fieldset>
      <fieldset className="grid gap-3 sm:col-span-2"><legend className="mb-1 font-medium">Search engine (SEO) defaults</legend>
        <Field label="Home page title" hint="Up to 70 characters">{(id) => <Input id={id} maxLength={70} value={seo.title ?? ''} onChange={(e) => set('seo', { ...seo, title: e.target.value })} />}</Field>
        <Field label="Meta description" hint="Up to 170 characters">{(id) => <Textarea id={id} maxLength={170} value={seo.description ?? ''} onChange={(e) => set('seo', { ...seo, description: e.target.value })} />}</Field></fieldset>
      <div className="sm:col-span-2"><Button loading={save.isPending}>Save changes</Button></div></form></Card>); }}</QueryBoundary>);
}

function Hours() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useRestaurant();
  const [h, setH] = useState<any>(null);
  const save = useMutation({ mutationFn: (hours: any) => api('/api/restaurant', { method: 'PUT', body: { openingHours: hours } }), onSuccess: () => { setH(null); qc.invalidateQueries({ queryKey: ['restaurant'] }); qc.invalidateQueries({ queryKey: ['home'] }); toast('success', 'Opening hours saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (<QueryBoundary q={q}>{(r) => { const hours = h ?? r.openingHours ?? {}; const set = (d: string, patch: any) => setH({ ...hours, [d]: { ...hours[d], ...patch } });
    return (<Card className="max-w-xl p-5"><p className="mb-4 text-sm text-muted">These hours drive the website, reservation time slots and the structured data Google reads. Times are in {r.timezone}.</p>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(hours); }}>{WEEKDAYS.map((d) => { const x = hours[d] ?? {}; return <div key={d} className="flex items-center gap-3"><span className="w-12 font-medium capitalize">{d}</span><label className="flex items-center gap-2 text-sm"><Switch label={`${d} open`} checked={!x.closed && !!x.open} onChange={(on) => set(d, on ? { closed: false, open: x.open || '11:00', close: x.close || '22:00' } : { closed: true })} />{!x.closed && x.open ? 'Open' : 'Closed'}</label>{!x.closed && x.open && <><Input aria-label={`${d} opens`} type="time" className="w-32" value={x.open} onChange={(e) => set(d, { open: e.target.value })} />–<Input aria-label={`${d} closes`} type="time" className="w-32" value={x.close ?? ''} onChange={(e) => set(d, { close: e.target.value })} /></>}</div>; })}
        <Button loading={save.isPending} className="mt-3">Save hours</Button></form></Card>); }}</QueryBoundary>);
}

const METHODS = [['CASH_AT_RESTAURANT', 'Cash at restaurant'], ['CASH_ON_DELIVERY', 'Cash on delivery'], ['CARD', 'Card (Stripe)'], ['PAYNOW', 'PayNow (via Stripe)'], ['RAZORPAY', 'Razorpay'], ['UPI', 'UPI (via Razorpay)']] as const;

function SettingsSection({ section }: { section: Exclude<Tab, 'branches' | 'profile' | 'hours' | 'delivery' | 'notifications' | 'integrations' | 'audit' | 'data'> }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/restaurant/settings') });
  const ints = useQuery({ queryKey: ['integrations'], queryFn: () => api('/api/restaurant/integrations'), enabled: section === 'payments' });
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => api('/api/restaurant/settings', { method: 'PUT', body: { [section]: v } }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['home'] }); toast('success', 'Settings saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (<QueryBoundary q={q}>{(all) => { const v = f ?? all[section]; const set = (k: string, val: any) => setF({ ...v, [k]: val }); const num = (k: string, label: string, props: any = {}) => <Field label={label} hint={props.hint}>{(id) => <Input id={id} type="number" step={props.step ?? 'any'} min={props.min ?? 0} value={v[k]} onChange={(e) => set(k, e.target.value === '' ? 0 : Number(e.target.value))} />}</Field>;
    const tog = (k: string, label: string) => <label className="flex items-center gap-3 text-sm"><Switch label={label} checked={!!v[k]} onChange={(c) => set(k, c)} />{label}</label>;
    return (<Card className="max-w-3xl p-5"><form className="space-y-5" onSubmit={(e) => { e.preventDefault(); save.mutate(v); }}>
      {section === 'ordering' && <><div className="grid gap-3 sm:grid-cols-2">{tog('dineInEnabled', 'Dine-in ordering')}{tog('takeawayEnabled', 'Takeaway')}{tog('deliveryEnabled', 'Delivery')}{tog('guestCheckout', 'Allow guest checkout (no account)')}{tog('scheduledOrdersEnabled', 'Scheduled / pre-orders')}{tog('taxInclusive', 'Prices already include tax')}</div>
        <div className="grid gap-4 sm:grid-cols-3">{num('taxRate', 'Tax rate (%)', { hint: 'e.g. GST' })}{num('serviceChargePct', 'Service charge % (dine-in)')}{num('minOrder', 'Minimum order value')}</div>
        <Field label="Tip options (% , comma-separated)">{(id) => <Input id={id} value={(v.tipOptions ?? []).join(', ')} onChange={(e) => set('tipOptions', e.target.value.split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x) && x >= 0))} />}</Field>
        <p className="text-xs text-muted">Tax and service charge are calculated on the server for every order. Confirm your obligations with your accountant.</p></>}
      {section === 'payments' && <><fieldset><legend className="mb-2 font-medium">Methods offered at checkout</legend><div className="grid gap-2 sm:grid-cols-2">{METHODS.map(([m, l]) => { const on = (v.enabledMethods ?? []).includes(m); const needs = m === 'CARD' || m === 'PAYNOW' ? 'stripe' : m === 'RAZORPAY' || m === 'UPI' ? 'razorpay' : null; const ready = !needs || ints.data?.[needs]?.configured;
        return <label key={m} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"><span className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={(e) => set('enabledMethods', e.target.checked ? [...(v.enabledMethods ?? []), m] : v.enabledMethods.filter((x: string) => x !== m))} />{l}</span>{needs && (ready ? <Badge tone="success">provider connected</Badge> : <Badge tone="warn">needs {needs} keys</Badge>)}</label>; })}</div></fieldset>
        <p className="text-xs text-muted">Online methods only work once the provider’s keys and webhook secret are set on the server (see Integrations). Until then customers who choose them will see an error — don’t enable them early.</p></>}
      {section === 'loyalty' && <><div className="grid gap-3 sm:grid-cols-2">{tog('enabled', 'Loyalty programme enabled')}</div>
        <div className="grid gap-4 sm:grid-cols-3">{num('pointsPerCurrency', 'Points per 1 spent')}{num('minRedeemPoints', 'Minimum points to redeem', { step: 1 })}{num('pointValue', 'Value of one point', { hint: 'in restaurant currency' })}{num('pointsExpiryDays', 'Points expiry (days, 0 = never)', { step: 1 })}{num('referralBonus', 'Referral bonus (points)', { step: 1 })}{num('birthdayBonus', 'Birthday bonus (points)', { step: 1 })}</div>
        <fieldset><legend className="mb-2 font-medium">Membership levels</legend>{(v.tiers ?? []).map((t: any, i: number) => <div key={i} className="mb-2 flex gap-2"><Input aria-label="Level name" value={t.name} onChange={(e) => set('tiers', v.tiers.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} /><Input aria-label="Lifetime points needed" type="number" min={0} className="w-36" value={t.minLifetime} onChange={(e) => set('tiers', v.tiers.map((x: any, j: number) => (j === i ? { ...x, minLifetime: Number(e.target.value) } : x)))} /><Input aria-label="Earn multiplier" type="number" min={1} step="0.05" className="w-28" value={t.multiplier} onChange={(e) => set('tiers', v.tiers.map((x: any, j: number) => (j === i ? { ...x, multiplier: Number(e.target.value) } : x)))} />{v.tiers.length > 1 && <Button type="button" variant="ghost" size="icon" aria-label="Remove level" onClick={() => set('tiers', v.tiers.filter((_: any, j: number) => j !== i))}>×</Button>}</div>)}
          <Button type="button" size="sm" variant="outline" onClick={() => set('tiers', [...v.tiers, { name: '', minLifetime: 0, multiplier: 1 }])}>Add level</Button><p className="mt-1 text-xs text-muted">Columns: name · lifetime points needed · points multiplier. Referral rewards are paid once, on the referred customer’s first completed order.</p></fieldset></>}
      {section === 'reservations' && <><div className="grid gap-3">{tog('enabled', 'Online table reservations')}</div><div className="grid gap-4 sm:grid-cols-3">{num('slotMinutes', 'Booking length (min)', { step: 15 })}{num('intervalMinutes', 'Slot interval (min)', { step: 15 })}{num('maxPartySize', 'Max party size online', { step: 1 })}{num('advanceDays', 'Bookable days ahead', { step: 1 })}{num('minNoticeMinutes', 'Minimum notice (min)', { step: 5 })}{num('depositPerGuest', 'Deposit per guest', { hint: '0 = no deposit' })}{num('depositFromGuests', 'Deposit applies from N guests', { step: 1 })}</div><p className="text-xs text-muted">Deposits mark the booking as pending until you confirm payment on the Reservations screen.</p></>}
      {section === 'site' && <><div className="grid gap-4 sm:grid-cols-2"><Field label="Languages (comma-separated codes)" hint="First is default; add translations on each dish">{(id) => <Input id={id} value={(v.languages ?? []).join(', ')} onChange={(e) => set('languages', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />}</Field><Field label="Default language">{(id) => <Input id={id} value={v.defaultLanguage} onChange={(e) => set('defaultLanguage', e.target.value)} />}</Field>
        <Field label="Google reviews link">{(id) => <Input id={id} type="url" value={v.googleReviewsUrl ?? ''} onChange={(e) => set('googleReviewsUrl', e.target.value)} />}</Field><Field label="WhatsApp pre-filled message">{(id) => <Input id={id} value={v.whatsappOrderMessage ?? ''} onChange={(e) => set('whatsappOrderMessage', e.target.value)} />}</Field></div><p className="text-xs text-muted">Branches are managed under the Branches tab.</p></>}
      <Button loading={save.isPending}>Save</Button></form>
      {section === 'site' && <AnalyticsForm />}</Card>); }}</QueryBoundary>);
}

function AnalyticsForm() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/restaurant/settings') });
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => api('/api/restaurant/settings', { method: 'PUT', body: { analytics: v } }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['home'] }); toast('success', 'Saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  if (!q.data) return null;
  const v = f ?? q.data.analytics;
  return (<form className="mt-8 space-y-3 border-t border-border pt-5" onSubmit={(e) => { e.preventDefault(); save.mutate(v); }}><h3 className="text-lg">Analytics & search</h3><div className="grid gap-4 sm:grid-cols-3">
    <Field label="Google Analytics ID" hint="G-XXXXXXXXXX">{(id) => <Input id={id} value={v.gaMeasurementId} onChange={(e) => setF({ ...v, gaMeasurementId: e.target.value.trim() })} />}</Field>
    <Field label="Meta Pixel ID" hint="Digits only">{(id) => <Input id={id} value={v.metaPixelId} onChange={(e) => setF({ ...v, metaPixelId: e.target.value.trim() })} />}</Field>
    <Field label="Search Console token">{(id) => <Input id={id} value={v.searchConsoleToken} onChange={(e) => setF({ ...v, searchConsoleToken: e.target.value.trim() })} />}</Field></div>
    <p className="text-xs text-muted">Scripts load only after the visitor accepts the cookie banner. Sitemap: /sitemap.xml · Robots: /robots.txt</p><Button loading={save.isPending}>Save analytics</Button></form>);
}

function Delivery() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['zones'], queryFn: () => api('/api/delivery/zones') });
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => { const b = { name: v.name, postalPrefixes: String(v.prefixes ?? '').split(',').map((s) => s.trim()).filter(Boolean), fee: Number(v.fee), minOrder: Number(v.minOrder || 0), etaMinutes: Number(v.etaMinutes || 45), isActive: v.isActive ?? true }; return v.id ? api(`/api/delivery/zones/${v.id}`, { method: 'PUT', body: b }) : api('/api/delivery/zones', { body: b }); }, onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['zones'] }); toast('success', 'Zone saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/delivery/zones/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['zones'] }) });
  return (<div className="space-y-4"><p className="text-sm text-muted">Customers are matched to a zone by postal-code prefix. Enable or disable delivery under Ordering & tax.</p><Button onClick={() => setF({ name: '', prefixes: '', fee: 0, minOrder: 0, etaMinutes: 45 })}><Plus className="h-4 w-4" /> Zone</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{d.map((z: any) => <Card key={z.id} className="flex items-start justify-between p-4"><div><p className="font-medium">{z.name} {!z.isActive && <Badge>off</Badge>}</p><p className="text-sm text-muted">Postal prefixes: {z.postalPrefixes.join(', ') || '—'}<br />Fee {money(z.fee)} · minimum {money(z.minOrder)} · ~{z.etaMinutes} min</p></div><div><Button size="sm" variant="ghost" onClick={() => setF({ ...z, prefixes: z.postalPrefixes.join(', '), fee: Number(z.fee), minOrder: Number(z.minOrder) })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete zone?" onConfirm={() => del.mutate(z.id)}>×</ConfirmButton></div></Card>)}</div>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title="Delivery zone">{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}><Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field><Field label="Postal code prefixes (comma-separated)">{(id) => <Input id={id} value={f.prefixes} onChange={(e) => setF({ ...f, prefixes: e.target.value })} />}</Field>
      <div className="grid grid-cols-3 gap-3"><Field label="Fee">{(id) => <Input id={id} type="number" step="0.01" min="0" required value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} />}</Field><Field label="Min order">{(id) => <Input id={id} type="number" step="0.01" min="0" value={f.minOrder} onChange={(e) => setF({ ...f, minOrder: e.target.value })} />}</Field><Field label="ETA (min)">{(id) => <Input id={id} type="number" min={5} value={f.etaMinutes} onChange={(e) => setF({ ...f, etaMinutes: e.target.value })} />}</Field></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive ?? true} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active</label><div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Notifications() {
  const qc = useQueryClient(); const toast = useToast();
  const tpl = useQuery({ queryKey: ['templates'], queryFn: () => api('/api/restaurant/notification-templates') });
  const logs = useQuery({ queryKey: ['notif-logs'], queryFn: () => api('/api/restaurant/notification-logs', { query: { pageSize: 30 } }), refetchInterval: 20_000 });
  const [f, setF] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => api(`/api/restaurant/notification-templates/${v.key}`, { method: 'PUT', body: { channel: v.channel, subject: v.subject, body: v.body } }), onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['templates'] }); toast('success', 'Template saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (<div className="grid gap-6 lg:grid-cols-2"><Card className="p-4"><h3 className="mb-2 text-lg">Message templates</h3><p className="mb-3 text-xs text-muted">Placeholders: {'{{name}} {{number}} {{total}} {{trackUrl}} {{reference}} {{guests}} {{when}}'}</p>
    <QueryBoundary q={tpl}>{(d) => <ul className="divide-y divide-border text-sm">{Object.entries(d.defaults).map(([k, t]: any) => { const c = d.custom.find((x: any) => x.key === k); return <li key={k} className="flex items-center justify-between py-2"><span><span className="font-mono text-xs">{k}</span>{c && <Badge tone="brand" className="ml-2">customised</Badge>}</span><Button size="sm" variant="ghost" onClick={() => setF({ key: k, channel: 'EMAIL', subject: c?.subject ?? t.subject, body: c?.body ?? t.body })}>Edit</Button></li>; })}</ul>}</QueryBoundary></Card>
    <Card className="p-4"><h3 className="mb-2 text-lg">Delivery log</h3><QueryBoundary q={logs} empty={(d) => d.items.length === 0}>{(d) => <ul className="divide-y divide-border text-sm">{d.items.map((l: any) => <li key={l.id} className="py-2"><div className="flex justify-between"><span>{l.event} → {l.recipient}</span><Badge tone={l.status === 'SENT' ? 'success' : l.status === 'FAILED' ? 'danger' : 'neutral'}>{statusLabel(l.status)}</Badge></div><p className="text-xs text-muted">{l.channel} · {dateTime(l.createdAt)}{l.error && ` · ${l.error}`}</p></li>)}</ul>}</QueryBoundary></Card>
    <Modal open={!!f} onClose={() => setF(null)} title={f?.key ?? ''}>{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}><Field label="Subject (email)">{(id) => <Input id={id} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />}</Field><Field label="Message">{(id) => <Textarea id={id} required value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field><div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Integrations() {
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api('/api/restaurant/integrations') });
  const DOCS: Record<string, string> = { email: 'Order and reservation emails, password resets, campaigns.', whatsapp: 'WhatsApp order updates and campaigns (approved message templates are needed for messages outside a 24h customer window).', sms: 'SMS notifications (Twilio).', stripe: 'Card and PayNow payments, plus refunds. Webhook endpoint: POST /api/payments/webhook (events: payment_intent.succeeded, payment_intent.payment_failed).', razorpay: 'Razorpay and UPI payments. Webhook endpoint: POST /api/payments/webhook (events: payment.captured, payment.failed).', ai: 'Assistant, descriptions, translations, marketing copy.', storage: 'Image storage. Without S3, images are stored on the server disk.', redis: 'Reserved for the job queue; background jobs currently run in-process.' };
  return (<div className="space-y-3"><p className="max-w-3xl text-sm text-muted">Credentials are set as environment variables on the server — never in the browser or database. An integration marked “not configured” is inactive; nothing is simulated.</p>
    <QueryBoundary q={q}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{Object.entries(d).map(([k, i]: any) => <Card key={k} className="p-4"><div className="flex items-center justify-between"><p className="font-medium">{i.provider}</p>{i.configured ? <span className="flex items-center gap-1 text-sm text-success"><CheckCircle2 className="h-4 w-4" /> configured</span> : <span className="flex items-center gap-1 text-sm text-muted"><XCircle className="h-4 w-4" /> not configured</span>}</div><p className="mt-1 text-sm text-muted">{DOCS[k]}</p><p className="mt-2 font-mono text-xs">{i.env.join('  ')}</p>{i.webhook === false && i.configured && <p className="mt-1 text-xs text-warn">Webhook secret missing — payments cannot be confirmed.</p>}{i.note && <p className="mt-1 text-xs text-muted">{i.note}</p>}</Card>)}</div>}</QueryBoundary></div>);
}

function Audit() {
  const [page, setPage] = useState(1); const [s, setS] = useState('');
  const q = useQuery({ queryKey: ['audit', page, s], queryFn: () => api('/api/restaurant/audit-logs', { query: { page, pageSize: 25, q: s } }), placeholderData: (p) => p });
  return (<div className="space-y-3"><Input aria-label="Filter" placeholder="Filter by action or entity" className="w-72" value={s} onChange={(e) => { setS(e.target.value); setPage(1); }} />
    <QueryBoundary q={q} empty={(d) => d.items.length === 0}>{(d) => (<><Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>{d.items.map((a: any) => <tr key={a.id} className="border-b border-border/60 align-top last:border-0"><td className="whitespace-nowrap p-3">{dateTime(a.createdAt)}</td><td>{a.user?.name ?? 'system'}</td><td className="font-mono text-xs">{a.action}</td><td>{a.entity} <span className="text-xs text-muted">{a.entityId?.slice(-6)}</span></td><td className="max-w-xs truncate text-xs text-muted">{a.detail ? JSON.stringify(a.detail) : ''}</td></tr>)}</tbody></table></Card>
      <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="self-center text-sm">{d.page} / {d.pages}</span><Button size="sm" variant="outline" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>Next</Button></div></>)}</QueryBoundary></div>);
}

function DataTab() {
  return (<Card className="max-w-3xl space-y-3 p-5 text-sm"><h2 className="text-xl">Backup & data management</h2>
    <p>All restaurant data lives in one PostgreSQL database. Backups are taken at the database level so they cover orders, customers, menu and settings together.</p>
    <ul className="list-disc space-y-1 pl-5 text-muted"><li>Managed Postgres (RDS/Neon/Supabase): enable automated daily backups and point-in-time recovery.</li><li>Self-hosted: schedule <code>pg_dump -Fc</code> nightly (see <code>docs/DEPLOY.md</code> for a cron example and restore steps).</li><li>Uploaded images are stored in the server <code>uploads/</code> folder (or S3 if configured) — include it in backups.</li><li>Test a restore at least quarterly.</li></ul>
    <p>Customer exports (CSV) are on the Customers page; individual PDPA/GDPR export and erasure requests are handled from each customer’s profile.</p></Card>);
}
void Select;

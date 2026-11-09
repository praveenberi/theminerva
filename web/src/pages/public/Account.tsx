import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, LogOut } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Field, Input, QueryBoundary, Switch, Tabs, Textarea, useToast, EmptyState } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { useSeo } from '@/lib/hooks';
import { dateTime, money, statusLabel } from '@/lib/format';

type Tab = 'profile' | 'orders' | 'loyalty' | 'privacy';

export default function Account() {
  useSeo('My account');
  const { user, ready, logout } = useAuth();
  const { tab = 'profile' } = useParams();
  const nav = useNavigate();
  if (!ready) return null;
  if (user?.kind !== 'customer') return <Navigate to="/login" state={{ from: '/account' }} replace />;
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between"><h1 className="text-4xl">Hello, {user.name.split(' ')[0]}</h1>
        <Button variant="outline" size="sm" onClick={async () => { await logout(); nav('/'); }}><LogOut className="h-4 w-4" /> Sign out</Button></div>
      <Tabs<Tab> value={tab as Tab} onChange={(t) => nav(`/account/${t}`)} tabs={[{ id: 'profile', label: 'Profile' }, { id: 'orders', label: 'Order history' }, { id: 'loyalty', label: 'Rewards' }, { id: 'privacy', label: 'Privacy' }]} />
      <div className="mt-6">{tab === 'orders' ? <Orders /> : tab === 'loyalty' ? <Rewards /> : tab === 'privacy' ? <PrivacyTab /> : <Profile />}</div>
    </div>
  );
}

function Profile() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['me-profile'], queryFn: () => api('/api/customers/me/profile') });
  const [f, setF] = useState<any>(null);
  const [addr, setAddr] = useState({ line1: '', postalCode: '' });
  const save = useMutation({ mutationFn: (b: any) => api('/api/customers/me/profile', { method: 'PUT', body: b }), onSuccess: () => { toast('success', 'Profile saved'); qc.invalidateQueries({ queryKey: ['me-profile'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const addAddr = useMutation({ mutationFn: () => api('/api/customers/me/addresses', { body: addr }), onSuccess: () => { setAddr({ line1: '', postalCode: '' }); qc.invalidateQueries({ queryKey: ['me-profile'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const delAddr = useMutation({ mutationFn: (id: string) => api(`/api/customers/me/addresses/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me-profile'] }) });
  return (
    <QueryBoundary q={q}>
      {(p) => { const v = f ?? { name: p.name, phone: p.phone ?? '', birthday: p.birthday?.slice(0, 10) ?? '', preferences: p.preferences ?? '', allergies: p.allergies ?? '', marketingConsent: p.marketingConsent }; const set = (k: string, val: any) => setF({ ...v, [k]: val });
        return (
          <div className="space-y-6">
            <Card className="space-y-4 p-5">
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ ...v, phone: v.phone || null, birthday: v.birthday || null }); }}>
                <Field label="Name">{(id) => <Input id={id} value={v.name} onChange={(e) => set('name', e.target.value)} required minLength={2} />}</Field>
                <Field label="Mobile">{(id) => <Input id={id} type="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
                <Field label="Birthday" hint="For a birthday treat">{(id) => <Input id={id} type="date" value={v.birthday} onChange={(e) => set('birthday', e.target.value)} />}</Field>
                <Field label="Email">{(id) => <Input id={id} value={p.email ?? ''} disabled />}</Field>
                <Field label="Allergies (optional, voluntarily shared)" className="sm:col-span-2">{(id) => <Textarea id={id} value={v.allergies} onChange={(e) => set('allergies', e.target.value)} />}</Field>
                <Field label="Food preferences" className="sm:col-span-2">{(id) => <Textarea id={id} value={v.preferences} onChange={(e) => set('preferences', e.target.value)} />}</Field>
                <label className="flex items-center gap-3 sm:col-span-2"><Switch label="Marketing messages" checked={v.marketingConsent} onChange={(c) => set('marketingConsent', c)} /> <span className="text-sm">Send me offers and news</span></label>
                <Button loading={save.isPending} className="sm:col-span-2 sm:w-fit">Save changes</Button>
              </form>
            </Card>
            <Card className="space-y-3 p-5"><h2 className="text-xl">Delivery addresses</h2>
              {p.addresses.map((a: any) => <div key={a.id} className="flex items-center justify-between text-sm"><span>{a.line1} {a.postalCode}</span><button className="text-danger underline" onClick={() => delAddr.mutate(a.id)}>Remove</button></div>)}
              <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); addAddr.mutate(); }}>
                <Input aria-label="Address" placeholder="Street address" required minLength={3} value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} />
                <Input aria-label="Postal code" placeholder="Postal code" className="sm:w-36" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} />
                <Button variant="outline" loading={addAddr.isPending}>Add</Button></form>
            </Card>
          </div>); }}
    </QueryBoundary>
  );
}

function Orders() {
  const q = useQuery({ queryKey: ['me-orders'], queryFn: () => api('/api/customers/me/orders', { query: { pageSize: 50 } }) });
  const { dispatch } = useCart(); const nav = useNavigate();
  return (
    <QueryBoundary q={q} empty={(d) => d.items.length === 0}>
      {(d) => (
        <ul className="space-y-3">{d.items.map((o: any) => (
          <Card key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div><p className="font-medium">Order #{o.number} <Badge tone={o.status === 'COMPLETED' ? 'success' : ['CANCELLED', 'REJECTED'].includes(o.status) ? 'danger' : 'warn'}>{statusLabel(o.status)}</Badge></p><p className="text-sm text-muted">{dateTime(o.createdAt)} · {o.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')}</p></div>
            <div className="flex items-center gap-3"><span className="font-medium">{money(o.total)}</span>
              <Link to={`/track/${o.trackingToken}`}><Button size="sm" variant="outline">View</Button></Link>
              <Button size="sm" onClick={() => { o.items.forEach((i: any) => dispatch({ t: 'add', line: { productId: i.productId, name: i.name, addonIds: (i.addons ?? []).map((a: any) => a.id), addonNames: (i.addons ?? []).map((a: any) => a.name), unitPrice: Number(i.unitPrice), quantity: i.quantity } })); nav('/checkout'); }}>Order again</Button></div>
          </Card>))}</ul>
      )}
    </QueryBoundary>
  );
}

function Rewards() {
  const qc = useQueryClient(); const toast = useToast();
  const profile = useQuery({ queryKey: ['me-profile'], queryFn: () => api('/api/customers/me/profile') });
  const hist = useQuery({ queryKey: ['me-loyalty'], queryFn: () => api('/api/customers/me/loyalty') });
  const [pts, setPts] = useState(100);
  const redeem = useMutation({ mutationFn: () => api('/api/customers/me/redeem', { body: { points: pts } }), onSuccess: (v) => { toast('success', `Voucher ${v.code} created`); qc.invalidateQueries({ queryKey: ['me-profile'] }); qc.invalidateQueries({ queryKey: ['me-loyalty'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <QueryBoundary q={profile}>
      {(p) => (
        <div className="space-y-6">
          <Card className="flex flex-wrap items-center justify-between gap-4 bg-brand p-6 text-brand-fg"><div><p className="text-sm opacity-80">Your points</p><p className="font-display text-5xl">{p.loyaltyPoints}</p><p className="text-sm opacity-80">{p.tier} member{p.loyalty.nextTier && ` · ${p.loyalty.nextTier.pointsNeeded} to ${p.loyalty.nextTier.name}`}</p></div><Gift className="h-12 w-12 text-accent" /></Card>
          <Card className="p-5"><h2 className="mb-1 text-xl">Redeem for a voucher</h2><p className="mb-3 text-sm text-muted">Minimum {p.loyalty.minRedeemPoints} points · each point is worth {money(p.loyalty.pointValue)}.</p>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); redeem.mutate(); }}><Input type="number" aria-label="Points" className="w-40" min={p.loyalty.minRedeemPoints} max={p.loyaltyPoints} value={pts} onChange={(e) => setPts(+e.target.value)} /><Button loading={redeem.isPending} disabled={p.loyaltyPoints < p.loyalty.minRedeemPoints}>Redeem</Button></form></Card>
          <QueryBoundary q={hist}>{(h) => (<>
            {h.vouchers.length > 0 && <Card className="p-5"><h2 className="mb-2 text-xl">Your vouchers</h2><ul className="space-y-1 text-sm">{h.vouchers.map((v: any) => <li key={v.id}><span className="font-mono font-semibold">{v.code}</span> — {money(v.amount)}{v.expiresAt && ` · expires ${dateTime(v.expiresAt)}`}</li>)}</ul></Card>}
            <Card className="p-5"><h2 className="mb-2 text-xl">History</h2>{h.transactions.length === 0 ? <p className="text-sm text-muted">No activity yet.</p> : <ul className="divide-y divide-border text-sm">{h.transactions.map((t: any) => <li key={t.id} className="flex justify-between py-2"><span>{statusLabel(t.reason)} · {dateTime(t.createdAt)}</span><span className={t.points < 0 ? 'text-danger' : 'text-success'}>{t.points > 0 ? '+' : ''}{t.points}</span></li>)}</ul>}</Card></>)}</QueryBoundary>
        </div>)}
    </QueryBoundary>
  );
}

function PrivacyTab() {
  const { logout } = useAuth(); const nav = useNavigate(); const toast = useToast();
  const del = useMutation({ mutationFn: () => api('/api/customers/me', { method: 'DELETE' }), onSuccess: async () => { await logout(); toast('success', 'Your personal data has been erased'); nav('/'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-xl">Your data</h2>
      <p className="text-sm text-muted">Under the PDPA and GDPR you can download or erase the personal data we hold about you. Order records are kept for accounting but are no longer linked to you.</p>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={async () => { try { const d = await api('/api/customers/me/export'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'my-data.json'; a.click(); } catch (e) { toast('error', errorMessage(e)); } }}>Download my data</Button>
        <ConfirmButton variant="danger" message="This permanently erases your profile, addresses and rewards. This cannot be undone." onConfirm={() => del.mutate()}>Delete my account</ConfirmButton>
      </div>
    </Card>
  );
}
void EmptyState;

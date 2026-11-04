import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Award, BarChart3, Bike, CreditCard, KeyRound, Lock, Boxes, Megaphone, CalendarDays, CookingPot, Store, ChefHat, ChevronLeft, ClipboardList, ExternalLink, LayoutDashboard, LogOut, Menu as MenuIcon, QrCode, Settings, Tag, UtensilsCrossed, Users, UserCog } from 'lucide-react';
import { api, errMsg, escapeHtml, fieldErrors, money, useAuth, type Me } from '../lib';
import { Empty, Field, Modal, Page, Skeleton, useToast } from '../ui';
import { InventoryPage, RecipeModal } from './inventory';
import { KitchenPage } from './kitchen';
import { BillingPage, Gated, SubscriptionBanner, useEntitlements } from './billing';
import { CustomerModal, LoyaltyPage, MarketingPage } from './marketing';
import { PaymentsSettings } from './payments';
import { AccountPage, EmailBanner } from './account';
import { OutletsPage, useSwitchOutlet } from './outlets';
import { DeliveryPage, PartnerSelect } from './delivery';
import { ReportsPage } from './reports';

type Role = Me['role'];
const NAV: { to: string; label: string; icon: any; roles: Role[]; feature?: string }[] = [
  { to: '', label: 'Overview', icon: LayoutDashboard, roles: ['OWNER', 'MANAGER'] },
  { to: 'kitchen', label: 'Kitchen', icon: CookingPot, roles: ['OWNER', 'MANAGER', 'KITCHEN'] },
  { to: 'orders', label: 'Orders', icon: ClipboardList, roles: ['OWNER', 'MANAGER', 'KITCHEN', 'WAITER'] },
  { to: 'delivery', label: 'Delivery', icon: Bike, roles: ['OWNER', 'MANAGER'] },
  { to: 'menu', label: 'Menu', icon: UtensilsCrossed, roles: ['OWNER', 'MANAGER'] },
  { to: 'inventory', label: 'Inventory', icon: Boxes, roles: ['OWNER', 'MANAGER'], feature: 'inventory' },
  { to: 'tables', label: 'Tables & QR', icon: QrCode, roles: ['OWNER', 'MANAGER'] },
  { to: 'reservations', label: 'Reservations', icon: CalendarDays, roles: ['OWNER', 'MANAGER', 'WAITER'], feature: 'reservations' },
  { to: 'coupons', label: 'Coupons', icon: Tag, roles: ['OWNER', 'MANAGER'], feature: 'promotions' },
  { to: 'customers', label: 'Customers', icon: Users, roles: ['OWNER', 'MANAGER'], feature: 'crm' },
  { to: 'reports', label: 'Reports', icon: BarChart3, roles: ['OWNER', 'MANAGER'] },
  { to: 'outlets', label: 'Outlets', icon: Store, roles: ['OWNER'] },
  { to: 'marketing', label: 'Marketing', icon: Megaphone, roles: ['OWNER', 'MANAGER'], feature: 'marketing' },
  { to: 'loyalty', label: 'Loyalty', icon: Award, roles: ['OWNER', 'MANAGER'], feature: 'loyalty' },
  { to: 'billing', label: 'Billing', icon: CreditCard, roles: ['OWNER'] },
  { to: 'staff', label: 'Staff', icon: UserCog, roles: ['OWNER'] },
  { to: 'account', label: 'Account', icon: KeyRound, roles: ['OWNER', 'MANAGER', 'KITCHEN', 'WAITER'] },
  { to: 'settings', label: 'Settings', icon: Settings, roles: ['OWNER'] },
];

export function Dashboard() {
  const { me, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const items = NAV.filter((n) => n.roles.includes(me!.role));
  const home = items[0].to;
  const ent = useEntitlements();
  const locked = (n: { feature?: string }) => !!n.feature && !!ent.data && (!ent.data.operational || !ent.data.features.includes(n.feature));
  const switchTo = useSwitchOutlet();
  const nav = useNavigate();
  const outletList = useQuery({ queryKey: ['outlets'], queryFn: () => api<any>('/outlets'), enabled: me!.role === 'OWNER' });
  const multi = (outletList.data?.outlets.length ?? 0) > 1;
  const side = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 text-lg font-extrabold"><ChefHat className="shrink-0 text-brand-500" />{!collapsed && 'Tablely'}</div>
      {multi && !collapsed && (
        <select className="input mb-3 py-2 text-sm font-semibold" aria-label="Current outlet" value={me!.restaurant?.id ?? ''}
          onChange={async (e) => { await switchTo(e.target.value); nav('/app'); setMobile(false); }}>
          {outletList.data.outlets.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
      {!multi && !collapsed && me!.restaurant && <p className="mb-3 truncate px-2 text-xs font-semibold text-stone-500">{me!.restaurant.name}</p>}
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === ''} onClick={() => setMobile(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${isActive ? 'bg-brand-50 text-brand-700' : 'text-stone-600 hover:bg-stone-100'}`}>
          <n.icon size={18} className="shrink-0" />{!collapsed && <span className="flex-1">{n.label}</span>}{!collapsed && locked(n) && <Lock size={13} className="text-stone-400" aria-label="Not in your plan" />}
        </NavLink>
      ))}
      <div className="mt-auto space-y-1">
        {me!.restaurant && <a href={`/r/${me!.restaurant.slug}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-stone-600 hover:bg-stone-100"><ExternalLink size={18} />{!collapsed && 'View storefront'}</a>}
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-stone-600 hover:bg-stone-100"><LogOut size={18} />{!collapsed && 'Log out'}</button>
      </div>
    </nav>
  );
  return (
    <div className="flex min-h-screen">
      <motion.aside animate={{ width: collapsed ? 72 : 232 }} className="sticky top-0 hidden h-screen shrink-0 border-r border-stone-200 bg-white md:block">
        {side}
        <button className="absolute -right-3 top-6 rounded-full bg-white p-1 shadow ring-1 ring-stone-200" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar"><ChevronLeft size={16} className={collapsed ? 'rotate-180' : ''} /></button>
      </motion.aside>
      <AnimatePresence>
        {mobile && <motion.div className="fixed inset-0 z-40 bg-black/40 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobile(false)}>
          <motion.aside className="h-full w-60 bg-white" initial={{ x: -240 }} animate={{ x: 0 }} exit={{ x: -240 }} onClick={(e) => e.stopPropagation()}>{side}</motion.aside></motion.div>}
      </AnimatePresence>
      <main className="min-w-0 flex-1">
        <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-3 md:hidden"><button onClick={() => setMobile(true)} aria-label="Open menu"><MenuIcon /></button><span className="font-bold">{me!.restaurant?.name}</span></header>
        <SubscriptionBanner />
        <EmailBanner />
        <div className="mx-auto max-w-6xl p-4 sm:p-6">
          <Routes>
            <Route index element={items.some((i) => i.to === '') ? <Overview /> : <Navigate to={home} replace />} />
            <Route path="outlets" element={<OutletsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="marketing" element={<Gated feature="marketing" label="Marketing campaigns"><MarketingPage /></Gated>} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="loyalty" element={<Gated feature="loyalty" label="Loyalty & rewards"><LoyaltyPage /></Gated>} />
            <Route path="kitchen" element={<KitchenPage />} />
            <Route path="delivery" element={<DeliveryPage />} />
            <Route path="orders" element={<Orders />} />
            <Route path="menu" element={<MenuPage />} />
            <Route path="inventory" element={<Gated feature="inventory" label="Inventory"><InventoryPage /></Gated>} />
            <Route path="tables" element={<TablesPage />} />
            <Route path="reservations" element={<Gated feature="reservations" label="Reservations"><Reservations /></Gated>} />
            <Route path="coupons" element={<Gated feature="promotions" label="Offers & coupons"><Coupons /></Gated>} />
            <Route path="customers" element={<Gated feature="crm" label="Customer CRM"><Customers /></Gated>} />
            <Route path="staff" element={<StaffPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="account" element={<AccountPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

const Title = ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => <div className="mb-5 flex items-center justify-between gap-3"><h1 className="text-2xl font-extrabold">{children}</h1>{action}</div>;
const useRestaurant = () => useQuery({ queryKey: ['restaurant'], queryFn: () => api<any>('/restaurant') });

// ---------------- Overview ----------------
function Overview() {
  const [range, setRange] = useState('today');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const { data: r } = useRestaurant();
  const cur = r?.currency ?? 'INR';
  const qs = `range=${range}&tzOffset=${new Date().getTimezoneOffset()}${range === 'custom' ? `&from=${custom.from}&to=${custom.to}` : ''}`;
  const { data: d, isLoading, error } = useQuery({ queryKey: ['dash', qs], queryFn: () => api<any>(`/dashboard?${qs}`), enabled: range !== 'custom' || !!(custom.from && custom.to), refetchInterval: 30000 });
  const stats: [string, string | number][] | undefined = d && [
    ['Revenue', money(d.revenueCents, cur)], ['Orders', d.orders], ['Pending', d.pendingOrders], ['Completed', d.completedOrders],
    ['Avg. order', money(d.averageOrderCents, cur)], ['Reservations', d.reservations], ['Customers', d.activeCustomers], ['Cancelled', d.cancelledOrders],
  ];
  return (
    <Page>
      <Title action={
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range">
            <option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="custom">Custom…</option>
          </select>
          {range === 'custom' && <><input type="date" className="input w-auto" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" /><input type="date" className="input w-auto" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" /></>}
        </div>}>Overview</Title>
      {error && <p className="err">{errMsg(error)}</p>}
      {isLoading || !d ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stats!.map(([k, v], i) => <motion.div key={k as string} className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}><p className="text-sm text-stone-500">{k}</p><p className="mt-1 text-2xl font-extrabold">{v}</p></motion.div>)}
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="card"><h2 className="mb-3 font-bold">Revenue</h2>
              <div className="h-56"><ResponsiveContainer><AreaChart data={d.trend.map((t: any) => ({ ...t, revenue: t.revenueCents / 100 }))}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" fontSize={11} tickFormatter={(s) => s.slice(5)} /><YAxis fontSize={11} width={48} /><Tooltip /><Area dataKey="revenue" stroke="#f26a1b" fill="#fde0cc" /></AreaChart></ResponsiveContainer></div></div>
            <div className="card"><h2 className="mb-3 font-bold">Orders by hour</h2>
              <div className="h-56"><ResponsiveContainer><BarChart data={d.peakHours}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="hour" fontSize={11} /><YAxis allowDecimals={false} fontSize={11} width={28} /><Tooltip /><Bar dataKey="orders" fill="#f26a1b" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div></div>
            <div className="card"><h2 className="mb-3 font-bold">Best sellers</h2>
              {d.topProducts.length === 0 ? <p className="text-sm text-stone-500">No sales in this period.</p> : d.topProducts.map((p: any) => <div key={p.name} className="flex justify-between border-b border-stone-100 py-2 text-sm last:border-0"><span>{p.name}</span><span className="text-stone-500">{p.quantity} sold · {money(p.revenueCents, cur)}</span></div>)}</div>
            <div className="card"><h2 className="mb-3 font-bold">Low stock</h2>
              {d.lowStock.length === 0 ? <p className="text-sm text-stone-500">All ingredients are above their alert level.</p> : d.lowStock.map((i: any) => <div key={i.id} className="flex justify-between border-b border-stone-100 py-2 text-sm last:border-0"><span>{i.name}</span><span className="font-semibold text-red-600">{Math.round(i.stockQty * 1000) / 1000} {i.unit}</span></div>)}</div>
            <div className="card"><h2 className="mb-3 font-bold">Recent orders</h2>
              {d.recent.length === 0 ? <p className="text-sm text-stone-500">No orders yet.</p> : d.recent.map((o: any) => <div key={o.number} className="flex justify-between border-b border-stone-100 py-2 text-sm last:border-0"><span>#{o.number} · {o.customerName}</span><span className="text-stone-500">{o.status.replace(/_/g, ' ')} · {money(o.totalCents, cur)}</span></div>)}</div>
          </div>
        </>
      )}
    </Page>
  );
}

// ---------------- Orders (kanban) ----------------
const COLS = [['NEW', 'New'], ['ACCEPTED', 'Accepted'], ['PREPARING', 'Preparing'], ['READY', 'Ready'], ['DONE', 'Out / Served']] as const;
const NEXT: Record<string, { label: string; to: string }[]> = {
  NEW: [{ label: 'Accept', to: 'ACCEPTED' }], ACCEPTED: [{ label: 'Start preparing', to: 'PREPARING' }], PREPARING: [{ label: 'Mark ready', to: 'READY' }],
  READY: [], SERVED: [{ label: 'Complete', to: 'COMPLETED' }], OUT_FOR_DELIVERY: [{ label: 'Complete', to: 'COMPLETED' }],
};

function Orders() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data: r } = useRestaurant();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [view, setView] = useState('active');
  const { data, isLoading } = useQuery({ queryKey: ['orders', search, type, view], queryFn: () => api<any>(`/orders?${view === 'active' ? 'active=1' : `status=${view}`}&pageSize=100${type ? `&type=${type}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`), refetchInterval: 5000 });
  const canAssign = me!.role !== 'KITCHEN';
  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<any[]>('/delivery/partners'), enabled: canAssign });
  const refund = async (o: any) => {
    const paid = (o.totalCents / 100).toFixed(2);
    const v = prompt(`Refund order #${o.number} (paid ${paid}). Amount to refund — leave as is for the full amount:`, paid);
    if (v === null) return;
    const cents = Math.round(Number(v) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return toast('Enter a valid amount', 'err');
    try { const r = await api<any>('/payments/refund', { body: { orderId: o.id, amountCents: cents } }); toast(`Refunded ${money(r.amountCents, cur)}`); qc.invalidateQueries({ queryKey: ['orders'] }); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/orders/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }), onError: (e) => { toast(errMsg(e), 'err'); qc.invalidateQueries({ queryKey: ['orders'] }); },
  });
  const pay = useMutation({
    mutationFn: ({ id, paymentStatus }: { id: string; paymentStatus: string }) => api(`/orders/${id}/payment`, { method: 'PATCH', body: { paymentStatus } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }), onError: (e) => toast(errMsg(e), 'err'),
  });
  const cur = r?.currency ?? 'INR';
  const canCancel = me!.role === 'OWNER' || me!.role === 'MANAGER';
  const items: any[] = data?.items ?? [];
  const colOf = (o: any) => (['SERVED', 'OUT_FOR_DELIVERY'].includes(o.status) ? 'DONE' : o.status);
  const actions = (o: any) => {
    const a = [...(NEXT[o.status] ?? [])];
    if (o.status === 'READY') a.push(o.type === 'DELIVERY' ? { label: 'Out for delivery', to: 'OUT_FOR_DELIVERY' } : o.type === 'DINE_IN' ? { label: 'Served', to: 'SERVED' } : { label: 'Complete', to: 'COMPLETED' });
    return a;
  };
  return (
    <Page>
      <Title action={<div className="flex gap-2"><input className="input w-40" placeholder="Search name, phone, #" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search orders" />
        <select className="input w-auto" value={view} onChange={(e) => setView(e.target.value)} aria-label="Order view"><option value="active">Active</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option><option value="PENDING_PAYMENT">Awaiting payment</option></select>
        <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Order type"><option value="">All types</option><option value="DINE_IN">Dine-in</option><option value="TAKEAWAY">Takeaway</option><option value="DELIVERY">Delivery</option></select></div>}>Orders</Title>
      {isLoading ? <Skeleton className="h-64" /> : view !== 'active' ? (
        !items.length ? <Empty title="No orders here" /> : (
          <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['#', 'Customer', 'Type', 'Total', 'Payment', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
            <tbody>{items.map((o) => <tr key={o.id} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">#{o.number}</td><td className="px-4 py-3">{o.customerName}</td><td className="px-4 py-3">{o.type.replace('_', ' ')}</td><td className="px-4 py-3">{money(o.totalCents, cur)}</td>
              <td className="px-4 py-3">{o.paymentMethod.toLowerCase()} · {o.paymentStatus.replace('_', ' ').toLowerCase()}</td>
              <td className="px-4 py-3 text-right">{canCancel && o.paymentMethod === 'ONLINE' && ['PAID', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus) && <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => refund(o)}>Refund</button>}</td></tr>)}</tbody></table></div>)
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLS.map(([key, label]) => {
            const col = items.filter((o) => colOf(o) === key);
            return (
              <div key={key} className="w-64 shrink-0 rounded-2xl bg-stone-100 p-2 lg:w-auto lg:min-w-[200px] lg:flex-1">
                <h2 className="px-2 py-1 text-sm font-bold">{label} <span className="text-stone-400">{col.length}</span></h2>
                <div className="space-y-2">
                  <AnimatePresence>
                    {col.map((o) => {
                      const mins = Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60000);
                      return (
                        <motion.div layout key={o.id} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="card p-3 text-sm">
                          <div className="flex justify-between font-bold"><span>#{o.number}</span><span className={mins > 20 && ['NEW', 'ACCEPTED', 'PREPARING'].includes(o.status) ? 'text-red-600' : 'text-stone-400'}>{mins}m</span></div>
                          <p className="text-xs text-stone-500">{o.type.replace('_', ' ')}{o.table ? ` · ${o.table.label}` : ''} · {o.customerName}</p>
                          <ul className="my-2 space-y-0.5">{o.items.map((i: any) => <li key={i.id}>{i.quantity}× {i.name}{i.options?.length ? <span className="text-xs text-stone-500"> ({i.options.join(', ')})</span> : null}{i.notes && <div className="text-xs italic text-amber-700">“{i.notes}”</div>}</li>)}</ul>
                          {o.notes && <p className="mb-2 rounded bg-amber-50 p-1.5 text-xs text-amber-800">{o.notes}</p>}
                          {['ACCEPTED', 'PREPARING'].includes(o.status) && <p className="mb-1 text-xs text-stone-500">Prepared {o.items.filter((i: any) => i.prepDone).length}/{o.items.length}</p>}
                          {o.type === 'DELIVERY' && canAssign && <div className="mb-2"><PartnerSelect order={o} partners={partners.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ['orders'] })} /></div>}
                          {o.type === 'DELIVERY' && !canAssign && o.deliveryPartner && <p className="mb-1 text-xs text-stone-500">Rider: {o.deliveryPartner.name}</p>}
                          <p className="text-xs text-stone-500">{money(o.totalCents, cur)} · {o.paymentMethod.toLowerCase()} {o.paymentStatus.toLowerCase()}</p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {actions(o).map((a) => <button key={a.to} className="btn-primary px-2.5 py-1.5 text-xs" disabled={move.isPending} onClick={() => move.mutate({ id: o.id, status: a.to })}>{a.label}</button>)}
                            {o.paymentMethod === 'ONLINE' && o.paymentStatus === 'PAID' && <span className="self-center text-xs font-semibold text-green-700">Paid online</span>}
                            {canCancel && o.paymentMethod === 'ONLINE' && ['PAID', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus) && <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => refund(o)}>Refund</button>}
                            {o.paymentMethod === 'CASH' && o.paymentStatus === 'UNPAID' && me!.role !== 'KITCHEN' && <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => pay.mutate({ id: o.id, paymentStatus: 'PAID' })}>Mark paid</button>}
                            {canCancel && ['NEW', 'ACCEPTED', 'PREPARING'].includes(o.status) && <button className="btn-ghost px-2.5 py-1.5 text-xs text-red-600" onClick={() => confirm(`Cancel order #${o.number}?`) && move.mutate({ id: o.id, status: 'CANCELLED' })}>Cancel</button>}
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                  {col.length === 0 && <p className="px-2 py-4 text-center text-xs text-stone-400">Empty</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}

// ---------------- Menu ----------------
const emptyProduct = { name: '', description: '', priceCents: 0, discountPriceCents: null as number | null, categoryId: '', imageUrl: '', available: true, dietary: [] as string[], allergens: [] as string[], prepMinutes: 15, variants: [] as any[], addons: [] as any[] };

function MenuPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: r } = useRestaurant();
  const cats = useQuery({ queryKey: ['cats'], queryFn: () => api<any[]>('/categories') });
  const prods = useQuery({ queryKey: ['prods'], queryFn: () => api<any[]>('/products') });
  const [edit, setEdit] = useState<any | null>(null);
  const [newCat, setNewCat] = useState('');
  const [recipeFor, setRecipeFor] = useState<any | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const cur = r?.currency ?? 'INR';
  const refresh = () => { qc.invalidateQueries({ queryKey: ['cats'] }); qc.invalidateQueries({ queryKey: ['prods'] }); };
  const run = (fn: () => Promise<any>, ok?: string) => fn().then(() => { refresh(); ok && toast(ok); }).catch((e) => toast(errMsg(e), 'err'));
  const move = (i: number, d: number) => {
    const ids = cats.data!.map((c) => c.id); [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    run(() => api('/categories/order', { method: 'PUT', body: { ids } }));
  };
  return (
    <Page>
      <Title action={<div className="flex gap-2"><button className="btn-ghost" onClick={() => setCsvOpen(true)}>Import CSV</button><a className="btn-ghost" href="/api/menu/export.csv" onClick={async (e) => { e.preventDefault(); const t = await api<string>('/menu/export.csv'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'menu.csv'; a.click(); }}>Export CSV</a>
        <button className="btn-primary" disabled={!cats.data?.length} onClick={() => setEdit({ ...emptyProduct, categoryId: cats.data![0].id })}>Add item</button></div>}>Menu</Title>
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newCat.trim()) run(() => api('/categories', { body: { name: newCat } }), 'Category added').then(() => setNewCat('')); }}>
        <input className="input max-w-xs" placeholder="New category (e.g. Starters)" value={newCat} onChange={(e) => setNewCat(e.target.value)} aria-label="New category" /><button className="btn-ghost">Add category</button>
      </form>
      {cats.isLoading || prods.isLoading ? <Skeleton className="h-48" /> : !cats.data?.length ? <Empty title="Start with a category" hint="Create a category such as Starters or Mains, then add items to it." /> : (
        <div className="space-y-5">
          {cats.data.map((c, i) => (
            <section key={c.id} className="card">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="flex-1 font-bold">{c.name}</h2>
                <button className="btn-ghost px-2 py-1 text-xs" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button className="btn-ghost px-2 py-1 text-xs" disabled={i === cats.data.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { const n = prompt('Rename category', c.name); if (n?.trim()) run(() => api(`/categories/${c.id}`, { method: 'PATCH', body: { name: n } })); }}>Rename</button>
                <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => confirm(`Delete "${c.name}" and all its items?`) && run(() => api(`/categories/${c.id}`, { method: 'DELETE' }), 'Category deleted')}>Delete</button>
              </div>
              {prods.data!.filter((p) => p.categoryId === c.id).map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 border-t border-stone-100 py-2 text-sm">
                  <div className="min-w-0"><p className={`font-semibold ${p.available ? '' : 'text-stone-400 line-through'}`}>{p.name}</p><p className="truncate text-xs text-stone-500">{p.description}</p></div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="mr-1 font-semibold">{money(p.discountPriceCents ?? p.priceCents, cur)}</span>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => api(`/products/${p.id}/availability`, { method: 'PATCH', body: { available: !p.available } }))}>{p.available ? 'Mark sold out' : 'Mark available'}</button>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRecipeFor(p)}>Recipe</button>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEdit({ ...p, imageUrl: p.imageUrl ?? '' })}>Edit</button>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => api(`/products/${p.id}/duplicate`, { method: 'POST', body: {} }), 'Duplicated')}>Copy</button>
                    <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => confirm(`Delete "${p.name}"?`) && run(() => api(`/products/${p.id}`, { method: 'DELETE' }), 'Item deleted')}>Delete</button>
                  </div>
                </div>
              ))}
              {!prods.data!.some((p) => p.categoryId === c.id) && <p className="text-sm text-stone-500">No items yet.</p>}
            </section>
          ))}
        </div>
      )}
      <ProductEditor product={edit} cats={cats.data ?? []} cur={cur} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); toast('Saved'); }} />
      <RecipeModal product={recipeFor} onClose={() => setRecipeFor(null)} />
      <Modal open={csvOpen} onClose={() => setCsvOpen(false)} title="Import menu from CSV">
        <p className="mb-2 text-sm text-stone-600">Columns: <code>category,name,description,price,available</code> (header row first).</p>
        <textarea className="input font-mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} />
        <button className="btn-primary mt-3 w-full" disabled={!csv.trim()} onClick={() => api<any>('/menu/import', { body: { csv } }).then((r) => { refresh(); toast(`Imported ${r.created} items${r.errors.length ? `, ${r.errors.length} skipped` : ''}`, r.errors.length ? 'err' : 'ok'); setCsvOpen(false); setCsv(''); }).catch((e) => toast(errMsg(e), 'err'))}>Import</button>
      </Modal>
    </Page>
  );
}

function OptionEditor({ label, items, onChange, cur }: { label: string; items: any[]; onChange: (v: any[]) => void; cur: string }) {
  return (
    <div><p className="label">{label}</p>
      {items.map((o, i) => (
        <div key={o.id} className="mb-1.5 flex gap-2">
          <input className="input" placeholder="Name" value={o.name} onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} aria-label={`${label} name`} />
          <input className="input w-28" type="number" min={0} step="0.01" placeholder="+Price" value={o.priceCents / 100} onChange={(e) => onChange(items.map((x, j) => j === i ? { ...x, priceCents: Math.round(Number(e.target.value) * 100) } : x))} aria-label={`${label} price (${cur})`} />
          <button type="button" className="btn-ghost px-3" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">×</button>
        </div>
      ))}
      <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onChange([...items, { id: Math.random().toString(36).slice(2, 8), name: '', priceCents: 0 }])}>+ Add</button>
    </div>
  );
}

function ProductEditor({ product, cats, cur, onClose, onSaved }: { product: any | null; cats: any[]; cur: string; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState<any>(emptyProduct);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (product) { setP(product); setErr(null); } }, [product]);
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { categoryId: p.categoryId, name: p.name, description: p.description, priceCents: p.priceCents, discountPriceCents: p.discountPriceCents, imageUrl: p.imageUrl || null,
      available: p.available, dietary: p.dietary, allergens: p.allergens, prepMinutes: p.prepMinutes, variants: p.variants, addons: p.addons };
    try { await api(p.id ? `/products/${p.id}` : '/products', { method: p.id ? 'PUT' : 'POST', body }); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const toggle = (k: 'dietary', v: string) => setP({ ...p, [k]: p[k].includes(v) ? p[k].filter((x: string) => x !== v) : [...p[k], v] });
  const priceField = (k: 'priceCents' | 'discountPriceCents', label: string) => (
    <Field label={label} error={fieldErrors(err, k)}><input className="input" type="number" min={0} step="0.01" value={p[k] == null ? '' : p[k] / 100} onChange={(e) => setP({ ...p, [k]: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })} /></Field>
  );
  return (
    <Modal open={!!product} onClose={onClose} title={p.id ? 'Edit item' : 'New item'}>
      <div className="space-y-3">
        <Field label="Name" error={fieldErrors(err, 'name')}><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="Description"><textarea className="input" rows={2} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} /></Field>
        <Field label="Category"><select className="input" value={p.categoryId} onChange={(e) => setP({ ...p, categoryId: e.target.value })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">{priceField('priceCents', `Price (${cur})`)}{priceField('discountPriceCents', 'Discounted price')}</div>
        <Field label="Image URL" error={fieldErrors(err, 'imageUrl')}><input className="input" placeholder="https://…" value={p.imageUrl} onChange={(e) => setP({ ...p, imageUrl: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-3 text-sm">{[['VEG', 'Vegetarian'], ['VEGAN', 'Vegan'], ['NON_VEG', 'Non-veg'], ['GLUTEN_FREE', 'Gluten free']].map(([v, l]) => <label key={v}><input type="checkbox" className="mr-1.5" checked={p.dietary.includes(v)} onChange={() => toggle('dietary', v)} />{l}</label>)}</div>
        <Field label="Allergens (comma separated)"><input className="input" value={p.allergens.join(', ')} onChange={(e) => setP({ ...p, allergens: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} /></Field>
        <OptionEditor label="Sizes / variants (price is added)" items={p.variants} onChange={(v) => setP({ ...p, variants: v })} cur={cur} />
        <OptionEditor label="Add-ons" items={p.addons} onChange={(v) => setP({ ...p, addons: v })} cur={cur} />
        {!!err && !fieldErrors(err, 'name') && <p className="err" role="alert">{errMsg(err)}</p>}
        <button className="btn-primary w-full" disabled={busy || !p.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save item'}</button>
      </div>
    </Modal>
  );
}

// ---------------- Tables & QR ----------------
function TablesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: r } = useRestaurant();
  const { data: tables, isLoading } = useQuery({ queryKey: ['tables'], queryFn: () => api<any[]>('/tables') });
  const [f, setF] = useState({ label: '', capacity: 4 });
  const add = useMutation({ mutationFn: () => api('/tables', { body: f }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tables'] }); setF({ ...f, label: '' }); }, onError: (e) => toast(errMsg(e), 'err') });
  const del = useMutation({ mutationFn: (id: string) => api(`/tables/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }) });
  const [qr, setQr] = useState<{ title: string; src: string; tableId?: string } | null>(null);
  const show = async (title: string, tableId?: string) => {
    const res = await fetch(`/api/qr?format=png${tableId ? `&tableId=${tableId}` : ''}`, { headers: { Authorization: `Bearer ${(await import('../lib')).getToken()}` } });
    setQr({ title, src: URL.createObjectURL(await res.blob()), tableId });
  };
  return (
    <Page>
      <Title action={<button className="btn-ghost" onClick={() => show('Restaurant QR')}><QrCode size={16} /> Restaurant QR</button>}>Tables & QR codes</Title>
      {r && !r.published && <p className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Your storefront is not published, so QR codes will show “not found”. Publish it in Settings.</p>}
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <input className="input w-32" placeholder="Label (T7)" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} aria-label="Table label" />
        <input className="input w-28" type="number" min={1} max={50} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} aria-label="Seats" />
        <button className="btn-primary" disabled={!f.label.trim() || add.isPending}>Add table</button>
      </form>
      {isLoading ? <Skeleton className="h-32" /> : !tables?.length ? <Empty title="No tables yet" hint="Add tables to get a QR code for each." /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tables.map((t) => <div key={t.id} className="card"><p className="text-lg font-bold">{t.label}</p><p className="text-sm text-stone-500">{t.capacity} seats</p>
            <div className="mt-3 flex gap-2"><button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => show(`Table ${t.label}`, t.id)}>QR code</button><button className="btn-ghost px-3 py-1.5 text-xs text-red-600" onClick={() => confirm(`Delete table ${t.label}?`) && del.mutate(t.id)}>Delete</button></div></div>)}
        </div>
      )}
      <Modal open={!!qr} onClose={() => setQr(null)} title={qr?.title ?? ''}>
        {qr && <div className="text-center"><img src={qr.src} alt={`QR code for ${qr.title}`} className="mx-auto w-64" />
          <div className="mt-4 flex justify-center gap-2"><a className="btn-primary" href={qr.src} download={`${qr.title}.png`}>Download PNG</a>
            <button className="btn-ghost" onClick={() => { const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(qr.title)}</title><body style="text-align:center;font-family:sans-serif"><h1>${escapeHtml(qr.title)}</h1><img src="${escapeHtml(qr.src)}" width="400"><p>Scan to order</p>`; const w = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank'); w?.addEventListener('load', () => w.print()); }}>Print</button></div></div>}
      </Modal>
    </Page>
  );
}

// ---------------- Reservations ----------------
function Reservations() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['resv'], queryFn: () => api<any[]>('/reservations'), refetchInterval: 15000 });
  const set = (id: string, status: string) => api(`/reservations/${id}`, { method: 'PATCH', body: { status } }).then(() => qc.invalidateQueries({ queryKey: ['resv'] })).catch((e) => toast(errMsg(e), 'err'));
  return (
    <Page>
      <Title>Reservations</Title>
      {isLoading ? <Skeleton className="h-40" /> : !data?.length ? <Empty title="No reservations" hint="Guests can book from your storefront’s “Book a table” button." /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['When', 'Guest', 'Party', 'Table', 'Status', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{data.map((r) => <tr key={r.id} className="border-t border-stone-100"><td className="px-4 py-3">{new Date(r.startsAt).toLocaleString()}</td><td className="px-4 py-3">{r.name}<div className="text-xs text-stone-500">{r.phone}</div></td><td className="px-4 py-3">{r.partySize}</td><td className="px-4 py-3">{r.table.label}</td><td className="px-4 py-3">{r.status.replace('_', ' ')}</td>
            <td className="space-x-1 px-4 py-3 text-right">{r.status === 'CONFIRMED' && <><button className="btn-ghost px-2 py-1 text-xs" onClick={() => set(r.id, 'COMPLETED')}>Seated</button><button className="btn-ghost px-2 py-1 text-xs" onClick={() => set(r.id, 'NO_SHOW')}>No-show</button><button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => set(r.id, 'CANCELLED')}>Cancel</button></>}</td></tr>)}</tbody></table></div>
      )}
    </Page>
  );
}

// ---------------- Coupons ----------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function Coupons() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: r } = useRestaurant();
  const { data, isLoading } = useQuery({ queryKey: ['coupons'], queryFn: () => api<any[]>('/coupons') });
  const cats = useQuery({ queryKey: ['cats'], queryFn: () => api<any[]>('/categories') });
  const blank = { code: '', type: 'PERCENT', value: 10, min: 0, limit: '', categoryId: '', days: [] as number[], start: '', end: '', phone: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<unknown>(null);
  const cur = r?.currency ?? 'INR';
  const refresh = () => qc.invalidateQueries({ queryKey: ['coupons'] });
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      await api('/coupons', { body: {
        code: f.code, type: f.type, value: f.type === 'FIXED' ? Math.round(f.value * 100) : f.type === 'BOGO' ? 1 : f.value, minSubtotalCents: Math.round(f.min * 100),
        usageLimit: f.limit ? Number(f.limit) : null, categoryId: f.categoryId || null, daysOfWeek: f.days, startTime: f.start || null, endTime: f.end || null, customerPhone: f.phone || null,
      } });
      setF({ ...blank, type: f.type }); refresh(); toast('Offer created');
    } catch (x) { setErr(x); }
  };
  const describe = (c: any) => {
    const what = c.type === 'PERCENT' ? `${c.value}% off` : c.type === 'FIXED' ? `${money(c.value, cur)} off` : 'Buy one, get one free';
    const bits = [what, c.categoryId && `only ${cats.data?.find((x) => x.id === c.categoryId)?.name ?? 'one category'}`, c.minSubtotalCents ? `min ${money(c.minSubtotalCents, cur)}` : '',
      c.daysOfWeek?.length && c.daysOfWeek.map((d: number) => DAYS[d]).join('/'), c.startMinute != null && `${String(Math.floor(c.startMinute / 60)).padStart(2, '0')}:${String(c.startMinute % 60).padStart(2, '0')}–${String(Math.floor(c.endMinute / 60)).padStart(2, '0')}:${String(c.endMinute % 60).padStart(2, '0')}`,
      c.customerPhone && `for ${c.customerPhone}`].filter(Boolean);
    return bits.join(' · ');
  };
  const codeErr = fieldErrors(err, 'code') ? 'Use 3–20 letters/digits' : (err as any)?.status === 409 ? errMsg(err) : undefined;
  const regular = (data ?? []).filter((c) => !c.source); // vouchers made by redemptions and birthdays live on the customer
  const vouchers = (data ?? []).filter((c) => c.source);
  return (
    <Page>
      <Title>Offers & coupons</Title>
      <form onSubmit={add} className="card mb-4 grid gap-3 sm:grid-cols-4">
        <Field label="Code" error={codeErr}><input className="input uppercase" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Offer"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="PERCENT">Percent off</option><option value="FIXED">Fixed amount off ({cur})</option><option value="BOGO">Buy one get one free</option></select></Field>
        {f.type !== 'BOGO' && <Field label={f.type === 'PERCENT' ? 'Percent' : `Amount (${cur})`} error={fieldErrors(err, 'value')}><input className="input" type="number" min={1} value={f.value} onChange={(e) => setF({ ...f, value: Number(e.target.value) })} /></Field>}
        <Field label="Applies to"><select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">Whole menu</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name} only</option>)}</select></Field>
        <Field label="Min. order"><input className="input" type="number" min={0} value={f.min} onChange={(e) => setF({ ...f, min: Number(e.target.value) })} /></Field>
        <Field label="Usage limit"><input className="input" type="number" min={1} placeholder="Unlimited" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></Field>
        <Field label="Only for customer (phone)" error={fieldErrors(err, 'customerPhone')}><input className="input" type="tel" placeholder="Optional" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <div className="sm:col-span-4 rounded-xl bg-stone-50 p-3"><p className="label">Happy hour (optional, restaurant local time)</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {DAYS.map((d, i) => <label key={d}><input type="checkbox" className="mr-1" checked={f.days.includes(i)} onChange={() => setF({ ...f, days: f.days.includes(i) ? f.days.filter((x) => x !== i) : [...f.days, i] })} />{d}</label>)}
            <input className="input w-32" type="time" aria-label="From" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /><span>to</span><input className="input w-32" type="time" aria-label="Until" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </div>{!!fieldErrors(err, 'startTime') && <p className="err">{fieldErrors(err, 'startTime')}</p>}
          <p className="mt-1 text-xs text-stone-500">No days ticked = every day. Leave times empty for all day. Set the restaurant clock in Settings.</p></div>
        <div className="sm:col-span-4"><button className="btn-primary" disabled={!f.code}>Create offer</button>{!!err && !codeErr && !fieldErrors(err, 'value') && !fieldErrors(err, 'startTime') && !fieldErrors(err, 'customerPhone') && <span className="err ml-3" role="alert">{errMsg(err)}</span>}</div>
      </form>
      {isLoading ? <Skeleton /> : !regular.length ? <Empty title="No offers yet" /> : regular.map((c) => (
        <div key={c.id} className="card mb-2 flex items-center justify-between gap-3">
          <div><p className="font-bold">{c.code}</p><p className="text-sm text-stone-600">{describe(c)}</p><p className="text-xs text-stone-500">Used {c.usedCount}{c.usageLimit ? ` / ${c.usageLimit}` : ''}</p></div>
          <div className="flex shrink-0 gap-2"><button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => api(`/coupons/${c.id}`, { method: 'PATCH', body: { active: !c.active } }).then(refresh)}>{c.active ? 'Disable' : 'Enable'}</button>
            <button className="btn-ghost px-3 py-1.5 text-xs text-red-600" onClick={() => confirm('Delete coupon?') && api(`/coupons/${c.id}`, { method: 'DELETE' }).then(refresh)}>Delete</button></div>
        </div>
      ))}
      {vouchers.length > 0 && <p className="mt-4 text-sm text-stone-500">{vouchers.length} customer voucher{vouchers.length > 1 ? 's' : ''} (from redeemed points and birthdays) are listed on each customer’s profile.</p>}
    </Page>
  );
}

// ---------------- Customers ----------------
function Customers() {
  const qc = useQueryClient();
  const { data: r } = useRestaurant();
  const { data, isLoading } = useQuery({ queryKey: ['customers'], queryFn: () => api<any[]>('/customers') });
  const [seg, setSeg] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rows = (data ?? []).filter((c) => !seg || c.segment === seg);
  return (
    <Page>
      <Title action={<select className="input w-auto" value={seg} onChange={(e) => setSeg(e.target.value)} aria-label="Segment"><option value="">All segments</option>{['NEW', 'RETURNING', 'VIP', 'INACTIVE'].map((s) => <option key={s}>{s}</option>)}</select>}>Customers</Title>
      {isLoading ? <Skeleton className="h-40" /> : !rows.length ? <Empty title="No customers yet" hint="Customers appear automatically when they place an order." /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Name', 'Phone', 'Orders', 'Spent', 'Points', 'Level', 'Segment', 'Marketing', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{rows.map((c) => <tr key={c.id} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">{c.name}</td><td className="px-4 py-3">{c.phone}</td><td className="px-4 py-3">{c.orderCount}</td><td className="px-4 py-3">{money(c.spentCents, r?.currency)}</td><td className="px-4 py-3">{c.loyaltyPoints}</td><td className="px-4 py-3">{c.tier}</td><td className="px-4 py-3">{c.segment}</td><td className="px-4 py-3">{c.optedOut ? 'Opted out' : c.marketingConsent ? 'Agreed' : '—'}</td>
            <td className="px-4 py-3 text-right"><button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setOpen(c.id)}>Open</button></td></tr>)}</tbody></table></div>
      )}
      <CustomerModal id={open} currency={r?.currency ?? 'INR'} onClose={() => setOpen(null)} onChanged={() => qc.invalidateQueries({ queryKey: ['customers'] })} />
    </Page>
  );
}

// ---------------- Staff ----------------
function StaffPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['staff'], queryFn: () => api<any[]>('/staff') });
  const { me } = useAuth();
  const outlets = useQuery({ queryKey: ['outlets'], queryFn: () => api<any>('/outlets') });
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'KITCHEN', restaurantId: '' });
  const [err, setErr] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff'] });
  const outletList: { id: string; name: string }[] = outlets.data?.outlets ?? [];
  const outletName = (id: string | null) => outletList.find((o) => o.id === id)?.name ?? '—';
  return (
    <Page>
      <Title>Staff</Title>
      <form className="card mb-4 grid gap-3 sm:grid-cols-4" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await api('/staff', { body: { ...f, restaurantId: f.restaurantId || me!.restaurant?.id } }); setF({ ...f, name: '', email: '', password: '' }); refresh(); toast('Staff member added'); } catch (x) { setErr(x); } }}>
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" error={(err as any)?.status === 409 ? errMsg(err) : fieldErrors(err, 'email')}><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Temporary password" error={fieldErrors(err, 'password')}><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="MANAGER">Manager</option><option value="KITCHEN">Kitchen</option><option value="WAITER">Waiter</option></select></Field>
        {outletList.length > 1 && <Field label="Works at outlet"><select className="input" value={f.restaurantId || me!.restaurant?.id} onChange={(e) => setF({ ...f, restaurantId: e.target.value })}>{outletList.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
        <div className="sm:col-span-4"><button className="btn-primary">Add staff member</button></div>
      </form>
      {isLoading ? <Skeleton /> : data!.map((u) => <div key={u.id} className="card mb-2 flex items-center justify-between"><div><p className="font-semibold">{u.name} <span className="text-xs text-stone-500">{u.role}</span></p><p className="text-sm text-stone-500">{u.email}{!u.active && ' · deactivated'}</p></div>
        {u.role !== 'OWNER' && outletList.length > 1 && <select className="input mr-2 w-auto py-1.5 text-xs" aria-label={`Outlet for ${u.name}`} value={u.restaurantId ?? ''} onChange={(e) => api(`/staff/${u.id}`, { method: 'PATCH', body: { restaurantId: e.target.value } }).then(() => { refresh(); toast(`${u.name} moved to ${outletName(e.target.value)}`); }).catch((x) => toast(errMsg(x), 'err'))}>{outletList.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        {u.role !== 'OWNER' && u.mfaEnabled && <button className="btn-ghost mr-2 px-3 py-1.5 text-xs" title="For a staff member who lost their phone" onClick={() => confirm(`Reset two-step verification for ${u.name}? They will be signed out and can set it up again.`) && api(`/staff/${u.id}/reset-mfa`, { body: {} }).then(() => { refresh(); toast('Two-step verification reset'); }).catch((x) => toast(errMsg(x), 'err'))}>Reset 2FA</button>}
        {u.role !== 'OWNER' && <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => api(`/staff/${u.id}`, { method: 'PATCH', body: { active: !u.active } }).then(refresh)}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}</div>)}
    </Page>
  );
}

// ---------------- Settings ----------------
function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: r, isLoading } = useRestaurant();
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (r) setF({ ...r, taxPercent: Number(r.taxPercent), serviceChargePercent: Number(r.serviceChargePercent) }); }, [r]);
  if (isLoading || !f) return <Skeleton className="h-64" />;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const toggleType = (t: string) => setF({ ...f, orderTypes: f.orderTypes.includes(t) ? f.orderTypes.filter((x: string) => x !== t) : [...f.orderTypes, t] });
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const { name, description, category, address, phone, whatsapp, currency, taxPercent, serviceChargePercent, deliveryFeeCents, minDeliveryCents, orderTypes, published, onlinePayments, bannerText, utcOffsetMinutes, openTime, closeTime, reservationSlotMinutes } = f;
    try { await api('/restaurant', { method: 'PUT', body: { name, description, category, address, phone, whatsapp, currency, taxPercent, serviceChargePercent, deliveryFeeCents, minDeliveryCents, orderTypes, published, onlinePayments, bannerText, utcOffsetMinutes, openTime, closeTime, reservationSlotMinutes } }); qc.invalidateQueries({ queryKey: ['restaurant'] }); toast('Settings saved'); } catch (x) { setErr(x); toast(errMsg(x), 'err'); }
  };
  return (
    <Page>
      <Title>Settings</Title>
      <form onSubmit={save} className="card grid gap-4 sm:grid-cols-2">
        <Field label="Restaurant name" error={fieldErrors(err, 'name')}><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Category"><input className="input" value={f.category} onChange={set('category')} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><textarea className="input" rows={2} value={f.description} onChange={set('description')} /></Field></div>
        <Field label="Address"><input className="input" value={f.address} onChange={set('address')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="WhatsApp number"><input className="input" value={f.whatsapp} onChange={set('whatsapp')} /></Field>
        <Field label="Currency (ISO code)" error={fieldErrors(err, 'currency')}><input className="input uppercase" maxLength={3} value={f.currency} onChange={set('currency')} /></Field>
        <Field label="Tax %"><input className="input" type="number" step="0.01" min={0} value={f.taxPercent} onChange={set('taxPercent')} /></Field>
        <Field label="Service charge %"><input className="input" type="number" step="0.01" min={0} value={f.serviceChargePercent} onChange={set('serviceChargePercent')} /></Field>
        <Field label="Delivery fee (minor units, e.g. paise)"><input className="input" type="number" min={0} value={f.deliveryFeeCents} onChange={set('deliveryFeeCents')} /></Field>
        <Field label="Delivery minimum (minor units)"><input className="input" type="number" min={0} value={f.minDeliveryCents} onChange={set('minDeliveryCents')} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Opens"><input className="input" type="time" value={f.openTime} onChange={set('openTime')} /></Field><Field label="Closes"><input className="input" type="time" value={f.closeTime} onChange={set('closeTime')} /></Field></div>
        <Field label="Promotional banner (shown on your storefront)"><input className="input" maxLength={160} value={f.bannerText ?? ''} onChange={set('bannerText')} placeholder="e.g. Happy hour 4–7pm: 20% off drinks" /></Field>
        <Field label="Restaurant clock (minutes from UTC, e.g. 330 for India)"><input className="input" type="number" step={15} min={-720} max={840} value={f.utcOffsetMinutes} onChange={set('utcOffsetMinutes')} /></Field>
        <Field label="Reservation length (minutes)"><input className="input" type="number" min={30} max={240} step={15} value={f.reservationSlotMinutes} onChange={set('reservationSlotMinutes')} /></Field>
        <div><p className="label">Order types</p><div className="flex gap-4 text-sm">{['DINE_IN', 'TAKEAWAY', 'DELIVERY'].map((t) => <label key={t}><input type="checkbox" className="mr-1.5" checked={f.orderTypes.includes(t)} onChange={() => toggleType(t)} />{t.replace('_', ' ').toLowerCase()}</label>)}</div></div>
        <label className="flex items-center gap-2 self-end rounded-xl bg-brand-50 p-3 text-sm font-semibold"><input type="checkbox" checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} />Published — storefront is live at /r/{f.slug}</label>
        <label className="flex items-center gap-2 rounded-xl bg-stone-100 p-3 text-sm font-semibold"><input type="checkbox" checked={f.onlinePayments} onChange={(e) => setF({ ...f, onlinePayments: e.target.checked })} />Offer online payment at checkout (connect your payment account below first)</label>
        <div className="sm:col-span-2"><button className="btn-primary">Save settings</button></div>
      </form>
      <PaymentsSettings onChanged={() => qc.invalidateQueries({ queryKey: ['restaurant'] })} />
    </Page>
  );
}

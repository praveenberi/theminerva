import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell, BarChart3, BookOpen, CalendarDays, ChefHat, ChevronsLeft, ClipboardList, CreditCard, FileText, LayoutDashboard, LogOut, Megaphone, Menu as MenuIcon,
  Moon, Package, QrCode, Settings, Sparkles, Sun, Users, UserCog,
} from 'lucide-react';
import { Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, statusLabel } from '@/lib/format';
import { toggleTheme } from '@/lib/theme';
import { useRealtime } from '@/lib/ws';
import { useOutletFilter } from '@/lib/outlet';

const NAV = [
  { to: '/admin', end: true, label: 'Dashboard', icon: LayoutDashboard, perm: ['reports.view'] },
  { to: '/admin/orders', label: 'Orders', icon: ClipboardList, perm: ['orders.view'] },
  { to: '/admin/kitchen', label: 'Kitchen display', icon: ChefHat, perm: ['kitchen.manage', 'orders.manage'] },
  { to: '/admin/menu', label: 'Menu', icon: BookOpen, perm: ['menu.manage'] },
  { to: '/admin/tables', label: 'Tables & QR', icon: QrCode, perm: ['tables.manage', 'orders.create'] },
  { to: '/admin/reservations', label: 'Reservations', icon: CalendarDays, perm: ['reservations.manage'] },
  { to: '/admin/customers', label: 'Customers', icon: Users, perm: ['customers.view'] },
  { to: '/admin/payments', label: 'Payments', icon: CreditCard, perm: ['payments.process', 'reports.view'] },
  { to: '/admin/inventory', label: 'Inventory', icon: Package, perm: ['inventory.manage'] },
  { to: '/admin/marketing', label: 'Marketing', icon: Megaphone, perm: ['marketing.manage'] },
  { to: '/admin/staff', label: 'Staff', icon: UserCog, perm: ['staff.manage'] },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, perm: ['reports.view'] },
  { to: '/admin/content', label: 'Website content', icon: FileText, perm: ['cms.manage'] },
  { to: '/admin/assistant', label: 'AI assistant', icon: Sparkles, perm: ['ai.use'] },
  { to: '/admin/settings', label: 'Settings', icon: Settings, perm: ['settings.manage'] },
];

let audioCtx: AudioContext | null = null;
export function beep() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* audio unavailable */ }
}
export const soundOn = () => { try { return localStorage.getItem('minerva-sound') !== 'off'; } catch { return true; } };

export default function AdminLayout() {
  const { user, ready, can, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('minerva-sidebar') === '1'; } catch { return false; } });
  const [mobile, setMobile] = useState(false);
  const [bell, setBell] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => setMobile(false), [loc.pathname]);
  useEffect(() => { try { localStorage.setItem('minerva-sidebar', collapsed ? '1' : '0'); } catch { /* ignore */ } }, [collapsed]);

  const branch = useOutletFilter();
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api('/api/restaurant/alerts'), enabled: user?.kind === 'staff', refetchInterval: 30_000 });
  useRealtime((type, p) => {
    if (type === 'order.new') { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['board'] }); if (soundOn()) beep(); toast('info', `New order #${p.number}`); }
    else if (type === 'order.updated') { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['board'] }); }
    else if (type === 'alert') { qc.invalidateQueries({ queryKey: ['alerts'] }); if (soundOn()) beep(); toast('info', p.message); }
    else if (type === 'reservation.new') qc.invalidateQueries({ queryKey: ['reservations'] });
    else if (type === 'table.updated') qc.invalidateQueries({ queryKey: ['tables'] });
    else if (type === 'payment.paid') { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['board'] }); }
  }, { staff: true });

  if (!ready) return <div className="p-8"><Skeleton className="h-10 w-48" /></div>;
  if (user?.kind !== 'staff') return <Navigate to="/admin/login" state={{ from: loc.pathname }} replace />;
  const items = NAV.filter((n) => n.perm.some((p) => can(p)));
  if (loc.pathname === '/admin' && !can('reports.view')) return <Navigate to={items[0]?.to ?? '/admin/orders'} replace />;
  const current = NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)));
  if (current && !current.perm.some((p) => can(p))) return <div className="p-10 text-center"><h1 className="text-3xl">No access</h1><p className="mt-2 text-muted">Your role ({statusLabel(user.role!)}) cannot open this page.</p></div>;
  const fullscreen = loc.pathname === '/admin/kitchen' && new URLSearchParams(loc.search).has('fs');

  const sidebar = (compact: boolean) => (
    <nav aria-label="Admin" className="flex h-full flex-col gap-1 p-3">
      <Link to="/admin" className="mb-3 flex items-center gap-2 px-2 font-display text-lg font-semibold">
        <img src="/logo-mark.png" alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
        {!compact && 'Minerva'}
      </Link>
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} title={compact ? n.label : undefined} className={({ isActive }) => cn('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors hover:bg-surface-2', isActive && 'bg-brand text-brand-fg hover:bg-brand', compact && 'justify-center px-0')}>
          <n.icon className="h-5 w-5 shrink-0" aria-hidden />{!compact && n.label}{compact && <span className="sr-only">{n.label}</span>}
        </NavLink>
      ))}
      <div className="mt-auto space-y-1 pt-3">
        <Link to="/" className={cn('block rounded-xl px-3 py-2 text-sm text-muted hover:bg-surface-2', compact && 'text-center')}>{compact ? '↗' : 'View website ↗'}</Link>
      </div>
    </nav>
  );

  if (fullscreen) return <div className="min-h-screen bg-bg"><Outlet /></div>;
  return (
    <div className="flex min-h-screen">
      <motion.aside animate={{ width: collapsed ? 68 : 240 }} transition={{ type: 'spring', damping: 28, stiffness: 300 }} className="sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface lg:block no-print">{sidebar(collapsed)}</motion.aside>
      <AnimatePresence>
        {mobile && (<div className="fixed inset-0 z-50 lg:hidden"><motion.div className="absolute inset-0 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobile(false)} />
          <motion.div initial={{ x: -260 }} animate={{ x: 0 }} exit={{ x: -260 }} className="absolute inset-y-0 left-0 w-64 bg-surface shadow-card">{sidebar(false)}</motion.div></div>)}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/90 px-3 backdrop-blur no-print">
          <button className="rounded-lg p-2 hover:bg-surface-2 lg:hidden" aria-label="Open navigation" onClick={() => setMobile(true)}><MenuIcon className="h-5 w-5" /></button>
          <button className="hidden rounded-lg p-2 hover:bg-surface-2 lg:block" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((c) => !c)}><ChevronsLeft className={cn('h-5 w-5 transition-transform', collapsed && 'rotate-180')} /></button>
          <h1 className="font-display text-lg">{current?.label ?? 'Admin'}</h1>
          <div className="ml-auto flex items-center gap-1">
            {branch.show && <select aria-label="Branch" value={branch.outletId} onChange={(e) => branch.set(e.target.value)} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm"><option value="">All branches</option>{branch.outlets.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
            <div className="relative">
              <button className="relative rounded-lg p-2 hover:bg-surface-2" aria-label={`Notifications, ${alerts.data?.unread ?? 0} unread`} onClick={() => setBell((b) => !b)}>
                <Bell className="h-5 w-5" />{!!alerts.data?.unread && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">{alerts.data.unread}</span>}
              </button>
              {bell && (
                <div className="absolute right-0 mt-2 w-80 rounded-2xl border border-border bg-surface p-2 shadow-card">
                  <div className="flex items-center justify-between px-2 py-1"><span className="text-sm font-medium">Alerts</span><button className="text-xs underline" onClick={async () => { await api('/api/restaurant/alerts/read', { body: {} }); qc.invalidateQueries({ queryKey: ['alerts'] }); }}>Mark all read</button></div>
                  <ul className="max-h-80 overflow-y-auto text-sm">{(alerts.data?.items ?? []).length === 0 ? <li className="p-3 text-muted">No alerts</li> : alerts.data.items.map((a: any) => <li key={a.id} className={cn('rounded-lg px-2 py-2', !a.readAt && 'bg-accent/10')}>{a.message}<span className="block text-xs text-muted">{new Date(a.createdAt).toLocaleString()}</span></li>)}</ul>
                </div>)}
            </div>
            <button className="rounded-lg p-2 hover:bg-surface-2" aria-label="Toggle dark mode" onClick={toggleTheme}><Sun className="hidden h-5 w-5 [[data-theme=dark]_&]:block" /><Moon className="h-5 w-5 [[data-theme=dark]_&]:hidden" /></button>
            <span className="hidden px-2 text-sm text-muted sm:inline">{user.name} · {statusLabel(user.role!)}</span>
            <button className="rounded-lg p-2 hover:bg-surface-2" aria-label="Sign out" onClick={async () => { await logout(); nav('/admin/login'); }}><LogOut className="h-5 w-5" /></button>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6"><AnimatePresence mode="wait"><motion.div key={loc.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}><Outlet /></motion.div></AnimatePresence></main>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Menu as MenuIcon, Minus, Moon, Plus, ShoppingBag, Sun, Trash2, User, X, MessageCircle } from 'lucide-react';
import { Button, Drawer } from '@/components/ui';
import { FoodImage } from '@/components/Food';
import { MyOrdersButton, MyOrdersDrawer } from '@/components/MyOrders';
import { useCart } from '@/lib/cart';
import { useAuth } from '@/lib/auth';
import { useHome, setLang, getLang } from '@/lib/hooks';
import { toggleTheme } from '@/lib/theme';
import { cn, money } from '@/lib/format';

const NAV = [['/menu', 'Menu'], ['/reservations', 'Reserve'], ['/events', 'Events'], ['/offers', 'Offers'], ['/gallery', 'Gallery'], ['/about', 'About'], ['/contact', 'Contact']] as const;

function useAnalytics(cfg?: { ga?: string; metaPixel?: string }) {
  const [consent, setConsent] = useState<string | null>(() => { try { return localStorage.getItem('minerva-analytics'); } catch { return null; } });
  useEffect(() => {
    if (consent !== 'yes' || !cfg) return;
    if (cfg.ga && /^G-[A-Z0-9]+$/.test(cfg.ga)) {
      const s = document.createElement('script'); s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${cfg.ga}`; document.head.appendChild(s);
      (window as any).dataLayer = (window as any).dataLayer || [];
      (window as any).gtag = function () { (window as any).dataLayer.push(arguments); };
      (window as any).gtag('js', new Date()); (window as any).gtag('config', cfg.ga, { anonymize_ip: true });
    }
    if (cfg.metaPixel && /^\d+$/.test(cfg.metaPixel)) {
      const s = document.createElement('script');
      s.textContent = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${cfg.metaPixel}');fbq('track','PageView');`;
      document.head.appendChild(s);
    }
  }, [consent, cfg?.ga, cfg?.metaPixel]);
  return { consent, choose: (v: 'yes' | 'no') => { try { localStorage.setItem('minerva-analytics', v); } catch { /* ignore */ } setConsent(v); } };
}

export default function PublicLayout() {
  const { data } = useHome();
  const r = data?.restaurant;
  const { count, state, dispatch } = useCart();
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const loc = useLocation();
  const analytics = useAnalytics(data?.config.analytics);
  useEffect(() => { setMenuOpen(false); window.scrollTo({ top: 0 }); }, [loc.pathname]);
  const wa = r?.whatsapp ? `https://wa.me/${r.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(data?.config.whatsappMessage ?? '')}` : null;

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-fg">Skip to content</a>
      <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/85 backdrop-blur no-print">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-display text-xl font-semibold" aria-label={`${r?.name ?? 'The Minerva'} home`}>
            <img src="/logo-mark.png" alt="" className="h-9 w-9 rounded-lg object-cover" />
            {r?.name ?? 'The Minerva'}
          </Link>
          <nav className="ml-6 hidden items-center gap-1 lg:flex" aria-label="Main">
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} className={({ isActive }) => cn('relative rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-2', isActive && 'text-brand')}>
                {({ isActive }) => (<>{label}{isActive && <motion.span layoutId="nav-underline" className="absolute inset-x-3 -bottom-px h-0.5 rounded bg-accent" />}</>)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {(data?.config.languages?.length ?? 0) > 1 && (
              <select aria-label="Language" defaultValue={getLang() ?? data?.config.defaultLanguage} onChange={(e) => { setLang(e.target.value); location.reload(); }} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm">
                {data!.config.languages.map((l: string) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
              </select>
            )}
            <button className="rounded-lg p-2 hover:bg-surface-2" aria-label="Toggle dark mode" onClick={toggleTheme}><Sun className="hidden h-5 w-5 [[data-theme=dark]_&]:block" /><Moon className="h-5 w-5 [[data-theme=dark]_&]:hidden" /></button>
            <MyOrdersButton onClick={() => setOrdersOpen(true)} />
            <Link to={user?.kind === 'customer' ? '/account' : '/login'} className="rounded-lg p-2 hover:bg-surface-2" aria-label={user?.kind === 'customer' ? 'My account' : 'Sign in'}><User className="h-5 w-5" /></Link>
            <button className="relative rounded-lg p-2 hover:bg-surface-2" aria-label={`Open cart, ${count} items`} onClick={() => dispatch({ t: 'open', open: true })}>
              <ShoppingBag className="h-5 w-5" />
              <AnimatePresence>{count > 0 && <motion.span key={count} initial={{ scale: 0.4 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-xs font-semibold text-accent-fg">{count}</motion.span>}</AnimatePresence>
            </button>
            <Button size="sm" className="ml-1 hidden sm:inline-flex" onClick={() => (location.href = '/menu')}>Order online</Button>
            <button className="rounded-lg p-2 hover:bg-surface-2 lg:hidden" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>{menuOpen ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}</button>
          </div>
        </div>
        <AnimatePresence>
          {menuOpen && (
            <motion.nav initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-border lg:hidden" aria-label="Mobile">
              <div className="mx-auto flex max-w-6xl flex-col px-4 py-2">
                {NAV.map(([to, label]) => <Link key={to} to={to} className="rounded-lg px-3 py-3 font-medium hover:bg-surface-2">{label}</Link>)}
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {state.tableLabel && (
        <div className="bg-brand px-4 py-2 text-center text-sm text-brand-fg">Ordering for <strong>table {state.tableLabel}</strong></div>
      )}

      <main id="main" className="flex-1"><PageTransition><Outlet /></PageTransition></main>
      <Footer r={r} />
      <CartDrawer />
      <MyOrdersDrawer open={ordersOpen} onClose={() => setOrdersOpen(false)} />
      {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="Chat on WhatsApp" className="fixed bottom-4 left-4 z-30 grid h-12 w-12 place-items-center rounded-full bg-[#25D366] text-white shadow-card no-print"><MessageCircle className="h-6 w-6" /></a>}
      {analytics.consent === null && (data?.config.analytics.ga || data?.config.analytics.metaPixel) && (
        <div role="dialog" aria-label="Cookie consent" className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-xl flex-col gap-3 rounded-2xl border border-border bg-surface p-4 text-sm shadow-card sm:flex-row sm:items-center">
          <p className="flex-1">We use analytics cookies to improve the site. Essential cookies (sign-in, cart) are always on. <Link to="/privacy" className="underline">Privacy policy</Link></p>
          <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => analytics.choose('no')}>Decline</Button><Button size="sm" onClick={() => analytics.choose('yes')}>Accept</Button></div>
        </div>
      )}
    </div>
  );
}

function PageTransition({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <motion.div key={pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>{children}</motion.div>;
}

function Footer({ r }: { r: any }) {
  const social = Object.entries((r?.social ?? {}) as Record<string, string>).filter(([, v]) => v);
  return (
    <footer className="border-t border-border bg-surface-2 no-print">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="font-display text-xl">{r?.name ?? 'The Minerva'}</p>
          {r?.tagline && <p className="mt-2 whitespace-pre-line text-sm text-muted">{r.tagline}</p>}
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            {social.map(([k, v]) => <a key={k} href={v} target="_blank" rel="noreferrer noopener" className="capitalize underline-offset-2 hover:underline">{k}</a>)}
          </div>
        </div>
        <div className="text-sm">
          <p className="mb-2 font-medium">Visit</p>
          {r?.address ? <p className="whitespace-pre-line text-muted">{r.address}</p> : <p className="text-muted">Address coming soon.</p>}
          {r?.phone && <p className="mt-1"><a href={`tel:${r.phone}`} className="hover:underline">{r.phone}</a></p>}
          {r?.email && <p><a href={`mailto:${r.email}`} className="hover:underline">{r.email}</a></p>}
        </div>
        <div className="text-sm">
          <p className="mb-2 font-medium">Explore</p>
          <ul className="space-y-1 text-muted">
            {[['/menu', 'Menu'], ['/reservations', 'Reserve a table'], ['/loyalty', 'Rewards'], ['/feedback', 'Feedback'], ['/admin/login', 'Staff sign-in']].map(([to, l]) => <li key={to}><Link to={to} className="hover:text-fg hover:underline">{l}</Link></li>)}
          </ul>
        </div>
        <div className="text-sm">
          <p className="mb-2 font-medium">Legal</p>
          <ul className="space-y-1 text-muted">
            {[['/privacy', 'Privacy policy'], ['/terms', 'Terms & conditions'], ['/refunds', 'Refund & cancellation']].map(([to, l]) => <li key={to}><Link to={to} className="hover:text-fg hover:underline">{l}</Link></li>)}
          </ul>
        </div>
      </div>
      <div className="border-t border-border py-4 text-center text-xs text-muted">© {new Date().getFullYear()} {r?.name ?? 'The Minerva'}. All rights reserved.</div>
    </footer>
  );
}

export function CartDrawer() {
  const { state, dispatch, subtotal, count } = useCart();
  const nav = useNavigate();
  return (
    <Drawer
      open={state.open} onClose={() => dispatch({ t: 'open', open: false })} title={`Your order${count ? ` (${count})` : ''}`}
      footer={state.lines.length > 0 && (
        <div className="space-y-3">
          <div className="flex justify-between font-medium"><span>Subtotal</span><span>{money(subtotal)}</span></div>
          <p className="text-xs text-muted">Tax, service charge and delivery are calculated at checkout.</p>
          <Button className="w-full" size="lg" onClick={() => { dispatch({ t: 'open', open: false }); nav('/checkout'); }}>Checkout</Button>
        </div>
      )}
    >
      {state.lines.length === 0 ? (
        <div className="py-16 text-center"><p className="font-display text-lg">Your cart is empty</p><p className="mt-1 text-sm text-muted">Add something delicious from the menu.</p><Button className="mt-4" onClick={() => { dispatch({ t: 'open', open: false }); nav('/menu'); }}>Browse the menu</Button></div>
      ) : (
        <ul className="space-y-4">
          <AnimatePresence initial={false}>
            {state.lines.map((l) => (
              <motion.li key={l.key} layout initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} className="flex gap-3">
                <FoodImage src={l.imageUrl} name={l.name} className="h-16 w-16 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-tight">{l.name}</p>
                  {(l.variantName || l.addonNames.length > 0) && <p className="text-xs text-muted">{[l.variantName, ...l.addonNames].filter(Boolean).join(' · ')}</p>}
                  {l.notes && <p className="text-xs italic text-muted">“{l.notes}”</p>}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-1 rounded-lg border border-border">
                      <button className="p-1.5" aria-label={`Decrease ${l.name}`} onClick={() => l.quantity > 1 ? dispatch({ t: 'qty', key: l.key, quantity: l.quantity - 1 }) : dispatch({ t: 'remove', key: l.key })}><Minus className="h-3.5 w-3.5" /></button>
                      <span className="w-6 text-center text-sm" aria-live="polite">{l.quantity}</span>
                      <button className="p-1.5" aria-label={`Increase ${l.name}`} onClick={() => dispatch({ t: 'qty', key: l.key, quantity: l.quantity + 1 })}><Plus className="h-3.5 w-3.5" /></button>
                    </div>
                    <span className="text-sm font-medium">{money(l.unitPrice * l.quantity)}</span>
                  </div>
                </div>
                <button className="self-start rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`Remove ${l.name}`} onClick={() => dispatch({ t: 'remove', key: l.key })}><Trash2 className="h-4 w-4" /></button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Drawer>
  );
}

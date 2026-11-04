import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AnimatePresence, motion } from 'motion/react';
import { ChefHat, ChevronDown, ClipboardList, CalendarCheck, QrCode, BarChart3, Tag, Users } from 'lucide-react';
import { api, errMsg, money, setToken, useAuth, type Me } from '../lib';
import { Field } from '../ui';

const features = [
  { icon: QrCode, title: 'QR table ordering', text: 'Every table gets its own QR code. Guests order and track from their phone, no app needed.' },
  { icon: ClipboardList, title: 'Live order board', text: 'Orders flow from new to completed on a kanban board your whole team can use.' },
  { icon: CalendarCheck, title: 'Reservations', text: 'Guests book online; double-booking is prevented at the database level.' },
  { icon: Tag, title: 'Coupons & offers', text: 'Percentage or fixed discounts with minimums, expiry and usage limits.' },
  { icon: Users, title: 'Customers & loyalty', text: 'Every order builds a customer profile and earns loyalty points automatically.' },
  { icon: BarChart3, title: 'Real analytics', text: 'Revenue, best-sellers and peak hours calculated from your actual orders.' },
];
const FEATURE_LABELS: Record<string, string> = {
  online_payments: 'Online payments', reservations: 'Table reservations', crm: 'Customer CRM', promotions: 'Promotions & coupons',
  loyalty: 'Loyalty & referrals', inventory: 'Inventory & recipes', marketing: 'Marketing campaigns', multi_outlet: 'Multiple outlets', advanced_reports: 'Advanced reports & exports',
};

/** Prices come from the plans table, so changing a plan in the admin portal changes this page. */
function Pricing() {
  const { data } = useQuery({ queryKey: ['public-plans'], queryFn: () => api<any[]>('/public/plans') });
  if (!data?.length) return null;
  return (
    <section className="mx-auto max-w-6xl px-4 pb-20" id="pricing">
      <h2 className="mb-2 text-center text-3xl font-extrabold">Simple pricing</h2>
      <p className="mb-8 text-center text-stone-600">Try everything free, then pick the plan that fits.</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.map((p, i) => (
          <motion.div key={p.code} className="card flex flex-col" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }}>
            <p className="font-bold">{p.name}</p>
            <p className="mt-1 text-3xl font-extrabold">{money(p.priceCents, p.currency)}<span className="text-sm font-normal text-stone-500"> / {p.intervalMonths === 1 ? 'month' : `${p.intervalMonths} months`}</span></p>
            <p className="mt-2 text-sm text-stone-600">{p.description}</p>
            <ul className="my-4 flex-1 space-y-1.5 text-sm">
              <li>{p.limits.maxOutlets == null ? 'Unlimited' : p.limits.maxOutlets} outlet{p.limits.maxOutlets === 1 ? '' : 's'}</li>
              <li>{p.limits.maxStaff == null ? 'Unlimited' : `Up to ${p.limits.maxStaff}`} staff accounts</li>
              <li>{p.limits.maxProducts == null ? 'Unlimited' : `Up to ${p.limits.maxProducts}`} menu items</li>
              {p.features.map((f: string) => <li key={f} className="flex items-center gap-1.5"><span className="text-green-600">✓</span>{FEATURE_LABELS[f] ?? f}</li>)}
            </ul>
            <Link to={`/register?plan=${p.code}`} className="btn-primary">{p.trialDays > 0 ? `Start ${p.trialDays}-day free trial` : 'Get started'}</Link>
          </motion.div>))}
      </div>
    </section>
  );
}

const faqs = [
  ['Do my customers need to install an app?', 'No. The storefront is a mobile web page opened from a QR code or link.'],
  ['How long does setup take?', 'Register, add a few menu items, tick “Published”, and print your QR code.'],
  ['Which payments are supported?', 'Cash at the restaurant or on delivery today. Online payment providers plug in through an adapter once you add provider credentials.'],
];

export function Landing() {
  const { me } = useAuth();
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <span className="flex items-center gap-2 text-xl font-extrabold"><ChefHat className="text-brand-500" /> Tablely</span>
        <nav className="flex items-center gap-2">
          <Link to="/r/the-minerva" className="btn-ghost hidden sm:inline-flex">Live demo</Link>
          {me ? <Link to={me.role === 'SUPER_ADMIN' ? '/admin' : '/app'} className="btn-primary">Open dashboard</Link>
            : <><Link to="/login" className="btn-ghost">Log in</Link><Link to="/register" className="btn-primary">Get started</Link></>}
        </nav>
      </header>
      <section className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-24">
        <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl">
          Your restaurant, online in minutes.
        </motion.h1>
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }} className="mx-auto mt-5 max-w-xl text-lg text-stone-600">
          Digital menu, QR ordering, reservations and analytics in one simple platform.
        </motion.p>
        <div className="mt-8 flex justify-center gap-3">
          <Link to="/register" className="btn-primary px-6 py-3">Create your storefront</Link>
          <Link to="/r/the-minerva" className="btn-ghost px-6 py-3">Try the demo menu</Link>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-16 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <motion.div key={f.title} className="card" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }} whileHover={{ y: -3 }}>
            <f.icon className="mb-3 text-brand-500" />
            <h3 className="font-bold">{f.title}</h3>
            <p className="mt-1 text-sm text-stone-600">{f.text}</p>
          </motion.div>
        ))}
      </section>
      <Pricing />
      <section className="mx-auto max-w-2xl px-4 pb-24">
        <h2 className="mb-4 text-center text-2xl font-bold">Questions</h2>
        {faqs.map(([q, a], i) => (
          <div key={q} className="border-b border-stone-200">
            <button className="flex w-full items-center justify-between py-4 text-left font-semibold" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              {q}<ChevronDown className={`transition ${open === i ? 'rotate-180' : ''}`} size={18} />
            </button>
            <AnimatePresence initial={false}>
              {open === i && <motion.p initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden pb-4 text-stone-600">{a}</motion.p>}
            </AnimatePresence>
          </div>
        ))}
      </section>
    </div>
  );
}

function AuthShell({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2 text-xl font-extrabold"><ChefHat className="text-brand-500" /> Tablely</Link>
        <div className="card p-7">
          <h1 className="mb-5 text-2xl font-bold">{title}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-stone-600">{footer}</p>
      </div>
    </div>
  );
}

function useSessionStart() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  return (d: any) => {
    setToken(d.accessToken);
    const me: Me = { ...d.user, restaurant: d.restaurant };
    setMe(me);
    nav(me.role === 'SUPER_ADMIN' ? '/admin' : ((loc.state as any)?.from ?? '/app'), { replace: true });
  };
}

const loginSchema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });

export function Login() {
  const start = useSessionStart();
  const [error, setError] = useState('');
  const [pass, setPass] = useState<string | null>(null); // set once the password was right and a second factor is needed
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(loginSchema) });

  const secondStep = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const d = await api<any>('/auth/login/mfa', { body: { mfaToken: pass, ...(useRecovery ? { recoveryCode: code } : { code }) } });
      if (useRecovery && d.recoveryCodesLeft <= 2) sessionStorage.setItem('lowRecovery', String(d.recoveryCodesLeft));
      start(d);
    } catch (x: any) {
      setError(errMsg(x));
      if (x?.code === 'mfa_expired') { setPass(null); setCode(''); }
    } finally { setBusy(false); }
  };

  if (pass) return (
    <AuthShell title="Two-step verification" footer={<button className="font-semibold text-brand-600" onClick={() => { setPass(null); setError(''); setCode(''); }}>Use a different account</button>}>
      <form className="space-y-4" onSubmit={secondStep}>
        <Field label={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}>
          <input className="input tracking-widest" inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" autoFocus maxLength={useRecovery ? 12 : 7} placeholder={useRecovery ? 'XXXXX-XXXXX' : '123456'} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || code.replace(/\s|-/g, '').length < (useRecovery ? 10 : 6)}>{busy ? 'Checking…' : 'Verify and log in'}</button>
        <button type="button" className="w-full text-sm font-semibold text-brand-600" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>{useRecovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}</button>
      </form>
    </AuthShell>
  );

  return (
    <AuthShell title="Welcome back" footer={<>New here? <Link className="font-semibold text-brand-600" to="/register">Create an account</Link></>}>
      <form className="space-y-4" onSubmit={handleSubmit(async (v) => {
        setError('');
        try {
          const d = await api<any>('/auth/login', { body: v });
          if (d.mfaRequired) { setPass(d.mfaToken); return; }
          start(d);
        } catch (e) { setError(errMsg(e)); }
      })}>
        <Field label="Email" error={errors.email?.message}><input className="input" type="email" autoComplete="email" {...register('email')} /></Field>
        <Field label="Password" error={errors.password?.message}><input className="input" type="password" autoComplete="current-password" {...register('password')} /></Field>
        <div className="-mt-2 text-right text-sm"><Link className="font-semibold text-brand-600" to="/forgot-password">Forgot password?</Link></div>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={isSubmitting}>{isSubmitting ? 'Signing in…' : 'Log in'}</button>
      </form>
    </AuthShell>
  );
}

const regSchema = z.object({
  restaurantName: z.string().trim().min(2, 'Enter your restaurant name'),
  name: z.string().trim().min(2, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(10, 'Use at least 10 characters').max(72, 'Use at most 72 characters'),
});

export function Register() {
  const start = useSessionStart();
  const [sp] = useSearchParams();
  const planCode = sp.get('plan') ?? undefined;
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(regSchema) });
  return (
    <AuthShell title={planCode ? `Start your ${planCode.toLowerCase()} trial` : 'Create your restaurant'} footer={<>Already registered? <Link className="font-semibold text-brand-600" to="/login">Log in</Link></>}>
      <form className="space-y-4" onSubmit={handleSubmit(async (v) => { setError(''); try { start(await api('/auth/register', { body: { ...v, planCode } })); } catch (e) { setError(errMsg(e)); } })}>
        <Field label="Restaurant name" error={errors.restaurantName?.message}><input className="input" {...register('restaurantName')} /></Field>
        <Field label="Your name" error={errors.name?.message}><input className="input" autoComplete="name" {...register('name')} /></Field>
        <Field label="Email" error={errors.email?.message}><input className="input" type="email" autoComplete="email" {...register('email')} /></Field>
        <Field label="Password" error={errors.password?.message}><input className="input" type="password" autoComplete="new-password" {...register('password')} /></Field>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={isSubmitting}>{isSubmitting ? 'Creating…' : 'Create account'}</button>
      </form>
    </AuthShell>
  );
}

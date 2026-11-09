import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Card, ErrorState, Field, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useSeo } from '@/lib/hooks';

const loginSchema = z.object({ email: z.string().trim().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });
const regSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name'), email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number').or(z.literal('')),
  password: z.string().min(10, 'Use at least 10 characters').regex(/[a-z]/, 'Include a lowercase letter').regex(/[A-Z]/, 'Include an uppercase letter').regex(/\d/, 'Include a number'),
  referralCode: z.string().optional(), marketingConsent: z.boolean(),
});

export default function Auth({ mode }: { mode: 'login' | 'register' }) {
  useSeo(mode === 'login' ? 'Sign in' : 'Create account');
  const { user, login, register: signUp } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<unknown>(null);
  const dest = (loc.state as any)?.from ?? '/account';
  const lf = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  const rf = useForm<z.infer<typeof regSchema>>({ resolver: zodResolver(regSchema), defaultValues: { marketingConsent: false } });
  if (user?.kind === 'customer') return <Navigate to="/account" replace />;

  const isLogin = mode === 'login';
  const onLogin = lf.handleSubmit(async (v) => {
    setError(null);
    try { const u = await login(v.email, v.password); nav(u.kind === 'staff' ? '/admin' : dest, { replace: true }); } catch (e) { setError(e); }
  });
  const onReg = rf.handleSubmit(async (v) => {
    setError(null);
    try { await signUp({ ...v, phone: v.phone || undefined, referralCode: v.referralCode || undefined }); nav(dest, { replace: true }); } catch (e) { setError(e); }
  });
  const le = lf.formState.errors, re = rf.formState.errors;

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <h1 className="text-4xl">{isLogin ? 'Welcome back' : 'Join The Minerva'}</h1>
      <p className="mt-1 text-muted">{isLogin ? 'Sign in to track orders and use your rewards.' : 'Earn points and check out faster.'}</p>
      <Card className="mt-6 p-5">
        {!!error && <div className="mb-4"><ErrorState error={error} /></div>}
        {isLogin ? (
          <form onSubmit={onLogin} className="space-y-4" noValidate>
            <Field label="Email" error={le.email?.message}>{(id) => <Input id={id} type="email" autoComplete="email" {...lf.register('email')} />}</Field>
            <Field label="Password" error={le.password?.message}>{(id) => <Input id={id} type="password" autoComplete="current-password" {...lf.register('password')} />}</Field>
            <Button className="w-full" loading={lf.formState.isSubmitting}>Sign in</Button>
            <p className="text-center text-sm text-muted">New here? <Link to="/register" className="underline">Create an account</Link></p>
          </form>
        ) : (
          <form onSubmit={onReg} className="space-y-4" noValidate>
            <Field label="Full name" error={re.name?.message}>{(id) => <Input id={id} autoComplete="name" {...rf.register('name')} />}</Field>
            <Field label="Email" error={re.email?.message}>{(id) => <Input id={id} type="email" autoComplete="email" {...rf.register('email')} />}</Field>
            <Field label="Mobile (optional)" error={re.phone?.message}>{(id) => <Input id={id} type="tel" autoComplete="tel" {...rf.register('phone')} />}</Field>
            <Field label="Password" error={re.password?.message} hint="10+ characters with upper, lower case and a number">{(id) => <Input id={id} type="password" autoComplete="new-password" {...rf.register('password')} />}</Field>
            <Field label="Referral code (optional)">{(id) => <Input id={id} {...rf.register('referralCode')} />}</Field>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" {...rf.register('marketingConsent')} /> <span>Yes, send me offers and news. I can opt out any time.</span></label>
            <p className="text-xs text-muted">By creating an account you agree to our <Link to="/terms" className="underline">terms</Link> and <Link to="/privacy" className="underline">privacy policy</Link>.</p>
            <Button className="w-full" loading={rf.formState.isSubmitting}>Create account</Button>
            <p className="text-center text-sm text-muted">Already a member? <Link to="/login" className="underline">Sign in</Link></p>
          </form>
        )}
      </Card>
    </div>
  );
}

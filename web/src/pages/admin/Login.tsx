import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { Button, Card, ErrorState, Field, Input, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSeo } from '@/lib/hooks';

const schema = z.object({ email: z.string().trim().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });

export default function AdminLogin() {
  useSeo('Staff sign-in');
  const { user, login } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [forgot, setForgot] = useState(false);
  const f = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const reset = useMutation({ mutationFn: (email: string) => api('/api/auth/forgot-password', { body: { email } }), onSuccess: (r) => toast('success', r.message), onError: (e) => toast('error', errorMessage(e)) });
  if (user?.kind === 'staff') return <Navigate to="/admin" replace />;
  return (
    <div className="grid min-h-screen place-items-center bg-brand px-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-3xl">Staff sign-in</h1>
        <p className="mb-5 text-sm text-muted">The Minerva management</p>
        {!!error && <div className="mb-4"><ErrorState error={error} /></div>}
        <form className="space-y-4" noValidate onSubmit={f.handleSubmit(async (v) => { setError(null); try { const u = await login(v.email, v.password); if (u.kind !== 'staff') { setError(new Error('This account is not a staff account.')); return; } nav('/admin'); } catch (e) { setError(e); } })}>
          <Field label="Email" error={f.formState.errors.email?.message}>{(id) => <Input id={id} type="email" autoComplete="username" {...f.register('email')} />}</Field>
          <Field label="Password" error={f.formState.errors.password?.message}>{(id) => <Input id={id} type="password" autoComplete="current-password" {...f.register('password')} />}</Field>
          <Button className="w-full" loading={f.formState.isSubmitting}>Sign in</Button>
        </form>
        <button className="mt-4 text-sm underline" onClick={() => setForgot(!forgot)}>Forgot password?</button>
        {forgot && <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); reset.mutate(f.getValues('email')); }}><Button variant="outline" size="sm" loading={reset.isPending}>Email me a reset link</Button></form>}
        <Link to="/" className="mt-4 block text-center text-sm text-muted hover:underline">← Back to website</Link>
      </Card>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthCtx, api, refreshSession, setToken, type Me } from './lib';
import { ToastProvider } from './ui';
import { Landing, Login, Register } from './pages/public';
import { Dashboard } from './pages/dashboard';
import { Storefront, TestPay, Track } from './pages/storefront';
import { AdminPage } from './pages/admin';
import { ForgotPassword, ResetPassword, VerifyEmail } from './pages/recovery';
import './index.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function Protected({ children, roles }: { children: React.ReactNode; roles?: Me['role'][] }) {
  const { me } = React.useContext(AuthCtx);
  const loc = useLocation();
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (roles && !roles.includes(me.role)) return <Navigate to={me.role === 'SUPER_ADMIN' ? '/admin' : '/app'} replace />;
  return <>{children}</>;
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { refreshSession().then((m) => { setMe(m); setReady(true); }); }, []);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setToken(null); setMe(null); qc.clear(); };
  if (!ready) return <div className="grid min-h-screen place-items-center text-stone-500">Loading…</div>;
  return (
    <AuthCtx.Provider value={{ me, setMe, logout }}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/r/:slug" element={<Storefront />} />
        <Route path="/track/:code" element={<Track />} />
        <Route path="/pay/test/:id" element={<TestPay />} />
        <Route path="/app/*" element={<Protected roles={['OWNER', 'MANAGER', 'KITCHEN', 'WAITER']}><Dashboard /></Protected>} />
        <Route path="/admin" element={<Protected roles={['SUPER_ADMIN']}><AdminPage /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter><App /></BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, bindSession, refreshSession, setAccessToken, type SessionUser } from './api';

interface AuthCtx {
  user: SessionUser | null; ready: boolean;
  login(email: string, password: string): Promise<SessionUser>;
  register(data: Record<string, unknown>): Promise<SessionUser>;
  logout(): Promise<void>;
  can(perm: string): boolean;
}
const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { bindSession(setUser); refreshSession().finally(() => setReady(true)); }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api('/api/auth/login', { body: { email, password } });
    setAccessToken(r.accessToken); setUser(r.user); return r.user as SessionUser;
  }, []);
  const register = useCallback(async (data: Record<string, unknown>) => {
    const r = await api('/api/auth/register', { body: data });
    setAccessToken(r.accessToken); setUser(r.user); return r.user as SessionUser;
  }, []);
  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    setAccessToken(null); setUser(null);
  }, []);
  const can = useCallback((p: string) => !!user?.permissions?.includes(p), [user]);
  const value = useMemo(() => ({ user, ready, login, register, logout, can }), [user, ready, login, register, logout, can]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, string>) { super(message); }
}

let accessToken: string | null = null;
let onSession: ((u: SessionUser | null) => void) | null = null;
const HINT = 'minerva-session';
const hasHint = () => { try { return localStorage.getItem(HINT) === '1'; } catch { return false; } };
export const setAccessToken = (t: string | null) => {
  accessToken = t;
  try { t ? localStorage.setItem(HINT, '1') : localStorage.removeItem(HINT); } catch { /* storage unavailable */ }
};
export const getAccessToken = () => accessToken;
export const bindSession = (fn: (u: SessionUser | null) => void) => { onSession = fn; };

export interface SessionUser { kind: 'staff' | 'customer'; id: string; name: string; email?: string | null; role?: string; permissions?: string[] }

let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  // avoids a pointless 401 for anonymous visitors: only try when a session was previously established in this browser
  if (!hasHint()) return Promise.resolve(false);
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'minerva' } })
    .then(async (r) => {
      if (!r.ok) { setAccessToken(null); onSession?.(null); return false; }
      const j = await r.json();
      setAccessToken(j.accessToken); onSession?.(j.user); return true;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

type Opts = { method?: string; body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> };

export async function api<T = any>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), credentials: 'include', headers,
      body: opts.body instanceof FormData ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) return api<T>(path, opts, false);
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  return (data ?? (undefined as unknown)) as T;
}

/** Download a protected file (CSV/PDF/PNG…) with the bearer token. */
export async function download(path: string, filename: string, query?: Record<string, unknown>) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}, credentials: 'include' });
  if (!r.ok) throw new ApiError(r.status, 'DOWNLOAD', (await r.json().catch(() => null))?.error?.message ?? 'Download failed');
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

import { createContext, useContext } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string, public details?: Record<string, string[]>) {
    super(message);
  }
}

let accessToken: string | null = null;
export const setToken = (t: string | null) => { accessToken = t; };
export const getToken = () => accessToken;

let refreshing: Promise<Me | null> | null = null;
/** Exchanges the httpOnly refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<Me | null> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return null;
      const d = await r.json();
      setToken(d.accessToken);
      return { ...d.user, restaurant: d.restaurant } as Me;
    })
    .catch(() => null)
    .finally(() => { setTimeout(() => (refreshing = null), 0); });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    credentials: 'include',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && accessToken && opts.retry !== false && !path.startsWith('/auth/')) {
    if (await refreshSession()) return api<T>(path, { ...opts, retry: false });
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? 'Request failed', data?.error?.code ?? 'error', data?.error?.details);
  return data as T;
}

export interface Me { id: string; name: string; email: string; role: 'SUPER_ADMIN' | 'OWNER' | 'MANAGER' | 'KITCHEN' | 'WAITER'; restaurant?: { id: string; slug: string; name: string } | null }
export const AuthCtx = createContext<{ me: Me | null; setMe: (m: Me | null) => void; logout: () => Promise<void> }>(null as any);
export const useAuth = () => useContext(AuthCtx);

export const money = (cents: number, currency = 'INR') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

export const fieldErrors = (e: unknown, field: string) => (e instanceof ApiError ? e.details?.[field]?.[0] : undefined);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** Only follow http(s) links or same-site paths handed back by the server; never javascript:, data: and friends. */
export function safeRedirect(url: string): boolean {
  if (!/^(https?:\/\/|\/(?![\\/]))/i.test(url)) return false;
  window.location.assign(url);
  return true;
}
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Downloads a file the API generates (it needs the Authorization header, so a plain link will not do). */
export async function download(path: string): Promise<string> {
  const go = () => fetch(`/api${path}`, { credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  let res = await go();
  if (res.status === 401 && accessToken && (await refreshSession())) res = await go();
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new ApiError(res.status, d?.error?.message ?? 'Download failed', d?.error?.code ?? 'error', d?.error?.details);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** Shrinks a photo in the browser (phone pictures are several MB) to at most `max` pixels on the long side, as a JPEG. */
export async function shrinkImage(file: File, max = 900, quality = 0.85): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP picture');
  if (file.size > 20_000_000) throw new Error('That picture is too large (limit 20 MB)');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('This picture could not be read'); });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // transparent PNGs get a white background
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('This picture could not be prepared'))), 'image/jpeg', quality));
}

/** Uploads a (shrunk) picture and returns the address to store on the menu item. */
export async function uploadImage(blob: Blob): Promise<string> {
  const go = () => fetch('/api/images', { method: 'POST', credentials: 'include', headers: { 'Content-Type': blob.type, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: blob });
  let res = await go();
  if (res.status === 401 && accessToken && (await refreshSession())) res = await go();
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? 'Upload failed', data?.error?.code ?? 'error');
  return data.url as string;
}

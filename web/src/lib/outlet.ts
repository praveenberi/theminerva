import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

const KEY = 'minerva-admin-outlet';
const EVT = 'minerva-outlet-change';

/** Admin-side branch filter. Hidden (show=false) when there is only one branch or the account is pinned to a branch. */
export function useOutletFilter() {
  const q = useQuery({ queryKey: ['outlets'], queryFn: () => api('/api/outlets'), staleTime: 60_000 });
  const read = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
  const [outletId, setId] = useState(read);
  useEffect(() => { const h = () => setId(read()); window.addEventListener(EVT, h); return () => window.removeEventListener(EVT, h); }, []);
  const set = useCallback((v: string) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* ignore */ } window.dispatchEvent(new Event(EVT)); }, []);
  const outlets: any[] = (q.data ?? []).filter((o: any) => o.isActive);
  const valid = outlets.some((o) => o.id === outletId) ? outletId : '';
  return { outlets, all: q.data ?? [], outletId: valid, set, show: outlets.length > 1 };
}

/** Public-site branches (empty array = single-branch site). */
export function usePublicOutlets() {
  return useQuery({ queryKey: ['public-outlets'], queryFn: () => api('/api/public/outlets'), staleTime: 60_000 });
}

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { setLocaleConfig } from './format';

export const getLang = () => { try { return localStorage.getItem('minerva-lang') || undefined; } catch { return undefined; } };
export const setLang = (l: string) => { try { localStorage.setItem('minerva-lang', l); } catch { /* ignore */ } };

export function useHome() {
  const lang = getLang();
  const q = useQuery({ queryKey: ['home', lang], queryFn: () => api('/api/public/home', { query: { lang } }), staleTime: 60_000 });
  useEffect(() => { if (q.data?.restaurant) setLocaleConfig(q.data.restaurant); }, [q.data]);
  return q;
}
export function useMenu(outletId?: string) {
  const lang = getLang();
  return useQuery({ queryKey: ['menu', lang, outletId], queryFn: () => api('/api/public/menu', { query: { lang, outletId } }), staleTime: 30_000 });
}

/** Sets <title>, description, canonical, OG tags. */
export function useSeo(title: string, description?: string, image?: string) {
  useEffect(() => {
    const full = title.includes('Minerva') ? title : `${title} · The Minerva`;
    document.title = full;
    const set = (sel: string, attr: string, val: string, create: () => HTMLElement) => {
      let el = document.head.querySelector<HTMLElement>(sel);
      if (!el) { el = create(); document.head.appendChild(el); }
      el.setAttribute(attr, val);
    };
    const meta = (name: string, content: string, prop = false) =>
      set(`meta[${prop ? 'property' : 'name'}="${name}"]`, 'content', content, () => { const m = document.createElement('meta'); m.setAttribute(prop ? 'property' : 'name', name); return m; });
    if (description) { meta('description', description); meta('og:description', description, true); }
    meta('og:title', full, true); meta('og:type', 'restaurant.restaurant', true);
    if (image) meta('og:image', image, true);
    set('link[rel="canonical"]', 'href', location.origin + location.pathname, () => { const l = document.createElement('link'); l.rel = 'canonical'; return l; });
  }, [title, description, image]);
}

export function useJsonLd(id: string, data: object | null) {
  useEffect(() => {
    if (!data) return;
    let el = document.getElementById(id) as HTMLScriptElement | null;
    if (!el) { el = document.createElement('script'); el.id = id; el.type = 'application/ld+json'; document.head.appendChild(el); }
    el.textContent = JSON.stringify(data);
    return () => { el?.remove(); };
  }, [id, data]);
}

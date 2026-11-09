import { useEffect, useRef } from 'react';
import { getAccessToken } from './api';

/** Subscribe to realtime events. Reconnects with backoff; callers should also poll as a safety net. */
export function useRealtime(onEvent: (type: string, payload: any) => void, opts: { track?: string | string[]; staff?: boolean } = {}) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams();
      if (opts.staff && getAccessToken()) q.set('token', getAccessToken()!);
      const tr = Array.isArray(opts.track) ? opts.track.join(',') : opts.track;
      if (tr) q.set('track', tr);
      ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
      ws.onopen = () => { retry = 1000; };
      ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type !== 'hello') cb.current(m.type, m.payload); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) timer = setTimeout(connect, (retry = Math.min(retry * 2, 15000))); };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [Array.isArray(opts.track) ? opts.track.join(',') : opts.track, opts.staff]);
}

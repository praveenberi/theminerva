import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';

/** topics: "staff" (authenticated staff), "order:<trackingToken>" (public tracking) */
type Client = WebSocket & { topics?: Set<string> };
let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws: Client, req) => {
    ws.topics = new Set();
    const url = new URL(req.url ?? '', 'http://x');
    const token = url.searchParams.get('token');
    const track = url.searchParams.get('track');
    if (token) {
      try {
        const p = jwt.verify(token, config.JWT_ACCESS_SECRET) as any;
        if (p.kind === 'staff') {
          const u = await prisma.user.findUnique({ where: { id: p.id } });
          if (u?.isActive) ws.topics.add('staff');
        }
      } catch { /* ignore */ }
    }
    if (track) for (const t of track.split(',').slice(0, 30)) ws.topics.add(`order:${t}`);
    ws.send(JSON.stringify({ type: 'hello', topics: [...ws.topics] }));
    ws.on('error', () => {});
  });
}

export function broadcast(topic: string, type: string, payload: unknown = {}) {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload });
  for (const c of wss.clients as Set<Client>) {
    if (c.readyState === WebSocket.OPEN && c.topics?.has(topic)) c.send(msg);
  }
}

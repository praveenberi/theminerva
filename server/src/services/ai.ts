import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { ApiError } from '../lib/http.js';
import { can, type Permission } from '../lib/permissions.js';
import type { Role } from '@prisma/client';
import { dashboard, resolveRange, runReport } from './reports.js';

export const aiConfigured = () => !!config.ANTHROPIC_API_KEY;

async function callClaude(body: Record<string, unknown>) {
  if (!config.ANTHROPIC_API_KEY) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'The AI provider is not configured. Set ANTHROPIC_API_KEY on the server to enable AI features.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ANTHROPIC_MODEL, max_tokens: 1200, ...body }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(502, 'PROVIDER_ERROR', j?.error?.message ?? `AI provider error ${r.status}`);
  return j;
}

/** One-shot text generation (descriptions, translations, marketing copy…). */
export async function generate(system: string, user: string, maxTokens = 600) {
  const j = await callClaude({ system, max_tokens: maxTokens, messages: [{ role: 'user', content: user }] });
  return (j.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

interface ToolDef { name: string; description: string; perm: Permission; input: Record<string, unknown>; run: (a: any) => Promise<unknown> }

const rangeSchema = { type: 'object', properties: { range: { type: 'string', enum: ['today', 'yesterday', 'last7', 'last30', 'this_month', 'prev_month'] } }, required: ['range'] };

const TOOLS: ToolDef[] = [
  {
    name: 'sales_summary', perm: 'reports.view', description: 'Revenue, order counts, average order value, payment and trend data for a date range, straight from the database.',
    input: rangeSchema,
    run: async (a) => { const r = await resolveRange(a.range ?? 'today'); const d = await dashboard(r.from, r.to, r.tz); return { range: a.range, kpis: d.kpis, revenueTrend: d.revenueTrend, payments: d.payments }; },
  },
  {
    name: 'top_dishes', perm: 'reports.view', description: 'Best-selling dishes by quantity and revenue for a date range.', input: rangeSchema,
    run: async (a) => { const r = await resolveRange(a.range ?? 'last30'); return (await runReport('popular-items', r.from, r.to, r.tz)).rows.slice(0, 15); },
  },
  {
    name: 'peak_hours', perm: 'reports.view', description: 'Orders and revenue by hour of day (restaurant local time).', input: rangeSchema,
    run: async (a) => { const r = await resolveRange(a.range ?? 'last30'); return (await runReport('peak-hours', r.from, r.to, r.tz)).rows; },
  },
  {
    name: 'low_stock', perm: 'inventory.manage', description: 'Ingredients at or below their reorder level.', input: { type: 'object', properties: {} },
    run: async () => prisma.$queryRaw`SELECT name, unit, stock::float, "reorderLevel"::float FROM "Ingredient" WHERE "reorderLevel" > 0 AND stock <= "reorderLevel" ORDER BY name`,
  },
  {
    name: 'inactive_customers', perm: 'customers.view', description: 'Customers who ordered before but not in the last N days (default 60). Names only, no contact details.',
    input: { type: 'object', properties: { days: { type: 'number' } } },
    run: async (a) => prisma.customer.findMany({ where: { lastOrderAt: { lt: new Date(Date.now() - (Number(a.days) || 60) * 864e5) } }, select: { name: true, lastOrderAt: true, tier: true }, orderBy: { lastOrderAt: 'desc' }, take: 25 }),
  },
  {
    name: 'customer_feedback', perm: 'reports.view', description: 'Recent customer reviews and ratings (to find common complaints).', input: { type: 'object', properties: {} },
    run: async () => ({
      average: (await prisma.review.aggregate({ _avg: { rating: true }, _count: true })),
      lowRated: await prisma.review.findMany({ where: { rating: { lte: 3 }, comment: { not: null } }, orderBy: { createdAt: 'desc' }, take: 25, select: { rating: true, comment: true, createdAt: true } }),
    }),
  },
  {
    name: 'menu_performance', perm: 'reports.view', description: 'Revenue by category and by product to help decide what to promote.', input: rangeSchema,
    run: async (a) => { const r = await resolveRange(a.range ?? 'last30'); return { byCategory: (await runReport('revenue-by-category', r.from, r.to, r.tz)).rows, byProduct: (await runReport('revenue-by-product', r.from, r.to, r.tz)).rows.slice(0, 20) }; },
  },
];

const SYSTEM = `You are the operations assistant for The Minerva, a single restaurant. Answer ONLY from data returned by your tools. If a tool returns nothing or you lack the right tool, say you do not have that data — never guess or invent numbers, dishes, customers or dates. Quote figures exactly as returned. Be concise and practical; suggest actions only when supported by the data you retrieved.`;

export async function assistant(role: Role, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const tools = TOOLS.filter((t) => can(role, t.perm));
  const messages: any[] = history.map((m) => ({ role: m.role, content: m.content }));
  const used: string[] = [];
  for (let i = 0; i < 6; i++) {
    const j = await callClaude({
      system: SYSTEM,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input })),
    });
    messages.push({ role: 'assistant', content: j.content });
    const calls = (j.content as any[]).filter((b) => b.type === 'tool_use');
    if (!calls.length || j.stop_reason !== 'tool_use') {
      return { answer: (j.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim(), toolsUsed: used };
    }
    const results = [];
    for (const c of calls) {
      const tool = tools.find((t) => t.name === c.name);
      used.push(c.name);
      let out: unknown;
      try { out = tool ? await tool.run(c.input ?? {}) : { error: 'You are not permitted to access that data.' }; }
      catch (e: any) { out = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'I could not complete that request.', toolsUsed: used };
}

void Prisma;

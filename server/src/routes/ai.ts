import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { notFound, parse, wrap } from '../lib/http.js';
import { aiConfigured, assistant, generate } from '../services/ai.js';
import { audit } from '../lib/audit.js';

export const aiRouter = Router();
const limiter = rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false });
aiRouter.use(attachAuth, requirePerm('ai.use'), limiter);

aiRouter.get('/status', wrap(async (_req, res) => { res.json({ configured: aiConfigured() }); }));

aiRouter.post('/chat', wrap(async (req, res) => {
  const b = parse(z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(20) }), req.body);
  const out = await assistant(req.staff!.role, b.messages);
  await audit(req, 'ai.chat', 'AI', undefined, { tools: out.toolsUsed });
  res.json(out);
}));

const SYS = 'You write for The Minerva, a restaurant. Be accurate; never invent ingredients, allergens, prices, awards or facts that were not provided. Output only the requested text.';

aiRouter.post('/describe-product', wrap(async (req, res) => {
  const { productId, tone } = parse(z.object({ productId: z.string(), tone: z.string().max(40).default('warm and appetising') }), req.body);
  const p = await prisma.product.findUnique({ where: { id: productId }, include: { recipe: { include: { ingredient: true } }, category: true } });
  if (!p) throw notFound('Product');
  const facts = `Dish: ${p.name}\nCategory: ${p.category.name}\nVegetarian: ${p.isVegetarian}\nVegan: ${p.isVegan}\nAllergens: ${p.allergens.join(', ') || 'none listed'}\nIngredients: ${p.recipe.map((r) => r.ingredient.name).join(', ') || 'not specified'}\nCurrent description: ${p.description ?? '-'}`;
  res.json({ text: await generate(SYS, `Write a ${tone} menu description of 25–40 words using only these facts:\n${facts}`, 200) });
}));

aiRouter.post('/translate', wrap(async (req, res) => {
  const b = parse(z.object({ language: z.string().min(2).max(40), name: z.string().max(120), description: z.string().max(2000).optional() }), req.body);
  const text = await generate('Translate restaurant menu text. Return JSON only: {"name":"...","description":"..."}', JSON.stringify({ target: b.language, name: b.name, description: b.description ?? '' }), 400);
  try { res.json(JSON.parse(text.replace(/^```json|```$/g, '').trim())); } catch { res.json({ name: b.name, description: text }); }
}));

aiRouter.post('/marketing', wrap(async (req, res) => {
  const b = parse(z.object({ goal: z.string().min(3).max(300), channel: z.enum(['EMAIL', 'WHATSAPP', 'SOCIAL']).default('EMAIL'), offer: z.string().max(200).optional() }), req.body);
  res.json({ text: await generate(SYS, `Write a short ${b.channel} marketing message. Goal: ${b.goal}. ${b.offer ? `Offer (use exactly): ${b.offer}.` : 'Do not invent any discount.'} Use {{name}} as the customer's name placeholder.`, 400) });
}));

aiRouter.post('/upsell', wrap(async (req, res) => {
  const { productId } = parse(z.object({ productId: z.string() }), req.body);
  // grounded in real co-purchase data, AI only phrases it
  const rows = await prisma.$queryRaw<Array<{ name: string; n: bigint }>>`SELECT b.name, COUNT(*) n FROM "OrderItem" a JOIN "OrderItem" b ON a."orderId"=b."orderId" AND a."productId"<>b."productId" WHERE a."productId"=${productId} GROUP BY b.name ORDER BY n DESC LIMIT 5`;
  const pairs = rows.map((r) => ({ name: r.name, orders: Number(r.n) }));
  res.json({ pairs, text: pairs.length && aiConfigured() ? await generate(SYS, `Suggest a one-sentence upsell prompt for staff, based only on these items frequently ordered together: ${JSON.stringify(pairs)}`, 150) : undefined });
}));

aiRouter.post('/feedback-analysis', wrap(async (_req, res) => {
  const rs = await prisma.review.findMany({ orderBy: { createdAt: 'desc' }, take: 60, where: { comment: { not: null } }, select: { rating: true, comment: true } });
  if (!rs.length) return res.json({ text: 'There is no written feedback to analyse yet.' });
  res.json({ text: await generate(SYS, `Summarise recurring themes (praise and complaints) from these reviews, with counts where possible. Do not invent themes:\n${JSON.stringify(rs)}`, 600) });
}));

aiRouter.post('/performance-summary', wrap(async (req, res) => {
  const out = await assistant(req.staff!.role, [{ role: 'user', content: 'Using the tools, give a short performance summary for the last 7 days: revenue, orders, best sellers, peak hours, and any low stock. Only report what the data shows.' }]);
  res.json(out);
}));

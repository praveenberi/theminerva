import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, ZodTypeAny, z } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', msg, details);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (msg: string) => new ApiError(409, 'CONFLICT', msg);
export const forbidden = (msg = 'You do not have permission to do this') => new ApiError(403, 'FORBIDDEN', msg);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', msg);

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Parse + validate with zod; throws structured 422. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw zodToApi(r.error);
  return r.data;
}
export function zodToApi(e: ZodError) {
  const fields: Record<string, string> = {};
  for (const i of e.issues) fields[i.path.join('.') || '_'] ??= i.message;
  const first = e.issues[0];
  return new ApiError(422, 'VALIDATION_ERROR', first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', fields);
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().optional(),
});

export function paginate(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}
export function paged<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'item';
}

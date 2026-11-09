import type { Router } from 'express';

/** Builds the OpenAPI document from the live router tables so it can never drift from the implementation. */
export function buildOpenApi(mounts: Array<[string, Router]>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [prefix, router] of mounts) {
    const tag = prefix.replace('/api/', '');
    for (const layer of (router as any).stack ?? []) {
      if (!layer.route) continue;
      const routePath: string = layer.route.path === '/' ? '' : layer.route.path;
      const full = (prefix + (typeof routePath === 'string' ? routePath : '')).replace(/:(\w+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) {
        const params = [...full.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
        (paths[full] ??= {})[method] = {
          tags: [tag], summary: `${method.toUpperCase()} ${full}`, parameters: params,
          security: tag === 'public' || full.startsWith('/api/auth') ? [] : [{ bearer: [] }],
          responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' }, 422: { description: 'Validation error' } },
        };
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'The Minerva API', version: '1.0.0', description: 'REST API for The Minerva website and management system. Errors are `{ error: { code, message, details? } }`. Staff permissions are enforced server-side.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}

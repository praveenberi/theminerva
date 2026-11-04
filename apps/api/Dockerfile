# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/api/Dockerfile -t tablely-api .

FROM node:20-bookworm-slim AS base
# Prisma's query engine needs OpenSSL; CA certificates let the API call payment and email providers over HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- build: all dependencies, compile TypeScript ----
FROM base AS build
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=api --include-workspace-root
COPY apps/api apps/api
RUN npm run build --workspace=api

# ---- runtime: production dependencies only, no source, no dev tools ----
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=api --include-workspace-root --omit=dev && npm cache clean --force
# migrations and schema are needed at runtime for `prisma migrate deploy` (a one-off command, see docker-compose.prod.yml)
COPY --from=build /app/apps/api/prisma apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
WORKDIR /app/apps/api
EXPOSE 4000
# readiness, not just liveness: a process that cannot reach its database should not receive traffic
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

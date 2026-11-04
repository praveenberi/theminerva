# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/web/Dockerfile -t theminerva-web .

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=web --include-workspace-root
COPY apps/web apps/web
RUN npm run build --workspace=web

# Static files behind nginx, running as an unprivileged user on port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# where /api requests are forwarded (the API service name in the compose network)
ENV API_UPSTREAM=http://api:4000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

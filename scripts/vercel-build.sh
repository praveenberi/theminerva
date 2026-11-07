#!/usr/bin/env bash
# Vercel build: compile the API, apply database migrations (production deploys only), build the web app.
set -euo pipefail

npm run -w api build

if [ "${VERCEL_ENV:-}" = "production" ]; then
  # Migrations need a direct (non-pooled) connection; fall back to DATABASE_URL if DIRECT_URL is not set.
  if [ -z "${DIRECT_URL:-${DATABASE_URL:-}}" ]; then echo "DATABASE_URL / DIRECT_URL is not set" >&2; exit 1; fi
  DATABASE_URL="${DIRECT_URL:-$DATABASE_URL}" npm run -w api migrate:deploy
else
  echo "Skipping database migrations (VERCEL_ENV=${VERCEL_ENV:-unset}); only production deploys migrate."
fi

npm run -w web build

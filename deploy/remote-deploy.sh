#!/usr/bin/env bash
# Runs ON THE SERVER (called by the GitHub deploy workflow, or by hand) to roll out new images safely:
#   1. pull the new images           2. apply database migrations (abort here if they fail; nothing has changed yet)
#   3. restart the app on the new images   4. wait for it to be healthy; if it is not, put the previous images back
#
#   deploy/remote-deploy.sh <image-tag>          e.g. a git sha or v1.4.0
# Needs API_IMAGE_REPO and WEB_IMAGE_REPO in .env.production (e.g. ghcr.io/acme/tablely-api) when images come from a registry.
# Migrations only move forward. Write them so the PREVIOUS version of the app still works on the new schema (add before you
# remove), otherwise the automatic rollback below cannot save you.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
tag="${1:?usage: remote-deploy.sh <image-tag>}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
getvar() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
setvar() { if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi; }

api_repo="$(getvar API_IMAGE_REPO)"; web_repo="$(getvar WEB_IMAGE_REPO)"
prev_api=""; prev_web=""
if [ -n "$api_repo" ] && [ -n "$web_repo" ]; then
  prev_api="$(getvar API_IMAGE)"; prev_web="$(getvar WEB_IMAGE)"
  setvar API_IMAGE "$api_repo:$tag"; setvar WEB_IMAGE "$web_repo:$tag"
fi

restore_previous_tags() {
  if [ -n "$prev_api" ]; then setvar API_IMAGE "$prev_api"; setvar WEB_IMAGE "$prev_web"; fi
}
rollback() {
  echo "Deploy of $tag failed; restoring the previous version." >&2
  restore_previous_tags
  compose up -d api web caddy || true
  exit 1
}

[ "${SKIP_PULL:-0}" = 1 ] || compose pull api web migrate
echo "Applying migrations..."
if ! compose run --rm migrate; then
  echo "Migrations failed; nothing was changed." >&2
  restore_previous_tags
  exit 1
fi

echo "Starting $tag..."
compose up -d --remove-orphans || rollback

# wait up to 90 seconds for the API to report healthy (its health check calls /api/ready, which needs the database)
for _ in $(seq 1 45); do
  state="$(compose ps --format '{{.Health}}' api | head -1)"
  if [ "$state" = healthy ]; then
    echo "Deployed $tag."
    docker image prune -f > /dev/null
    exit 0
  fi
  sleep 2
done
rollback

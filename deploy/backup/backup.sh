#!/usr/bin/env bash
# shellcheck disable=SC2016 # single quotes are deliberate: the $VARIABLES must expand inside the database container, not on this host
# Dumps the production database to a compressed file and prunes old dumps.
#   deploy/backup/backup.sh [target-dir]        (run from anywhere; uses .env.production in the repo root)
# Schedule it (see DEPLOY.md), and copy the files OFF this server: a backup on the same disk is not a backup.
# Also back up SECRETS_KEY and JWT_SECRET somewhere separate: without SECRETS_KEY restaurants' stored payment keys are unreadable.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DIR="${1:-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

mkdir -p "$DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$DIR/tablely-$stamp.dump"

# custom format: compressed, and restorable table by table. Credentials come from the container's own environment.
compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$out.partial"

# a dump that cannot be read back is worse than none, so check before keeping it
if ! compose exec -T db pg_restore --list < "$out.partial" > /dev/null; then
  echo "Backup verification failed; keeping nothing." >&2
  rm -f "$out.partial"
  exit 1
fi
mv "$out.partial" "$out"
chmod 600 "$out"
find "$DIR" -name 'tablely-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$out ($(du -h "$out" | cut -f1))"

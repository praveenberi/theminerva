#!/usr/bin/env bash
# shellcheck disable=SC2016 # single quotes are deliberate: the $VARIABLES must expand inside the database container, not on this host
# Restores a dump into a database, by default a SCRATCH one so you can check a backup without touching production.
#   deploy/backup/restore.sh backups/theminerva-2026....dump                 -> restores into database "restore_check"
#   deploy/backup/restore.sh backups/theminerva-2026....dump my_scratch_db   -> restores into "my_scratch_db"
# Restoring over the live database is deliberately a manual act: see "Disaster recovery" in DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
dump="${1:?usage: restore.sh <dump-file> [target-database]}"
target="${2:-restore_check}"
compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 1; }
[[ "$target" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Database name must be lowercase letters, digits and underscores." >&2; exit 1; }

live="$(compose exec -T db sh -c 'echo "$POSTGRES_DB"' | tr -d '\r')"
if [ "$target" = "$live" ]; then
  echo "Refusing to overwrite the live database '$live'. Restore into a scratch database first (see DEPLOY.md)." >&2
  exit 1
fi

compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1" && createdb -U "$POSTGRES_USER" "$1"' sh "$target"
compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error' sh "$target" < "$dump"

echo "Restored into database '$target'. Row counts:"
query='select '"'"'users'"'"', count(*) from "User" union all select '"'"'restaurants'"'"', count(*) from "Restaurant" union all select '"'"'orders'"'"', count(*) from "Order" union all select '"'"'subscriptions'"'"', count(*) from "Subscription"'
compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -At -c "$2"' sh "$target" "$query"
echo "Drop it when you are done:  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE exec db sh -c 'dropdb -U \"\$POSTGRES_USER\" $target'"

#!/usr/bin/env bash
# Runs the SQL tests against throwaway Docker containers:
#   1. reference/schema.sql on stock Postgres
#   2. reference/schema.sql + reference/supabase.sql on the Supabase Postgres image
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
SB_IMAGE="${SB_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.143}"
CONTAINERS=()

cleanup() {
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

start() { # name image user
  local name="$1" image="$2"
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test "$image" >/dev/null
  CONTAINERS+=("$name")
  for _ in $(seq 1 90); do
    # TCP only opens once the image's init scripts have finished; the unix
    # socket is up earlier, while setup is still running.
    if docker exec -e PGPASSWORD=test "$name" psql -h 127.0.0.1 -U "$3" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "database in $name did not start" >&2
  docker logs "$name" | tail -20 >&2
  exit 1
}

run_sql() { # container user file
  docker exec -i -e PGPASSWORD=test -e PGOPTIONS='-c client_min_messages=warning' "$1" \
    psql -X -q -o /dev/null -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$2" -d postgres < "$3"
}

suffix="$$"

echo "→ schema.sql on $PG_IMAGE"
start "fb-pg-$suffix" "$PG_IMAGE" postgres
run_sql "fb-pg-$suffix" postgres "$ROOT/reference/schema.sql"
run_sql "fb-pg-$suffix" postgres "$ROOT/reference/schema.sql"   # re-runnable
run_sql "fb-pg-$suffix" postgres "$ROOT/tests/sql/schema.test.sql"

echo "→ schema.sql + supabase.sql on $SB_IMAGE"
start "fb-sb-$suffix" "$SB_IMAGE" supabase_admin
run_sql "fb-sb-$suffix" supabase_admin "$ROOT/tests/sql/supabase.setup.sql"
run_sql "fb-sb-$suffix" postgres "$ROOT/reference/schema.sql"
run_sql "fb-sb-$suffix" postgres "$ROOT/reference/supabase.sql"
run_sql "fb-sb-$suffix" postgres "$ROOT/tests/sql/supabase.test.sql"

echo "SQL tests passed"

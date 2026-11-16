#!/usr/bin/env bash
# Starts a throwaway Postgres 16 cluster, loads shim.sql and the migrations into a template
# database, runs every *.test.sql in its own database copy, and stops the cluster.
# Exit status is non-zero if anything fails. Usage: run.sh [test-file-pattern]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TESTS_DIR="$HERE"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PSQL="${PSQL:-/usr/bin/psql}"

# Postgres refuses to run as root: re-run as an unprivileged user.
if [ "$(id -u)" = "0" ]; then
  id pgtest >/dev/null 2>&1 || useradd -m -s /bin/bash pgtest
  exec runuser -u pgtest -- bash "${BASH_SOURCE[0]}" "$@"
fi

PATTERN="${1:-}"
WORK="$(mktemp -d /tmp/pf-pg.XXXXXX)"
DATA="$WORK/data"
SOCK="$WORK/sock"
mkdir -p "$SOCK"
FAILED=0
TOTAL_OK=0
NFILES=0

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >"$WORK/initdb.log" 2>&1 \
  || { cat "$WORK/initdb.log"; echo "initdb failed"; exit 1; }

"$PGBIN/pg_ctl" -D "$DATA" -l "$WORK/server.log" -w \
  -o "-c listen_addresses='' -c unix_socket_directories='$SOCK' -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
  start >/dev/null || { cat "$WORK/server.log"; echo "postgres failed to start"; exit 1; }

psql_db() { # db, args...
  local db="$1"; shift
  "$PSQL" -X -q -h "$SOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"
}

psql_db postgres -c "create database base" || exit 1
psql_db base -f "$HERE/shim.sql" >"$WORK/shim.log" 2>&1 || { cat "$WORK/shim.log"; echo "shim.sql failed"; exit 1; }

HAS_CRON=$(psql_db base -Atc "select exists (select 1 from pg_available_extensions where name = 'pg_cron')")
for f in "$HERE"/../migrations/*.sql; do
  case "$(basename "$f")" in
    *_cron.sql) if [ "$HAS_CRON" != "t" ]; then echo "skip   $(basename "$f") (pg_cron not available)"; continue; fi ;;
  esac
  if psql_db base -f "$f" >"$WORK/mig.log" 2>&1; then
    echo "apply  $(basename "$f")"
  else
    cat "$WORK/mig.log"; echo "FAILED migration $(basename "$f")"; exit 1
  fi
done

for f in "$HERE"/*${PATTERN}*.test.sql; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .test.sql)"
  db="t_${name//[^a-zA-Z0-9]/_}"
  psql_db postgres -c "create database \"$db\" template base" || { FAILED=1; continue; }
  NFILES=$((NFILES + 1))
  if psql_db "$db" -o /dev/null -f "$f" >"$WORK/$name.out" 2>&1; then
    n=$(grep -c '^psql:.*NOTICE:  ok - \|^NOTICE:  ok - ' "$WORK/$name.out" || true)
    TOTAL_OK=$((TOTAL_OK + n))
    printf 'PASS   %-28s %4d assertions\n' "$name" "$n"
  else
    FAILED=1
    n=$(grep -c 'NOTICE:  ok - ' "$WORK/$name.out" || true)
    printf 'FAIL   %-28s (%d assertions passed before the failure)\n' "$name" "$n"
    grep -v 'NOTICE:  ok - ' "$WORK/$name.out" | tail -20
  fi
done

if [ "$FAILED" != "0" ] || [ "$NFILES" = "0" ]; then
  echo "TESTS FAILED ($NFILES files, $TOTAL_OK assertions passed)"
  exit 1
fi
echo "ALL PASSED: $NFILES files, $TOTAL_OK assertions"

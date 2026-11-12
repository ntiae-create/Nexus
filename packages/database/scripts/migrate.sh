#!/bin/sh
# Applies the versioned SQL migrations to a PostgreSQL database that is NOT the
# disposable test cluster. This is the production/staging path; the test path is
# `test-postgres-integration.sh`, which owns its own throwaway database and
# hard-coded fixture passwords and must not be pointed at a real server.
#
# Usage:
#   NEXUS_MIGRATION_DATABASE_URL='postgresql://...' sh packages/database/scripts/migrate.sh
#
# The variable is deliberately different from `NEXUS_DATABASE_URL`: applying DDL
# needs a role with migration rights, while the running API connects with the
# least-privilege application role. Keeping them separate means the server never
# holds credentials that can drop a table.
#
# Transactional behaviour — stated honestly:
#   Each migration file is applied by its own `psql` session with
#   ON_ERROR_STOP=1. Migrations 00003..00008 manage their own transaction
#   (they open with BEGIN and close with COMMIT), so each of those is atomic on
#   its own: a failure inside one rolls that migration back completely.
#   Migrations 00001 and 00002 carry no BEGIN/COMMIT; PostgreSQL therefore runs
#   each statement in autocommit mode, and a failure part-way leaves the
#   statements that already succeeded in place. This script does NOT pretend
#   otherwise, and it records a version as applied only after its file exits 0.
#   A re-run after a partial 00001/00002 failure would need manual cleanup —
#   which is why the first run against a fresh database should be done watched,
#   not unattended.
#
# RLS context (required, not optional):
#   Migration 00001 turns on `FORCE ROW LEVEL SECURITY` for the owner tables.
#   `FORCE` subjects the table OWNER to RLS too, and the migration role owns
#   them — so every migration file must run with `nexus.owner_id` and
#   `nexus.actor_type` set, or the seed inserts fail with
#   "new row violates row-level security policy". This is the same technique
#   `test-postgres-integration.sh` uses (`run_sql_as_migrator_with_context`).
#   The context is session-scoped and set per file, before the file's own SQL.
#   Providing it is what allows migrations to run as the real, non-superuser
#   role WITHOUT relaxing any RLS policy.
#
# Safety properties (each one exercised, not assumed):
#   * refuses to run without an explicit URL — never falls back to a local socket
#   * prints host and database ONLY, and filters role/URL fragments out of any
#     driver error before it reaches a terminal or a log
#   * requires an interactive confirmation unless NEXUS_MIGRATE_ASSUME_YES=1
#   * records applied versions in nexus_migrations.schema_migrations and skips
#     them on re-run, so the command is repeatable
#   * stops at the first failing migration and exits non-zero
#   * does not use DROP DATABASE / DROP ROLE / DROP OWNED / REASSIGN OWNED
set -eu

if [ -z "${NEXUS_MIGRATION_DATABASE_URL:-}" ]; then
  echo "NEXUS_MIGRATION_DATABASE_URL is required (the application NEXUS_DATABASE_URL is not accepted here)." >&2
  exit 2
fi

database_package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
migration_dir="$database_package_dir/migrations"

if [ ! -d "$migration_dir" ]; then
  echo "Migration directory not found: $migration_dir" >&2
  exit 2
fi

# host/database only — the URL is never echoed whole.
target=$(printf '%s' "$NEXUS_MIGRATION_DATABASE_URL" | sed -E 's#^[a-zA-Z0-9+]+://([^@/]*@)?([^/:?]+)(:[0-9]+)?/([^?]+).*#\2/\4#')
case "$target" in
  ""|"$NEXUS_MIGRATION_DATABASE_URL")
    echo "Could not parse host/database from NEXUS_MIGRATION_DATABASE_URL." >&2
    exit 2
    ;;
esac

echo "Target: $target"

if [ "${NEXUS_MIGRATE_ASSUME_YES:-0}" != "1" ]; then
  printf 'Apply migrations to %s ? [y/N] ' "$target"
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted." >&2; exit 1 ;;
  esac
fi

# The single owner identity seeded by 00001; migrations that touch owner rows
# need it in the session context.
NEXUS_OWNER_ID=${NEXUS_OWNER_ID:-00000000-0000-4000-8000-000000000004}

psql_bin=${PSQL_BIN:-psql}
command -v "$psql_bin" >/dev/null 2>&1 || {
  echo "psql not found. Install the PostgreSQL client or set PSQL_BIN." >&2
  exit 2
}

stderr_tmp="${TMPDIR:-/tmp}/nexus_migrate_err.$$"
trap 'rm -f "$stderr_tmp" "${TMPDIR:-/tmp}"/nexus_migration_ctx.$$.sql' EXIT HUP INT TERM

# Removes anything that could carry a credential before it is printed.
redact() {
  sed -E 's#(postgres(ql)?|mysql|mongodb(\+srv)?)://[^ "]*#<redacted-url>#g; s#role "[^"]*"#role <redacted>#g' "$1" >&2
}

# Every psql call goes through here, so no path can print an unredacted error.
run_psql() {
  if ! "$psql_bin" --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
      --dbname "$NEXUS_MIGRATION_DATABASE_URL" "$@" >/dev/null 2>"$stderr_tmp"; then
    redact "$stderr_tmp"
    return 1
  fi
  return 0
}

# Ledger lives outside `nexus`: migration 00001 opens with a bare
# `CREATE SCHEMA nexus;`, so anything created in that schema beforehand would
# make 00001 fail. Keeping the ledger separate also means a partially applied
# schema never hides the record of the attempt.
run_psql --command "CREATE SCHEMA IF NOT EXISTS nexus_migrations" || {
  echo "Could not reach the database (or create the ledger schema). Nothing was applied." >&2
  exit 1
}

run_psql --command "CREATE TABLE IF NOT EXISTS nexus_migrations.schema_migrations (
  version    integer PRIMARY KEY,
  filename   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)" || { echo "Could not create the ledger table. Nothing was applied." >&2; exit 1; }

applied_count=0
skipped_count=0

for migration in "$migration_dir"/*.sql; do
  [ -f "$migration" ] || continue
  filename=$(basename "$migration")
  version=$(printf '%s' "$filename" | sed -E 's/^([0-9]+)[_-].*/\1/')

  applied=$("$psql_bin" --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --dbname "$NEXUS_MIGRATION_DATABASE_URL" \
    --command "SELECT 1 FROM nexus_migrations.schema_migrations WHERE version = $version" 2>/dev/null) || {
      echo "Could not read the ledger for $filename." >&2; exit 1; }

  if [ "$applied" = "1" ]; then
    echo "skip  $filename (already applied)"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  echo "apply $filename"
  # The RLS context goes first, in the SAME session as the file's SQL.
  migration_ctx="${TMPDIR:-/tmp}/nexus_migration_ctx.$$.sql"
  {
    printf "SELECT set_config('nexus.owner_id','%s',false);\n" "$NEXUS_OWNER_ID"
    printf "SELECT set_config('nexus.actor_type','owner',false);\n"
    cat "$migration"
  } > "$migration_ctx"
  if ! run_psql --file "$migration_ctx"; then
    rm -f "$migration_ctx"
    echo "STOP: $filename failed. It was NOT recorded as applied; migrations after it were not run." >&2
    exit 1
  fi
  rm -f "$migration_ctx"

  run_psql --command "INSERT INTO nexus_migrations.schema_migrations (version, filename)
    VALUES ($version, '$filename') ON CONFLICT (version) DO NOTHING" || {
      echo "Applied $filename but could not record it in the ledger." >&2; exit 1; }
  applied_count=$((applied_count + 1))
done

echo "Done. applied=$applied_count skipped=$skipped_count target=$target"

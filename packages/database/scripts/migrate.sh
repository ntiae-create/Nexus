#!/bin/sh
# Apply versioned PostgreSQL migrations as nexus_migrator.
#
# Connection credentials must be supplied through a mode-0600 libpq passfile
# (PGPASSFILE), never in a URL, argv, PGPASSWORD, or a service definition.
# `install-production.sh` creates and removes that file around this process.
#
# Migration/ledger guarantees:
#   * a database-scoped advisory lock serializes each version's check, DDL and
#     ledger write; different invocations cannot race the same migration;
#   * 00001/00002 have no transaction of their own, so this runner wraps each
#     one and its ledger INSERT in a transaction;
#   * 00003..00008 keep their own BEGIN/COMMIT. The ledger INSERT is injected
#     immediately before their final COMMIT, in that same transaction;
#   * every applied ledger row stores the SHA-256 of the exact immutable file;
#   * inconsistent, partial legacy, or checksum-divergent ledgers fail closed.
#
# Usage:
#   sh packages/database/scripts/migrate.sh [--check-only|--adopt-legacy-ledger]
set -eu
umask 077

usage() {
  cat <<'USAGE'
Usage: migrate.sh [--check-only|--adopt-legacy-ledger]

Connection settings: PGHOST, PGPORT, PGDATABASE, PGUSER, PGSSLMODE and a
mode-0600 PGPASSFILE. Passwords/URLs in PGPASSWORD or
NEXUS_MIGRATION_DATABASE_URL are not accepted.

--check-only             read-only connection/ledger preflight; exit 10 for a
                         complete legacy ledger that needs explicit adoption
--adopt-legacy-ledger    after a full 30_verify.sql passes, add current file
                         checksums to a complete pre-checksum ledger
USAGE
}

mode=run
case "${1:-}" in
  "") ;;
  --check-only) mode=check; shift ;;
  --adopt-legacy-ledger) mode=adopt; shift ;;
  --help|-h) usage; exit 0 ;;
  *) echo "Unknown migrate.sh option: $1" >&2; usage >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo "Too many migrate.sh arguments." >&2; usage >&2; exit 2; }

if [ "${PGPASSWORD+x}" = x ] && [ -n "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD is rejected; use an interactive prompt and a protected PGPASSFILE." >&2
  exit 2
fi
if [ "${NEXUS_MIGRATION_DATABASE_URL+x}" = x ]; then
  echo "NEXUS_MIGRATION_DATABASE_URL is no longer accepted; use separate PG* settings and PGPASSFILE." >&2
  exit 2
fi
unset PGPASSWORD PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSFILE:?PGPASSFILE must point to a protected libpq passfile}"
[ -r "$PGPASSFILE" ] || { echo "PGPASSFILE is not readable." >&2; exit 2; }
case "$PGHOST" in
  *://*|*@*|*'?'*|*'#'*|*' '*|*'\t'*) echo "PGHOST must be a host name/address, not a URL or credential string." >&2; exit 2 ;;
esac
case "$PGDATABASE" in
  ""|*[!A-Za-z0-9_.-]*) echo "PGDATABASE must contain only letters, digits, dot, underscore or hyphen." >&2; exit 2 ;;
esac
case "$PGPORT" in
  ""|*[!0-9]*) echo "PGPORT must be numeric." >&2; exit 2 ;;
esac
[ "$PGPORT" -ge 1 ] 2>/dev/null && [ "$PGPORT" -le 65535 ] 2>/dev/null || {
  echo "PGPORT must be between 1 and 65535." >&2; exit 2;
}

ssl_mode=${PGSSLMODE:-require}
case "$ssl_mode" in
  require|verify-ca|verify-full) ;;
  disable)
    case "$PGHOST" in
      localhost|127.*|::1|/tmp/*) ;;
      *) echo "TLS is required for non-local migration targets (PGSSLMODE=disable is local-test-only)." >&2; exit 2 ;;
    esac
    ;;
  *) echo "PGSSLMODE must be require, verify-ca or verify-full (disable is limited to local tests)." >&2; exit 2 ;;
esac
export PGSSLMODE="$ssl_mode"

if [ "$mode" != check ] && [ "$PGUSER" != nexus_migrator ]; then
  echo "Migrations and ledger adoption must run as nexus_migrator (PGUSER=$PGUSER)." >&2
  exit 2
fi

psql_bin=${PSQL_BIN:-psql}
command -v "$psql_bin" >/dev/null 2>&1 || { echo "psql not found; set PSQL_BIN to the PostgreSQL client." >&2; exit 2; }
sha256sum_bin=$(command -v sha256sum 2>/dev/null || true)
shasum_bin=$(command -v shasum 2>/dev/null || true)
if [ -z "$sha256sum_bin" ] && [ -z "$shasum_bin" ]; then
  echo "sha256sum or shasum is required to verify immutable migration files." >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
database_package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
migration_dir="$database_package_dir/migrations"
verify_file="$script_dir/production/30_verify.sql"
[ -d "$migration_dir" ] || { echo "Migration directory not found." >&2; exit 2; }
[ -f "$verify_file" ] || { echo "Production verifier not found." >&2; exit 2; }

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/nexus-migrate.XXXXXX") || { echo "Could not create a private migration temp directory." >&2; exit 2; }
scan_sql="$tmp_dir/scan.psql"
scan_out="$tmp_dir/scan.out"
scan_err="$tmp_dir/scan.err"
manifest="$tmp_dir/manifest"
ledger_sql="$tmp_dir/ledger.psql"
ledger_err="$tmp_dir/ledger.err"
ledger_out="$tmp_dir/ledger.out"
adopt_sql="$tmp_dir/adopt.psql"
adopt_err="$tmp_dir/adopt.err"
adopt_out="$tmp_dir/adopt.out"
cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Print errors only after scrubbing connection URLs, role identifiers and SCRAM
# verifier strings. No successful psql output contains credentials.
redact() {
  sed -E \
    -e 's#(postgres(ql)?|mysql|mongodb(\+srv)?)://[^[:space:]" ]*#<redacted-url>#g' \
    -e 's#SCRAM-SHA-256[^[:space:]]*#<redacted-verifier>#g' \
    -e 's#role "[^"]*"#role <redacted>#g'
}

psql_run() {
  PGPASSFILE="$PGPASSFILE" PGSSLMODE="$ssl_mode" \
    "$psql_bin" --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
      --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
      --dbname "$PGDATABASE" "$@"
}

sha256_file() {
  if [ -n "$sha256sum_bin" ]; then
    "$sha256sum_bin" "$1" | awk '{print $1}'
  else
    "$shasum_bin" -a 256 "$1" | awk '{print $1}'
  fi
}

expected_filename() {
  case "$1" in
    1) printf '%s\n' 00001_initial_schema.sql ;;
    2) printf '%s\n' 00002_auth_security.sql ;;
    3) printf '%s\n' 00003_persistence_integrity.sql ;;
    4) printf '%s\n' 00004_core_execution_hierarchy.sql ;;
    5) printf '%s\n' 00005_assistant_seed_parity.sql ;;
    6) printf '%s\n' 00006_assistant_seed_vivy.sql ;;
    7) printf '%s\n' 00007_tool_grants_and_preferences.sql ;;
    8) printf '%s\n' 00008_owner_deletion_tombstone_guard.sql ;;
    *) return 1 ;;
  esac
}

build_manifest() {
  : > "$manifest"
  expected=1
  count=0
  for migration in "$migration_dir"/*.sql; do
    [ -f "$migration" ] || continue
    filename=$(basename "$migration")
    version=$(printf '%s\n' "$filename" | sed -nE 's/^([0-9]+)[_-].*\.sql$/\1/p' | sed 's/^0*//')
    [ -n "$version" ] || { echo "Invalid migration filename: $filename" >&2; return 1; }
    wanted=$(expected_filename "$expected") || { echo "Unexpected migration version $expected; update the migration contract deliberately." >&2; return 1; }
    if [ "$version" -ne "$expected" ] || [ "$filename" != "$wanted" ]; then
      echo "Migration sequence/name mismatch at $filename (expected version $expected, $wanted)." >&2
      return 1
    fi
    checksum=$(sha256_file "$migration") || { echo "Could not checksum $filename." >&2; return 1; }
    printf '%s|%s|%s\n' "$version" "$filename" "$checksum" >> "$manifest"
    expected=$((expected + 1))
    count=$((count + 1))
  done
  if [ "$count" -ne 8 ]; then
    echo "Expected the immutable migration contract 00001-00008; found $count files." >&2
    return 1
  fi
}

build_scan_sql() {
  cat > "$scan_sql" <<'SQL'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtext(current_database()), 1313817420) AS migration_lock \gset
SELECT (to_regnamespace('nexus') IS NOT NULL) AS nexus_exists \gset
\echo META|nexus_exists=:nexus_exists
SELECT (to_regclass('nexus_migrations.schema_migrations') IS NOT NULL) AS ledger_exists \gset
\echo META|ledger_exists=:ledger_exists
\if :ledger_exists
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('nexus_migrations.schema_migrations') AND attname = 'version' AND attnum > 0 AND NOT attisdropped)
       OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('nexus_migrations.schema_migrations') AND attname = 'filename' AND attnum > 0 AND NOT attisdropped)
       OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('nexus_migrations.schema_migrations') AND attname = 'applied_at' AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'ledger schema is not compatible';
    END IF;
  END $$;
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('nexus_migrations.schema_migrations') AND attname = 'checksum' AND attnum > 0 AND NOT attisdropped) AS has_checksum \gset
  \echo META|has_checksum=:has_checksum
  \if :has_checksum
    SELECT 'ROW|' || COALESCE(version::text, '<NULL_VERSION>') || '|' || COALESCE(filename, '<NULL_FILENAME>') || '|' || COALESCE(checksum, '<NULL>')
      FROM nexus_migrations.schema_migrations ORDER BY version;
  \else
    SELECT 'ROW|' || COALESCE(version::text, '<NULL_VERSION>') || '|' || COALESCE(filename, '<NULL_FILENAME>') || '|<NO_CHECKSUM>'
      FROM nexus_migrations.schema_migrations ORDER BY version;
  \endif
\endif
SELECT pg_advisory_unlock(hashtext(current_database()), 1313817420) AS migration_unlock \gset
SQL
}

# Read and validate ledger state without changing the database. Globals set:
# nexus_exists, ledger_exists, row_count, ledger_state (fresh|modern|legacy).
check_ledger() {
  nexus_exists=false
  ledger_exists=false
  has_checksum=false
  row_count=0
  ledger_state=fresh
  expected_version=1
  checksum_state=unset
  build_scan_sql
  if ! psql_run --tuples-only --no-align --file "$scan_sql" >"$scan_out" 2>"$scan_err"; then
    redact < "$scan_err" >&2
    return 1
  fi

  while IFS= read -r line; do
    case "$line" in
      'META|nexus_exists='*) nexus_exists=${line#*=} ;;
      'META|ledger_exists='*) ledger_exists=${line#*=} ;;
      'META|has_checksum='*) has_checksum=${line#*=} ;;
      'ROW|'*)
        fields=${line#ROW|}
        version=${fields%%|*}; fields=${fields#*|}
        filename=${fields%%|*}; checksum=${fields#*|}
        case "$version" in ""|*[!0-9]*) echo "Ledger contains a non-numeric version." >&2; return 1 ;; esac
        wanted=$(expected_filename "$expected_version") || { echo "Ledger contains a version outside 1..8." >&2; return 1; }
        if [ "$version" -ne "$expected_version" ] || [ "$filename" != "$wanted" ]; then
          echo "Ledger divergence at version $version (filename $filename; expected contiguous version $expected_version, $wanted)." >&2
          return 1
        fi
        if [ "$checksum" = '<NO_CHECKSUM>' ] || [ "$checksum" = '<NULL>' ] || [ -z "$checksum" ]; then
          if [ "$checksum_state" = present ]; then
            echo "Ledger has a mixture of checksummed and unchecksummed rows; automatic recovery is unsafe." >&2
            return 1
          fi
          checksum_state=missing
        else
          if [ "$checksum_state" = missing ]; then
            echo "Ledger has a mixture of checksummed and unchecksummed rows; automatic recovery is unsafe." >&2
            return 1
          fi
          checksum_state=present
          expected_sum=$(awk -F'|' -v wanted_version="$version" '$1 == wanted_version { print $3 }' "$manifest")
          if [ "$checksum" != "$expected_sum" ]; then
            echo "Checksum mismatch for applied migration $filename; do not rerun or edit the ledger automatically." >&2
            return 1
          fi
        fi
        expected_version=$((expected_version + 1))
        row_count=$((row_count + 1))
        ;;
      *)
        # psql returns only META and ROW records on success.
        [ -z "$line" ] || { echo "Unexpected output while reading migration ledger." >&2; return 1; }
        ;;
    esac
  done < "$scan_out"

  # psql formats booleans as t/f; normalize before the shell-state checks.
  case "$nexus_exists" in t) nexus_exists=true ;; f) nexus_exists=false ;; true|false) ;; *) echo "Ledger scan omitted nexus-schema state." >&2; return 1 ;; esac
  case "$ledger_exists" in t) ledger_exists=true ;; f) ledger_exists=false ;; true|false) ;; *) echo "Ledger scan omitted ledger state." >&2; return 1 ;; esac
  case "$has_checksum" in t) has_checksum=true ;; f) has_checksum=false ;; true|false) ;; *) echo "Ledger scan omitted checksum-column state." >&2; return 1 ;; esac

  if [ "$ledger_exists" = false ]; then
    if [ "$nexus_exists" = true ]; then
      echo "Database has schema nexus but no migration ledger; state is ambiguous and will not be changed." >&2
      return 1
    fi
    ledger_state=fresh
    return 0
  fi

  if [ "$row_count" -eq 0 ]; then
    if [ "$nexus_exists" = true ]; then
      echo "Database has schema nexus but an empty ledger; state is ambiguous and will not be changed." >&2
      return 1
    fi
    ledger_state=fresh
    return 0
  fi
  if [ "$nexus_exists" != true ]; then
    echo "Migration ledger has $row_count rows but schema nexus is absent; state is divergent." >&2
    return 1
  fi

  if [ "$checksum_state" = missing ]; then
    if [ "$row_count" -ne 8 ]; then
      echo "Legacy ledger is partial ($row_count/8) and has no checksums; automatic recovery is unsafe." >&2
      return 1
    fi
    ledger_state=legacy
    return 0
  fi
  ledger_state=modern
}

print_target() {
  printf 'Target: %s:%s/%s (sslmode=%s)\n' "$PGHOST" "$PGPORT" "$PGDATABASE" "$ssl_mode"
}

build_manifest
if ! check_ledger; then
  exit 1
fi

if [ "$mode" = check ]; then
  print_target
  case "$ledger_state" in
    fresh) echo "Preflight OK: database has no nexus schema or applied migration rows." ;;
    modern) echo "Preflight OK: $row_count applied migration checksums match the checked-out files." ;;
    legacy)
      echo "Legacy ledger: all 8 expected rows exist but have no checksums; explicit verification and adoption are required." >&2
      exit 10
      ;;
  esac
  exit 0
fi

if [ "$mode" = adopt ]; then
  if [ "$ledger_state" != legacy ]; then
    echo "--adopt-legacy-ledger requires a complete 00001-00008 ledger without checksums." >&2
    exit 2
  fi
  if [ "${NEXUS_MIGRATE_ASSUME_YES:-0}" != 1 ]; then
    print_target
    printf 'Run read-only 30_verify.sql, then adopt the complete legacy ledger checksums? [y/N] '
    read -r answer || answer=
    case "$answer" in y|Y|yes|YES) ;; *) echo "Aborted." >&2; exit 1 ;; esac
  fi

  # 30_verify.sql is concatenated into a private temporary psql script below;
  # preserve its relative \ir include of the shared privilege contract there.
  cp "$script_dir/production/assert_app_privileges.sql" "$tmp_dir/assert_app_privileges.sql"

  {
    printf '\\set ON_ERROR_STOP on\n'
    printf 'SELECT pg_advisory_lock(hashtext(current_database()), 1313817420);\n'
    cat "$verify_file"
    cat <<'SQL'
BEGIN;
ALTER TABLE nexus_migrations.schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
UPDATE nexus_migrations.schema_migrations AS ledger
   SET checksum = expected.checksum
  FROM (VALUES
SQL
    separator=
    while IFS='|' read -r version filename checksum; do
      printf '%s    (%s, %s, %s)\n' "$separator" "$version" "'$filename'" "'$checksum'"
      separator=,
    done < "$manifest"
    cat <<'SQL'
  ) AS expected(version, filename, checksum)
 WHERE ledger.version = expected.version
   AND ledger.filename = expected.filename
   AND ledger.checksum IS NULL;
DO $$
BEGIN
  IF (SELECT count(*) FROM nexus_migrations.schema_migrations) <> 8
     OR EXISTS (
       SELECT 1 FROM nexus_migrations.schema_migrations
        WHERE checksum IS NULL OR length(checksum) <> 64
     ) THEN
    RAISE EXCEPTION 'legacy ledger adoption did not produce exactly 8 checksums';
  END IF;
END $$;
ALTER TABLE nexus_migrations.schema_migrations ALTER COLUMN checksum SET NOT NULL;
COMMIT;
SELECT pg_advisory_unlock(hashtext(current_database()), 1313817420);
SQL
  } > "$adopt_sql"
  if ! psql_run --file "$adopt_sql" >"$adopt_out" 2>"$adopt_err"; then
    redact < "$adopt_out" >&2
    redact < "$adopt_err" >&2
    echo "Legacy ledger was not adopted; no migration file was run." >&2
    exit 1
  fi
  echo "Legacy ledger verified and checksums recorded; no migrations or application data were changed."
  exit 0
fi

if [ "$ledger_state" = legacy ]; then
  echo "Legacy ledger detected. Run the full 30_verify.sql, review a restorable backup, then use --adopt-legacy-ledger explicitly." >&2
  exit 2
fi

print_target
if [ "${NEXUS_MIGRATE_ASSUME_YES:-0}" != 1 ]; then
  printf 'Apply/reconcile the verified migration prefix on this database? [y/N] '
  read -r answer || answer=
  case "$answer" in y|Y|yes|YES) ;; *) echo "Aborted." >&2; exit 1 ;; esac
fi

owner_id=${NEXUS_OWNER_ID:-00000000-0000-4000-8000-000000000004}
if ! printf '%s' "$owner_id" | grep -Eq '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'; then
  echo "NEXUS_OWNER_ID must be a UUID." >&2
  exit 2
fi

# Create/upgrade the empty ledger atomically. A pre-checksum table is upgraded
# only when empty; populated pre-checksum ledgers were rejected above unless
# adopted through the explicit verified path.
cat > "$ledger_sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtext(current_database()), 1313817420);
CREATE SCHEMA IF NOT EXISTS nexus_migrations;
DO $$
BEGIN
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'nexus_migrations') <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'nexus_migrations schema must be owned by nexus_migrator';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS nexus_migrations.schema_migrations (
  version integer PRIMARY KEY,
  filename text NOT NULL,
  checksum text,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE nexus_migrations.schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
DO $$
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid = 'nexus_migrations.schema_migrations'::regclass)
       <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'migration ledger must be owned by nexus_migrator';
  END IF;
  IF EXISTS (SELECT 1 FROM nexus_migrations.schema_migrations WHERE checksum IS NULL) THEN
    RAISE EXCEPTION 'ledger has missing checksums; explicit recovery is required';
  END IF;
END $$;
ALTER TABLE nexus_migrations.schema_migrations ALTER COLUMN checksum SET NOT NULL;
COMMIT;
SQL
if ! psql_run --file "$ledger_sql" >"$ledger_out" 2>"$ledger_err"; then
  redact < "$ledger_out" >&2
  redact < "$ledger_err" >&2
  echo "Could not safely initialize the migration ledger; no migration file was run." >&2
  exit 1
fi

# Advisory lock, applied-row decision, migration DDL and ledger INSERT share one
# psql session. A failure closes the session and rolls back the current file.
for migration in "$migration_dir"/*.sql; do
  [ -f "$migration" ] || continue
  filename=$(basename "$migration")
  version=$(printf '%s\n' "$filename" | sed -nE 's/^([0-9]+)[_-].*\.sql$/\1/p' | sed 's/^0*//')
  checksum=$(awk -F'|' -v wanted_version="$version" '$1 == wanted_version { print $3 }' "$manifest")
  driver="$tmp_dir/migration-$version.psql"
  body="$tmp_dir/body-$version.sql"
  insert_sql="INSERT INTO nexus_migrations.schema_migrations(version, filename, checksum) VALUES ($version, '$filename', '$checksum');"

  if [ "$version" -le 2 ]; then
    {
      printf "SELECT set_config('nexus.owner_id','%s',false);\n" "$owner_id"
      printf "SELECT set_config('nexus.actor_type','owner',false);\n"
      printf 'BEGIN;\n'
      cat "$migration"
      printf '\n%s\nCOMMIT;\n' "$insert_sql"
    } > "$body"
  else
    if [ "$(grep -Eic '^[[:space:]]*BEGIN;[[:space:]]*$' "$migration")" -ne 1 ] \
       || [ "$(grep -Eic '^[[:space:]]*COMMIT;[[:space:]]*$' "$migration")" -ne 1 ]; then
      echo "$filename must retain exactly one explicit BEGIN/COMMIT transaction." >&2
      exit 2
    fi
    if ! awk -v sql="$insert_sql" '
      { lines[NR] = $0; if ($0 ~ /^[[:space:]]*COMMIT;[[:space:]]*$/) commit = NR }
      END {
        if (!commit) exit 2
        for (i = 1; i <= NR; i++) { if (i == commit) print sql; print lines[i] }
      }
    ' "$migration" > "$body"; then
      echo "Could not inject the ledger write into $filename without changing its transaction." >&2
      exit 2
    fi
    {
      printf "SELECT set_config('nexus.owner_id','%s',false);\n" "$owner_id"
      printf "SELECT set_config('nexus.actor_type','owner',false);\n"
      cat "$body"
    } > "$body.context"
    mv "$body.context" "$body"
  fi

  {
    cat <<'DRIVER_HEAD'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtext(current_database()), 1313817420);
DRIVER_HEAD
    printf "SELECT EXISTS (SELECT 1 FROM nexus_migrations.schema_migrations WHERE version = %s) AS migration_applied \\gset\n" "$version"
    printf '\\if :migration_applied\n'
    printf "  SELECT COALESCE(filename = '%s' AND checksum = '%s', false) AS migration_matches FROM nexus_migrations.schema_migrations WHERE version = %s \\gset\n" "$filename" "$checksum" "$version"
    printf '  \\if :migration_matches\n'
    printf '    \\echo NEXUS_MIGRATION_SKIP_%s\n' "$version"
    printf '  \\else\n'
    printf '    \\echo Ledger filename/checksum mismatch for %s\n' "$filename"
    printf '    \\quit 3\n'
    printf '  \\endif\n'
    printf '\\else\n'
    printf '  \\echo NEXUS_MIGRATION_APPLY_%s\n' "$version"
    cat "$body"
    printf '\\endif\n'
    printf 'SELECT pg_advisory_unlock(hashtext(current_database()), 1313817420);\n'
  } > "$driver"

  if ! psql_run --file "$driver" >"$ledger_out" 2>"$ledger_err"; then
    redact < "$ledger_out" >&2
    redact < "$ledger_err" >&2
    echo "STOP: $filename failed; its transaction was rolled back and its ledger row was not committed." >&2
    echo "No later migration was started. Inspect the ledger and schema before retrying." >&2
    exit 1
  fi
  if grep -q "NEXUS_MIGRATION_APPLY_$version" "$ledger_out"; then
    echo "apply $filename (DDL and ledger committed together)"
  else
    echo "skip  $filename (matching checksum already recorded)"
  fi
done

if ! check_ledger; then
  echo "Final ledger consistency check failed." >&2
  exit 1
fi
if [ "$ledger_state" != modern ] || [ "$row_count" -ne 8 ]; then
  echo "Migrations ended without the complete checksummed ledger (found $row_count rows)." >&2
  exit 1
fi
echo "Done. applied ledger 1..8; all checksums match. target=$PGHOST:$PGPORT/$PGDATABASE"

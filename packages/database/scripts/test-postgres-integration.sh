#!/bin/sh
set -eu

if [ -z "${NEXUS_TEST_POSTGRES_CONTAINER_ID:-}" ]; then
  echo "NEXUS_TEST_POSTGRES_CONTAINER_ID must identify the isolated PostgreSQL service container." >&2
  exit 2
fi

database_package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
migration_dir="$database_package_dir/migrations"
migration_count=$(find "$migration_dir" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
if [ "$migration_count" -ne 4 ]; then
  echo "Expected migrations 00001 through 00004 in the fresh test database; found $migration_count." >&2
  exit 2
fi

if [ ! -f "$migration_dir/00001_initial_schema.sql" ]; then
  echo "Expected versioned migration 00001_initial_schema.sql was not found." >&2
  exit 2
fi

postgres_container_id=$NEXUS_TEST_POSTGRES_CONTAINER_ID
for migration_file in "$migration_dir"/*.sql; do
  migration_name=$(basename "$migration_file")
  if [ "$migration_name" = "00003_persistence_integrity.sql" ]; then
    echo "Seeding real Etapa 2A rows before the additive upgrade."
    docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/legacy-stage-2a.sql"
  fi
  echo "Applying $migration_name to isolated nexus_test database."
  docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$migration_file"
  if [ "$migration_name" = "00003_persistence_integrity.sql" ]; then
    docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-2b-migration.sql"
  fi
done
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/bootstrap.sql"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -U nexus_app -d nexus_test -f - < "$database_package_dir/tests/postgres/integration.sql"

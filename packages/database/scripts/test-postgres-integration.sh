#!/bin/sh
set -eu

if [ -z "${NEXUS_TEST_POSTGRES_CONTAINER_ID:-}" ]; then
  echo "NEXUS_TEST_POSTGRES_CONTAINER_ID must identify the isolated PostgreSQL service container." >&2
  exit 2
fi

database_package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
migration_dir="$database_package_dir/migrations"
migration_count=$(find "$migration_dir" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
if [ "$migration_count" -ne 1 ]; then
  echo "Expected exactly one initial SQL migration in the fresh test database; found $migration_count." >&2
  exit 2
fi

migration_file="$migration_dir/00001_initial_schema.sql"
if [ ! -f "$migration_file" ]; then
  echo "Expected versioned migration 00001_initial_schema.sql was not found." >&2
  exit 2
fi

postgres_container_id=$NEXUS_TEST_POSTGRES_CONTAINER_ID
echo "Applying migration 00001_initial_schema.sql to isolated nexus_test database."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$migration_file"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/bootstrap.sql"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -U nexus_app -d nexus_test -f - < "$database_package_dir/tests/postgres/integration.sql"

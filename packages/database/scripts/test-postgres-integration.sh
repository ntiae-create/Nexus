#!/bin/sh
set -eu

if [ -z "${NEXUS_TEST_POSTGRES_CONTAINER_ID:-}" ]; then
  echo "NEXUS_TEST_POSTGRES_CONTAINER_ID must identify the isolated PostgreSQL service container." >&2
  exit 2
fi

database_package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
migration_dir="$database_package_dir/migrations"
migration_count=$(find "$migration_dir" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')
if [ "$migration_count" -ne 8 ]; then
  echo "Expected migrations 00001 through 00008 in the fresh test database; found $migration_count." >&2
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
# Fase 2 (G7): a verificação da 00005 reaplica a migration para provar idempotência com
# PostgreSQL real. O arquivo é copiado para o container porque o `\i` do psql precisa de um
# caminho que exista dentro dele.
docker cp "$migration_dir/00005_assistant_seed_parity.sql" "$postgres_container_id":/tmp/00005_assistant_seed_parity.sql
# Fase 4: a 00006 também é reaplicada, porque `ON CONFLICT DO NOTHING` só é comprovadamente
# idempotente rodando duas vezes no banco real.
docker cp "$migration_dir/00006_assistant_seed_vivy.sql" "$postgres_container_id":/tmp/00006_assistant_seed_vivy.sql
echo "Verifying assistant seed parity and migrations 00005/00006 idempotency."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-assistant-seed-parity.sql"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/bootstrap.sql"
# `install_clean.sh` (l.305-309) concede ao provisionador o direito de ASSUMIR os papeis de runtime
# (`GRANT nexus_app TO nexus_migrator WITH SET TRUE`, sem herdar privilegios). O ambiente de teste
# precisa espelhar isso: sem a concessao, as provas negativas que fazem `SET LOCAL ROLE nexus_app`
# dentro de transacao nao rodam, e o verificador falharia por um motivo que nao existe em producao.
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -c "GRANT nexus_app TO nexus_migrator WITH SET TRUE;"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -c "GRANT nexus_anonymous TO nexus_migrator WITH SET TRUE;"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -U nexus_app -d nexus_test -f - < "$database_package_dir/tests/postgres/integration.sql"
# Fase 5 (G13): isolamento entre owners, append-only da auditoria e dominio de grants/preferencias.
# ORDEM IMPORTA: a exclusao do owner so e observavel como `postgres` (`nexus_app` tem apenas SELECT
# nessa tabela), vive em arquivo separado, roda em transacao com ROLLBACK e exige as tabelas da
# Fase 5 VAZIAS — por isso e executada ANTES de verify-stage-5-rls.sql, que deixa linhas.
# A declaracao da FK (`confdeltype`) ja e verificada no bloco M de verify-stage-5-rls.sql.
#
# O nome do arquivo diz o que ele comprova: `verify-stage-5-owner-deletion.sql` registra o
# COMPORTAMENTO HISTORICO da limitacao (SQLSTATE 42501 na policy de INSERT de `tombstones`) e
# prova a cascata das tabelas da Fase 5 num cenario em que ela e contornada. Ele NAO demonstra que
# excluir o owner funciona com dados presentes — quem demonstra isso e
# `verify-owner-deletion.sql`, depois da correcao da 00008.
echo "Verifying Phase 5 grant lifecycle, audit and enum ACL."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-grants-lifecycle.sql"
echo "Verifying Phase 5 assistant preferences display_label."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-preferences.sql"
echo "Verifying Phase 5 owner-deletion behavior and cascade."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-owner-deletion.sql"
echo "Verifying Phase 5 cascade with the DELETE policy removed."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql"
echo "Verifying Phase 5 tool grants and assistant preferences under RLS."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -U nexus_app -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-rls.sql"

# ---------------------------------------------------------------------------------------------
# EXCLUSAO DEFINITIVA DO OWNER — ultimo passo, de proposito.
# ---------------------------------------------------------------------------------------------
# Este verificador COMINTA a exclusao do owner (as demais secoes dele usam ROLLBACK, mas o estado
# pos-exclusao precisa ser medido fora da transacao). Depois dele NAO EXISTE mais owner no banco,
# entao ele precisa ser o ultimo arquivo do runner. Rodar antes faria todo verificador seguinte
# falhar por ausencia de dados, nao por defeito real.
#
# Roda como `nexus_migrator` (dono do schema, NOSUPERUSER, NOBYPASSRLS): o papel real de operacao.
echo "Verifying definitive owner deletion (migration 00008) — runs last, commits the deletion."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U nexus_migrator -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-owner-deletion.sql"

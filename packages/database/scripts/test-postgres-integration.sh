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

# =================================================================================================
# PAPEL DE MIGRACAO — `nexus_migrator`, nao `postgres`
# =================================================================================================
# As migrations rodam como o DONO do banco e do schema, exatamente como em producao
# (`install_clean.sh` cria o banco com `OWNER nexus_migrator` e aplica as migrations nesse papel).
#
# `nexus_migrator` e NOSUPERUSER e NOBYPASSRLS. Se as migrations rodassem como `postgres`, todas
# as tabelas nasceriam de um superusuario, e os verificadores de RLS passariam a exercitar um
# caminho que nao existe em producao: superusuario ignora RLS. Rodar como o papel real e o que
# torna as provas de isolamento significativas.
#
# O papel e criado pelo workflow (`.github/workflows/database-postgres.yml`, passo
# "Provision the migration role"). Se ele nao existir, o script falha imediatamente em vez de
# seguir com atribuicoes erradas.
if ! docker exec -i "$postgres_container_id" psql -X -w -tA -U postgres -d postgres \
     -c "SELECT 1 FROM pg_roles WHERE rolname = 'nexus_migrator'" | grep -qx 1; then
  echo "Role nexus_migrator is missing. The workflow must provision it before running this script." >&2
  exit 2
fi

# As migrations sao aplicadas com o CONTEXTO RLS de sessao, exatamente como em producao
# (`run_with_ctx` em `docs/r38/scripts/install_clean.sh:99`).
#
# Por que o contexto e obrigatorio: a 00001 liga `FORCE ROW LEVEL SECURITY` nas tabelas de owner.
# `FORCE` sujeita tambem o DONO da tabela a RLS — e `nexus_migrator` e o dono. Sem
# `nexus.owner_id`/`nexus.actor_type` definidos, qualquer INSERT do seed e do proprio DDL falha
# com "new row violates row-level security policy".
#
# Antes da correcao isso nao acontecia porque as migrations rodavam como `postgres`, que e
# SUPERUSER e portanto ignora RLS. Ou seja: o contexto nao estava "faltando por acaso" — ele
# estava sendo mascarado pelo superusuario. Fornecer o contexto e o que permite as migrations
# rodarem no papel real SEM afrouxar RLS nenhuma.
run_sql_as_migrator_with_context() {
  context_file=$1
  context_label=$2
  {
    printf "SELECT set_config('nexus.owner_id','%s',false);\n" "00000000-0000-4000-8000-000000000004"
    printf "SELECT set_config('nexus.actor_type','owner',false);\n"
    printf "\\\\set ON_ERROR_STOP on\n"
    cat "$context_file"
  } > /tmp/nexus_migration_ctx.sql
  docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 \
    -U nexus_migrator -d "${3:-nexus_test}" -f - < /tmp/nexus_migration_ctx.sql
  rm -f /tmp/nexus_migration_ctx.sql
}

apply_migrations_to() {
  target_database=$1
for migration_file in "$migration_dir"/*.sql; do
  migration_name=$(basename "$migration_file")
  if [ "$migration_name" = "00003_persistence_integrity.sql" ]; then
    echo "Seeding real Etapa 2A rows before the additive upgrade."
    run_sql_as_migrator_with_context "$database_package_dir/tests/postgres/legacy-stage-2a.sql" "legacy-stage-2a" "$target_database"
  fi
  # Antes da 00007: o novo dono da funcao de auditoria precisa de `CREATE` no schema onde o
  # objeto vive, senao `ALTER FUNCTION ... OWNER TO` falha com a mensagem enganosa
  # `permission denied for schema nexus`. Emitido pelo DONO do schema (`nexus_migrator`) e no
  # mesmo ponto do fluxo de producao (`install_clean.sh:283`). O schema so existe a partir da
  # 00001, portanto nao pode ser feito no provisionamento inicial.
  if [ "$migration_name" = "00007_tool_grants_and_preferences.sql" ]; then
    docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 \
      -U nexus_migrator -d "$target_database" -c "GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer;"
  fi
  echo "Applying $migration_name to isolated $target_database database."
  run_sql_as_migrator_with_context "$migration_file" "$migration_name" "$target_database"
  if [ "$migration_name" = "00003_persistence_integrity.sql" ]; then
    run_sql_as_migrator_with_context "$database_package_dir/tests/postgres/verify-stage-2b-migration.sql" "verify-stage-2b-migration" "$target_database"
  fi
done
}

apply_migrations_to nexus_test
# Fase 2 (G7): a verificação da 00005 reaplica a migration para provar idempotência com
# PostgreSQL real. O arquivo é copiado para o container porque o `\i` do psql precisa de um
# caminho que exista dentro dele.
docker cp "$migration_dir/00005_assistant_seed_parity.sql" "$postgres_container_id":/tmp/00005_assistant_seed_parity.sql
# Fase 4: a 00006 também é reaplicada, porque `ON CONFLICT DO NOTHING` só é comprovadamente
# idempotente rodando duas vezes no banco real.
docker cp "$migration_dir/00006_assistant_seed_vivy.sql" "$postgres_container_id":/tmp/00006_assistant_seed_vivy.sql
echo "Verifying assistant seed parity and migrations 00005/00006 idempotency."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U nexus_migrator -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-assistant-seed-parity.sql"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/bootstrap.sql"
# `install_clean.sh` (l.305-309) concede ao provisionador o direito de ASSUMIR os papeis de runtime
# (`GRANT nexus_app TO nexus_migrator WITH SET TRUE`, sem herdar privilegios). O ambiente de teste
# precisa espelhar isso: sem a concessao, as provas negativas que fazem `SET LOCAL ROLE nexus_app`
# dentro de transacao nao rodam, e o verificador falharia por um motivo que nao existe em producao.
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -c "GRANT nexus_app TO nexus_migrator WITH SET TRUE;"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -c "GRANT nexus_anonymous TO nexus_migrator WITH SET TRUE;"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -U nexus_app -d nexus_test -f - < "$database_package_dir/tests/postgres/integration.sql"
# Fase 5 (G13): isolamento entre owners, append-only da auditoria e dominio de grants/preferencias.
# ORDEM IMPORTA: a exclusao do owner NAO e alcancavel por `nexus_app` (que tem apenas SELECT em
# `owner_identity`), vive em arquivo separado, roda em transacao com ROLLBACK e exige as tabelas da
# Fase 5 VAZIAS — por isso e executada ANTES de verify-stage-5-rls.sql, que deixa linhas.
# A declaracao da FK (`confdeltype`) ja e verificada no bloco M de verify-stage-5-rls.sql.
#
# O que este arquivo comprova, depois da 00008: §3 exige que a exclusao do owner CONCLUA com
# dados presentes e confere o estado pos-exclusao (owner, mensagens, conversas, memorias e
# tombstones a zero; catalogo global intacto), tudo em transacao revertida. §4 isola a cascata das
# tabelas da Fase 5 com as tres tabelas de tombstone vazias.
#
# O que ele NAO comprova: que a exclusao PERSISTE. §3 termina em ROLLBACK e §4 tambem. A prova do
# estado final commitado vive em `verify-owner-deletion.sql`, que roda por ultimo e e o unico que
# comita a exclusao.
echo "Verifying Phase 5 grant lifecycle, audit and enum ACL."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U nexus_migrator -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-grants-lifecycle.sql"
echo "Verifying Phase 5 assistant preferences display_label."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U nexus_migrator -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-preferences.sql"
echo "Verifying Phase 5 owner-deletion behavior and cascade."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-owner-deletion.sql"
echo "Verifying Phase 5 cascade with the DELETE policy removed."
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U nexus_migrator -d nexus_test -f - < "$database_package_dir/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql"
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

# =================================================================================================
# RESTAURACAO DO ESTADO OPERACIONAL PARA O RESTANTE DO JOB — `nexus_test`
# =================================================================================================
# O verificador acima COMINTOU a exclusao do owner, entao `nexus_test` termina, de proposito, sem
# owner. Este script e apenas o QUARTO passo do job `postgres-integration`; depois dele o job roda
# vitest sobre `pool.integration.test.ts`, `repositories.integration.test.ts`, core engine,
# cancellation e auth store. Esses testes abrem transacao com
# `ownerId = 00000000-0000-4000-8000-000000000004` e esperam ENCONTRAR o owner.
#
# Contra o estado pos-verificador eles falhavam — nao por defeito de RLS, mas porque o banco de
# teste tinha sido esvaziado de proposito pelo proprio runner. Foi exatamente esse o estado que
# derrubou o step "Test repositories against isolated PostgreSQL" no CI.
#
# A correcao NAO e pular a exclusao (isso removeria a prova mais importante da Fase 5): o runner
# recria `nexus_test` do zero, no estado operacional, depois de concluir todas as provas. A
# recriacao reusa `apply_migrations_to`, o mesmo codigo que os verificadores ja exercitaram, entao
# o estado entregue ao job e o estado de producao — migrations aplicadas como `nexus_migrator`,
# bootstrap aplicado, ACLs conferidas. Nome, guardas de `current_database()` e isolamento do banco
# permanecem exatamente como estavam.
echo "Restoring the operational test database for the remaining job steps."

docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "DROP DATABASE IF EXISTS nexus_test;"
# `bootstrap.sql` exige que os papeis de runtime ainda NAO existam — a guarda impede aplicar as ACLs
# num cluster ja provisionado. Como papeis sao objetos de CLUSTER e o bootstrap os recria logo
# abaixo com os mesmos atributos, removemos apenas esses dois antes de reaplicar. `nexus_migrator`
# e `nexus_audit_writer` NAO sao tocados: eles carregam as migrations e a propriedade.
#
# A ordem importa: `DROP DATABASE nexus_test` acima leva junto o `GRANT CONNECT ON DATABASE
# nexus_test` que o `bootstrap.sql` concede (linha 72). Se o papel ainda tivesse privilegio em
# QUALQUER outro banco, o `DROP ROLE` falharia com "some objects depend on it" — situacao que nao
# ocorre neste cluster, que so recebe os bancos deste job. Preferimos falhar alto a seguir com o
# papel antigo: por isso nao usamos `DROP OWNED`/`REASSIGN`, que mexeriam em objetos de outros
# bancos. A conferencia abaixo torna o estado explicito em vez de presumido.
for runtime_role in nexus_app nexus_anonymous; do
  docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "DROP ROLE IF EXISTS $runtime_role;"
  remaining_role=$(docker exec -i "$postgres_container_id" psql -X -w -tA -U postgres -d postgres \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = '$runtime_role'")
  if [ "$remaining_role" != "0" ]; then
    echo "$runtime_role still exists after DROP ROLE; the restored database would inherit stale ACLs." >&2
    exit 2
  fi
done
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "CREATE DATABASE nexus_test OWNER nexus_migrator;"

apply_migrations_to nexus_test

docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test \
  -f - < "$database_package_dir/tests/postgres/bootstrap.sql"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test \
  -c "GRANT nexus_app TO nexus_migrator WITH SET TRUE;"
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -U postgres -d nexus_test \
  -c "GRANT nexus_anonymous TO nexus_migrator WITH SET TRUE;"

# `integration.sql` roda como `nexus_app` — o mesmo ponto do fluxo original — e instala o que os
# testes de servico esperam encontrar: a autorizacao explicita de provider que
# `repositories.integration.test.ts` exige para selecao manual de modelo. Sem ela, os dois testes
# de preferencia falham com "Manual provider preference requires an available, explicitly
# authorized provider and model". O arquivo tambem cobre as provas de RLS de `nexus_app`, entao
# executa-lo aqui mantem, no estado restaurado, exatamente o que o fluxo original comprovava.
docker exec -i "$postgres_container_id" psql -X -w -v ON_ERROR_STOP=1 -h 127.0.0.1 \
  -U nexus_app -d nexus_test -f - < "$database_package_dir/tests/postgres/integration.sql"

# Conferimos o EFEITO em vez de presumir que a restauracao funcionou: sem owner, ou sem `USAGE`
# de `nexus_app` no schema, o restante do job falharia por um motivo obscuro. Melhor falhar aqui,
# com mensagem clara, do que deixar o proximo passo reportar um erro enganoso.
restored_owner_count=$(docker exec -i "$postgres_container_id" psql -X -w -tA -U postgres -d nexus_test \
  -c "SELECT count(*) FROM nexus.owner_identity")
if [ "$restored_owner_count" != "1" ]; then
  echo "Restored nexus_test should contain exactly one owner, found $restored_owner_count." >&2
  exit 2
fi
restored_schema_usage=$(docker exec -i "$postgres_container_id" psql -X -w -tA -U postgres -d nexus_test \
  -c "SELECT has_schema_privilege('nexus_app', 'nexus', 'USAGE')")
if [ "$restored_schema_usage" != "t" ]; then
  echo "nexus_app cannot use schema nexus in the restored nexus_test; the remaining job steps cannot run." >&2
  exit 2
fi
echo "nexus_test restored: owner present, nexus_app has USAGE on schema nexus."

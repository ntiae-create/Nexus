#!/bin/bash
# Harness local: aplica migrations + verificadores num nexus_test limpo em PG 17.11.
# Segue a MESMA ordem de packages/database/scripts/test-postgres-integration.sh.
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
DBDIR=/home/user/Nexus/packages/database
HOST="-h 127.0.0.1 -p 55432"
FAILS=0

# -------------------------------------------------------------------------------------------------
# Limpeza escopada. `nexus_audit_writer`, `nexus_app` e `nexus_anonymous` sao papeis de CLUSTER:
# vivem fora do banco e podem ter dependencias em VARIOS bancos. A ordem correta e:
#   (1) dropar os bancos de teste (leva junto os objetos que dependem dos papeis);
#   (2) para cada banco restante, `DROP OWNED BY` — que so age no banco CORRENTE;
#   (3) so entao `DROP ROLE`, um por um, conferindo o resultado.
# Nada de `DROP OWNED` as cegas: o escopo e exatamente os papeis de teste, banco por banco.
# -------------------------------------------------------------------------------------------------
TEST_ROLES="nexus_app nexus_anonymous nexus_audit_writer prov_r35 prov_x writer_x"

echo "== limpando bancos de teste =="
for db in nexus_test nexus_prov_test probe_db; do
  $PSQL -X $HOST -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $db;" 2>&1 | grep -v "does not exist" 
done

echo "== limpando dependencias dos papeis, banco por banco =="
for r in $TEST_ROLES; do
  exists=$($PSQL -X $HOST -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$r';")
  [ "$exists" = "1" ] || continue
  for db in $($PSQL -X $HOST -U postgres -d postgres -tAc "SELECT datname FROM pg_database WHERE NOT datistemplate;"); do
    out=$($PSQL -X $HOST -U postgres -d "$db" -q -c "DROP OWNED BY $r CASCADE;" 2>&1)
    [ -n "$out" ] && echo "   [$db] DROP OWNED BY $r -> $out"
  done
  out=$($PSQL -X $HOST -U postgres -d postgres -c "DROP ROLE $r;" 2>&1)
  if [ $? -eq 0 ]; then
    echo "   papel $r removido"
  else
    echo "   PENDENTE: nao foi possivel remover $r"
    echo "   $out" | head -3
  fi
done

echo "== papeis remanescentes (deve ser vazio) =="
$PSQL -X $HOST -U postgres -d postgres -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname = ANY (string_to_array('$TEST_ROLES',' '));"

$PSQL -X $HOST -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS probe_db;" >/dev/null 2>&1
$PSQL -X $HOST -U postgres -d postgres -q -c "CREATE DATABASE nexus_test;" >/dev/null 2>&1
echo "== nexus_test recriado =="

run_file() {
  local label="$1" file="$2" role="${3:-super}"
  local out
  if [ "$role" = "app" ]; then
    out=$($PSQL -X -w -v ON_ERROR_STOP=1 $HOST -U nexus_app -d nexus_test -f - < "$file" 2>&1)
  else
    out=$($PSQL -X -w -v ON_ERROR_STOP=1 $HOST -U postgres -d nexus_test -f - < "$file" 2>&1)
  fi
  local rc=$?
  # NOTICEs NAO sao descartados: sao a evidencia das provas.
  echo "$out" | grep -E "NOTICE" | sed "s/^psql:<stdin>:[0-9]*: /  /"
  if [ $rc -eq 0 ]; then
    echo "OK: $label"
  else
    echo "FALHOU: $label"
    echo "$out" | grep -E "ERROR|DETAIL|HINT|CONTEXT" | head -12
    FAILS=$((FAILS+1))
  fi
}

# migrations, na ordem oficial: legacy-stage-2a antes da 00003, verify-stage-2b depois.
n=0
for f in "$DBDIR"/migrations/*.sql; do
  n=$((n+1))
  base=$(basename "$f")
  if [ "$base" = "00003_persistence_integrity.sql" ]; then
    run_file "legacy-stage-2a" "$DBDIR/tests/postgres/legacy-stage-2a.sql"
  fi
  run_file "migration $base" "$f"
  if [ "$base" = "00003_persistence_integrity.sql" ]; then
    run_file "verify-stage-2b" "$DBDIR/tests/postgres/verify-stage-2b-migration.sql"
  fi
done
echo "== migrations: $n =="

cp "$DBDIR"/migrations/*.sql /tmp/
run_file "verify-assistant-seed-parity" "$DBDIR/tests/postgres/verify-assistant-seed-parity.sql"
run_file "bootstrap.sql" "$DBDIR/tests/postgres/bootstrap.sql"
run_file "integration.sql (nexus_app)" "$DBDIR/tests/postgres/integration.sql" app

[ "${SKIP_P5:-0}" = "1" ] && { echo "== SKIP_P5=1 =="; exit $([ $FAILS -eq 0 ] && echo 0 || echo 1); }

run_file "verify-stage-5-grants-lifecycle.sql (postgres)" "$DBDIR/tests/postgres/verify-stage-5-grants-lifecycle.sql"
run_file "verify-stage-5-preferences.sql (postgres)" "$DBDIR/tests/postgres/verify-stage-5-preferences.sql"
run_file "verify-stage-5-owner-deletion.sql (postgres)" "$DBDIR/tests/postgres/verify-stage-5-owner-deletion.sql"
run_file "verify-stage-5-cascade-without-delete-policy.sql (postgres)" "$DBDIR/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql"
run_file "verify-stage-5-rls.sql (nexus_app)" "$DBDIR/tests/postgres/verify-stage-5-rls.sql" app

echo
if [ $FAILS -eq 0 ]; then echo "== OK: todos os verificadores SQL passaram =="; else echo "== $FAILS falha(s) =="; fi
exit $([ $FAILS -eq 0 ] && echo 0 || echo 1)

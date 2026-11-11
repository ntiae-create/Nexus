#!/bin/bash
# =================================================================================================
# R35 item 2 — Papel PREEXISTENTE inseguro: a 00007 deve FALHAR com diagnostico claro.
#
# Um `nexus_audit_writer` pode ja existir (criado a mao, por um provisionamento antigo, ou
# comprometido). A migration NAO pode presumir que ele e seguro. Cada cenario abaixo cria o papel
# com um desvio e verifica que a 00007 aborta, sem "consertar" atributos privilegiados sozinha.
# =================================================================================================
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
HOST="-h 127.0.0.1 -p 55432"
DB=nexus_preexist_test
DBDIR=/home/user/Nexus/packages/database
MIG="$DBDIR/migrations/00007_tool_grants_and_preferences.sql"
FAILS=0

say() { printf '%s\n' "$*"; }
ok()  { printf '   OK   %s\n' "$*"; }
bad() { printf '   FALHA %s\n' "$*"; FAILS=$((FAILS+1)); }

# baseline + limpeza
$PSQL -X $HOST -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1
for r in nexus_anonymous nexus_audit_writer; do
  for db in $($PSQL -X $HOST -U postgres -d postgres -tAc "SELECT datname FROM pg_database WHERE NOT datistemplate;"); do
    $PSQL -X $HOST -U postgres -d "$db" -q -c "DROP OWNED BY $r CASCADE;" >/dev/null 2>&1
  done
  $PSQL -X $HOST -U postgres -d postgres -q -c "DROP ROLE IF EXISTS $r;" >/dev/null 2>&1
done
$PSQL -X $HOST -U postgres -d postgres -q -c "CREATE DATABASE $DB;" >/dev/null 2>&1
for f in "$DBDIR"/migrations/*.sql; do
  case "$(basename "$f")" in 00007_*) continue ;; esac
  [ "$(basename "$f")" = "00003_persistence_integrity.sql" ] && \
    $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$DBDIR/tests/postgres/legacy-stage-2a.sql" >/dev/null 2>&1
  $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1
done
say "== baseline pronta =="

# `nexus_app` e `nexus_anonymous` sao criados pelo bootstrap oficial, que aqui nao roda.
# O cenario de escalada indireta precisa de nexus_app existindo.
if [ "$($PSQL -X $HOST -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='nexus_app';")" != "1" ]; then
  $PSQL -X $HOST -U postgres -d postgres -q -c \
    "CREATE ROLE nexus_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;" >/dev/null 2>&1
fi

# -------------------------------------------------------------------------------------------------
# Cada cenario: (nome, comando que cria o papel inseguro, trecho esperado no erro)
# -------------------------------------------------------------------------------------------------
check_scenario() {
  local name="$1" create_sql="$2" expect="$3"

  drop_role_completely
  recreate_db
  $PSQL -X $HOST -U postgres -d postgres -q -c "$create_sql" >/dev/null 2>&1

  local out rc
  out=$($PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$MIG" 2>&1)
  rc=$?

  if [ $rc -eq 0 ]; then
    bad "$name: migration NAO falhou (deveria abortar)"
    drop_role_completely
    return
  fi

  if echo "$out" | grep -qF "$expect"; then
    ok "$name: abortou com diagnostico"
    echo "$out" | grep -E "ERROR|DETAIL" | head -2 | sed 's/^/        /'
  else
    bad "$name: abortou, mas sem o diagnostico esperado ('$expect')"
    echo "$out" | grep -E "ERROR|DETAIL" | head -3 | sed 's/^/        /'
  fi

  drop_role_completely
}

recreate_db() {
  $PSQL -X $HOST -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1
  $PSQL -X $HOST -U postgres -d postgres -q -c "CREATE DATABASE $DB;" >/dev/null 2>&1
  for f in "$DBDIR"/migrations/*.sql; do
    case "$(basename "$f")" in 00007_*) continue ;; esac
    [ "$(basename "$f")" = "00003_persistence_integrity.sql" ] && \
      $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$DBDIR/tests/postgres/legacy-stage-2a.sql" >/dev/null 2>&1
    $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1
  done
}

# A 00007 NAO e reentrante (CREATE TYPE nao tem IF NOT EXISTS): cada cenario precisa de banco novo.
# Limpeza escopada central: identifica bancos com dependencias antes de agir.
drop_role_completely() {
  /tmp/pg_cleanup.sh nexus_audit_writer >/dev/null 2>&1
}

say "== cenarios de papel preexistente inseguro =="
check_scenario "SUPERUSER" "CREATE ROLE nexus_audit_writer NOLOGIN SUPERUSER" "unsafe attributes"
check_scenario "BYPASSRLS" "CREATE ROLE nexus_audit_writer NOLOGIN BYPASSRLS" "unsafe attributes"
check_scenario "LOGIN"      "CREATE ROLE nexus_audit_writer LOGIN NOSUPERUSER" "unsafe attributes"
check_scenario "CREATEDB"   "CREATE ROLE nexus_audit_writer NOLOGIN CREATEDB" "unsafe attributes"
check_scenario "CREATEROLE" "CREATE ROLE nexus_audit_writer NOLOGIN CREATEROLE" "unsafe attributes"

# Membership perigosa: o escritor herda de nexus_app (ou de pg_read_all_data).
say "== memberships perigosas do escritor =="
drop_role_completely
recreate_db
$PSQL -X $HOST -U postgres -d postgres -q -c "CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;" >/dev/null 2>&1
$PSQL -X $HOST -U postgres -d postgres -q -c "GRANT pg_read_all_data TO nexus_audit_writer;" >/dev/null 2>&1
out=$($PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$MIG" 2>&1); rc=$?
# A migration REMOVE memberships (REVOKE) — isso e correcao segura e autorizada para memberships.
if [ $rc -eq 0 ]; then
  left=$($PSQL -X $HOST -U postgres -d postgres -tAc \
    "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
     WHERE r.rolname='nexus_audit_writer';")
  [ "$left" = "0" ] && ok "membership herdada (pg_read_all_data) removida pela migration" \
                     || bad "membership residual: $left"
else
  bad "migration falhou ao tratar membership herdada"; echo "$out" | grep ERROR | head -2 | sed 's/^/        /'
fi

# nexus_app como membro do escritor: escalada de privilegio.
drop_role_completely
recreate_db
$PSQL -X $HOST -U postgres -d postgres -q -c "CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS;" >/dev/null 2>&1
$PSQL -X $HOST -U postgres -d postgres -q -c "GRANT nexus_audit_writer TO nexus_app;" >/dev/null 2>&1
out=$($PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$MIG" 2>&1); rc=$?
if [ $rc -eq 0 ]; then
  chk=$($PSQL -X $HOST -U postgres -d postgres -tAc "SELECT pg_has_role('nexus_app','nexus_audit_writer','MEMBER')::text;")
  [ "$chk" = "false" ] && ok "nexus_app removido da membresia do escritor" || bad "nexus_app ainda assume o escritor"
else
  bad "migration falhou"; echo "$out" | grep ERROR | head -2 | sed 's/^/        /'
fi

# Papel seguro preexistente: deve passar normalmente (idempotencia).
say "== papel preexistente SEGURO (deve passar) =="
drop_role_completely
recreate_db
$PSQL -X $HOST -U postgres -d postgres -q -c "CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;" >/dev/null 2>&1
if $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$MIG" >/tmp/pre_ok.log 2>&1; then
  ok "papel preexistente seguro: migration aplicada"
else
  bad "migration falhou para papel seguro"; grep -E "ERROR|DETAIL" /tmp/pre_ok.log | head -3 | sed 's/^/        /'
fi

echo
if [ $FAILS -eq 0 ]; then say "== PAPEL PREEXISTENTE: TODOS OS CENARIOS PASSARAM =="; exit 0
else say "== $FAILS FALHA(S) =="; exit 1; fi

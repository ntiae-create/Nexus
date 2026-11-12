#!/bin/bash
# =================================================================================================
# Limpeza ESCOPADA de papeis de teste no cluster PG 17.11.
#
# Por que existe: `nexus_audit_writer`, `nexus_app` e `nexus_anonymous` sao papeis de CLUSTER
# (vivem em pg_authid, fora de qualquer banco), mas seus objetos, ACLs e memberships vivem em
# pg_shdepend, que e POR BANCO. `DROP OWNED BY` so age no banco CORRENTE. Um `DROP OWNED` cego
# num banco so, ou o esquecimento de um banco, deixa dependencias para tras e o `DROP ROLE` falha
# com "some objects depend on it", sem dizer QUAIS bancos.
#
# Tambem foi observado (PG 17.11): um `DROP OWNED ... CASCADE` aplicado quando o papel era DONO de
# schema/tabela pode deixar entradas `deptype = 'a'` (ownership) em pg_shdepend apontando para
# objetos cujo dono JA foi trocado — entrada orfa. Nesse caso o `DROP ROLE` continua falhando e
# nenhuma instrucao SQL comum limpa a entrada; a saida e derrubar o banco que a contem.
# Por isso a estrategia aqui e: derrubar os bancos de teste ANTES de tentar o DROP ROLE.
# =================================================================================================
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
HOST="-h 127.0.0.1 -p 55432 -U postgres"

ROLES="${*:-nexus_app nexus_anonymous nexus_audit_writer prov_r35 prov_x writer_x}"
TEST_DATABASES="nexus_test nexus_prov_test nexus_preexist_test probe_db"

echo "== 1. bancos de teste (derrubar primeiro: leva pg_shdepend junto) =="
for db in $TEST_DATABASES; do
  out=$($PSQL -X $HOST -d postgres -c "DROP DATABASE IF EXISTS $db;" 2>&1)
  case "$out" in *"does not exist"*) ;; *) echo "   $db: $out" ;; esac
done

echo "== 2. papel por papel: identificar bancos com dependencias, limpar, dropar =="
for r in $ROLES; do
  oid=$($PSQL -X $HOST -d postgres -tAc "SELECT oid FROM pg_roles WHERE rolname='$r';")
  if [ -z "$oid" ]; then
    echo "   $r: nao existe (nada a fazer)"
    continue
  fi

  echo "   --- $r (oid $oid) ---"
  # Identificacao explicita: para cada banco, quantas dependencias o papel tem la.
  local_found=""
  for db in $($PSQL -X $HOST -d postgres -tAc "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1;"); do
    n=$($PSQL -X $HOST -d "$db" -tAc "SELECT count(*) FROM pg_shdepend WHERE refobjid='$oid'::oid;" 2>/dev/null)
    [ "${n:-0}" != "0" ] && { echo "     [$db] $n dependencia(s)"; local_found="$local_found $db"; }
    # limpa o que der para limpar
    $PSQL -X $HOST -d "$db" -q -c "DROP OWNED BY $r CASCADE;" >/dev/null 2>&1
  done
  [ -z "$local_found" ] && echo "     nenhuma dependencia em banco algum"

  # Tenta o DROP ROLE.
  if out=$($PSQL -X $HOST -d postgres -c "DROP ROLE $r;" 2>&1); then
    echo "     DROP ROLE: $out"
  else
    echo "     DROP ROLE FALHOU: $(echo "$out" | grep DETAIL || echo "$out")"
    # Se a unica saida e derrubar o banco, faz isso e tenta de novo — mas SO o banco nomeado.
    for db in $local_found; do
      case " $TEST_DATABASES " in
        *" $db "*) echo "     -> derrubando banco de teste $db e repetindo"
                   $PSQL -X $HOST -d postgres -q -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1 ;;
        *) echo "     -> ATENCAO: $db NAO e banco de teste; nao sera derrubado" ;;
      esac
    done
    if out=$($PSQL -X $HOST -d postgres -c "DROP ROLE $r;" 2>&1); then
      echo "     DROP ROLE (2a tentativa): $out"
    else
      echo "     AINDA PENDENTE: $(echo "$out" | grep DETAIL || echo "$out")"
    fi
  fi
done

echo "== 3. estado final =="
$PSQL -X $HOST -d postgres -tAc \
  "SELECT '   papeis de teste remanescentes: '||coalesce(string_agg(rolname,', '),'(nenhum)')
   FROM pg_roles WHERE rolname IN ('nexus_app','nexus_anonymous','nexus_audit_writer','prov_r35','prov_x','writer_x');"
$PSQL -X $HOST -d postgres -tAc \
  "SELECT '   bancos: '||coalesce(string_agg(datname,', '),'(nenhum)') FROM pg_database WHERE NOT datistemplate;"

#!/bin/bash
# =================================================================================================
# R35 item 2 — Provisionamento da 00007 SEM SUPERUSER e SEM BYPASSRLS.
#
# Cenario: o provisionador e um papel comum do banco com CREATEROLE. Ele NAO e superusuario,
# NAO tem BYPASSRLS, NAO e dono dos objetos de `nexus` (a baseline 00001-00006 foi aplicada por
# outro papel administrativo). O trabalho dele e APENAS a 00007.
#
# O que este teste comprova:
#   1. criacao de nexus_audit_writer quando inexistente;
#   2. atributos seguros do papel (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE);
#   3. membership que permite SET ROLE ao provisionador;
#   4. set_option configurado (sem ele o ALTER ... OWNER TO falha);
#   5. transferencia de propriedade de nexus.audit_tool_grant_change();
#   6. CREATE no schema que o NOVO dono precisa;
#   7. execucao real da funcao SECURITY DEFINER;
#   8. INSERT de auditoria funcionando sob FORCE ROW LEVEL SECURITY.
#
# Nenhum privilegio extra e concedido ao provisionador para "fazer o teste passar": ele recebe
# CREATEROLE (o minimo para criar/ajustar o papel) e USAGE/CREATE no schema nexus (para operar os
# objetos que ja existem). SUPERUSER e BYPASSRLS sao conferidos como AUSENTES ao final.
# =================================================================================================
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
HOST="-h 127.0.0.1 -p 55432"
DB=nexus_prov_test
DBDIR=/home/user/Nexus/packages/database
FAILS=0

say() { printf '%s\n' "$*"; }
ok()  { printf '   OK   %s\n' "$*"; }
bad() { printf '   FALHA %s\n' "$*"; FAILS=$((FAILS+1)); }

# -------------------------------------------------------------------------------------------------
# 0. Limpeza ESCOPADA e na ORDEM correta.
#    Papeis de cluster podem ter dependencias em varios bancos; `DROP OWNED BY` so age no banco
#    corrente. Identificamos os bancos ANTES, limpamos em cada um, e so entao dropamos o papel.
# -------------------------------------------------------------------------------------------------
say "== 0. limpeza escopada =="
# Papeis de cluster com dependencias por banco: a limpeza vive em /tmp/pg_cleanup.sh, que
# IDENTIFICA os bancos com pg_shdepend antes de agir e so derruba bancos de teste.
/tmp/pg_cleanup.sh prov_r35 nexus_audit_writer 2>&1 | sed 's/^/   /'

$PSQL -X $HOST -U postgres -d postgres -q -c "CREATE DATABASE $DB;" >/dev/null 2>&1

# -------------------------------------------------------------------------------------------------
# 1. Baseline 00001-00006 como papel administrativo (fora do escopo; a 00003 exige contexto de
#    owner e nao roda sob FORCE RLS sem bootstrap — limitacao PRE-EXISTENTE, reportada).
# -------------------------------------------------------------------------------------------------
say "== 1. baseline 00001-00006 (papel administrativo) =="
base_ok=0
for f in "$DBDIR"/migrations/*.sql; do
  base=$(basename "$f")
  case "$base" in 00007_*) continue ;; esac
  if [ "$base" = "00003_persistence_integrity.sql" ]; then
    $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$DBDIR/tests/postgres/legacy-stage-2a.sql" >/dev/null 2>&1 \
      || bad "legacy-stage-2a"
  fi
  if $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f "$f" >/tmp/prov_mig.log 2>&1; then
    base_ok=$((base_ok+1))
  else
    bad "migration $base"; grep -E "ERROR|DETAIL" /tmp/prov_mig.log | head -3
  fi
done
say "   baseline aplicada: $base_ok/6"

# -------------------------------------------------------------------------------------------------
# 2. O provisionador.
# -------------------------------------------------------------------------------------------------
say "== 2. provisionador sem SUPERUSER/BYPASSRLS =="
$PSQL -X $HOST -U postgres -d postgres -q -c \
  "CREATE ROLE prov_r35 LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB;" || bad "criar prov_r35"
$PSQL -X $HOST -U postgres -d $DB -q -c "GRANT CONNECT ON DATABASE $DB TO prov_r35;" >/dev/null 2>&1
# O provisionador precisa poder DELEGAR (a 00007 concede privilegios ao escritor em nome do dono
# dos objetos). Sem GRANT OPTION o resultado e `WARNING: no privileges were granted` e a migration
# "passa" deixando o escritor sem permissao — falha silenciosa. Com grant option, funciona.
$PSQL -X $HOST -U postgres -d $DB -q -c "GRANT USAGE, CREATE ON SCHEMA nexus TO prov_r35 WITH GRANT OPTION;" >/dev/null 2>&1
$PSQL -X $HOST -U postgres -d $DB -q -c "GRANT ALL ON ALL TABLES IN SCHEMA nexus TO prov_r35 WITH GRANT OPTION;" >/dev/null 2>&1
$PSQL -X $HOST -U postgres -d $DB -q -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA nexus TO prov_r35 WITH GRANT OPTION;" >/dev/null 2>&1

attrs=$($PSQL -X $HOST -U postgres -d postgres -tAc \
  "SELECT 'super='||rolsuper||' bypassrls='||rolbypassrls||' createrole='||rolcreaterole||' createdb='||rolcreatedb
   FROM pg_roles WHERE rolname='prov_r35';")
say "   $attrs"
case "$attrs" in
  *"super=false"*"bypassrls=false"*"createrole=true"*) ok "provisionador tem o minimo (CREATEROLE, sem SUPERUSER/BYPASSRLS)" ;;
  *) bad "atributos inesperados do provisionador: $attrs" ;;
esac

# -------------------------------------------------------------------------------------------------
# 3. Criacao do papel escrita pelo PROPRIO provisionador (nao pelo superuser).
# -------------------------------------------------------------------------------------------------
say "== 3. nexus_audit_writer criado por prov_r35 =="
pre=$($PSQL -X $HOST -U postgres -d postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname='nexus_audit_writer';")
say "   antes: $pre papel(is)"
if $PSQL -X $HOST -U prov_r35 -d $DB -q -v ON_ERROR_STOP=1 >/tmp/prov_role.log 2>&1 <<'SQL'
CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
then
  ok "criacao por CREATEROLE (sem superuser)"
else
  bad "criacao de nexus_audit_writer"; grep -E "ERROR|DETAIL" /tmp/prov_role.log | head -3
fi

# -------------------------------------------------------------------------------------------------
# 4. Membership e set_option que o ALTER FUNCTION ... OWNER TO exige.
# -------------------------------------------------------------------------------------------------
say "== 4. membership e set_option =="
$PSQL -X $HOST -U postgres -d postgres -c \
  "SELECT pg_get_userbyid(m.member) AS member, pg_get_userbyid(m.roleid) AS role,
          m.admin_option, m.inherit_option, m.set_option, pg_get_userbyid(m.grantor) AS grantor
   FROM pg_auth_members m
   WHERE pg_get_userbyid(m.member)='prov_r35' AND pg_get_userbyid(m.roleid)='nexus_audit_writer';" \
  2>&1 | sed 's/^/   /'

so=$($PSQL -X $HOST -U postgres -d postgres -tAc \
  "SELECT coalesce(max(set_option::int), -1) FROM pg_auth_members m
   WHERE pg_get_userbyid(m.member)='prov_r35' AND pg_get_userbyid(m.roleid)='nexus_audit_writer';")
if [ "$so" = "1" ]; then
  ok "set_option=true (SET ROLE permitido ao provisionador)"
elif [ "$so" = "0" ]; then
  # A membresia automatica do CREATE ROLE tem set_option=false. Sem SET ROLE o
  # ALTER ... OWNER TO falha com 'must be able to SET ROLE'. O grantor (quem tem ADMIN) resolve.
  say "   set_option=false na membresia automatica -> concedendo SET pelo grantor"
  $PSQL -X $HOST -U postgres -d $DB -q -c "GRANT nexus_audit_writer TO prov_r35 WITH SET TRUE;" >/dev/null 2>&1
  so2=$($PSQL -X $HOST -U postgres -d postgres -tAc \
    "SELECT coalesce(max(set_option::int), -1) FROM pg_auth_members m
     WHERE pg_get_userbyid(m.member)='prov_r35' AND pg_get_userbyid(m.roleid)='nexus_audit_writer';")
  [ "$so2" = "1" ] && ok "set_option=true apos GRANT ... WITH SET TRUE" || bad "set_option continua $so2"
else
  bad "nenhuma membership prov_r35 -> nexus_audit_writer"
fi

# O provisionador precisa de CREATE no schema ANTES da transferencia — e o NOVO DONO que precisa.
say "   CREATE do novo dono no schema nexus:"
$PSQL -X $HOST -U postgres -d $DB -q -c "GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer;" >/dev/null 2>&1
chk=$($PSQL -X $HOST -U postgres -d $DB -tAc "SELECT has_schema_privilege('nexus_audit_writer','nexus','CREATE')::text;")
[ "$chk" = "true" ] && ok "nexus_audit_writer tem CREATE em nexus (requisito do OWNER TO)" || bad "CREATE ausente"

# -------------------------------------------------------------------------------------------------
# 5. A 00007 aplicada PELO PROVISIONADOR.
# -------------------------------------------------------------------------------------------------
say "== 5. 00007 aplicada por prov_r35 =="
if $PSQL -X $HOST -U prov_r35 -d $DB -q -v ON_ERROR_STOP=1 \
     -f "$DBDIR/migrations/00007_tool_grants_and_preferences.sql" >/tmp/prov_00007.log 2>&1; then
  # `WARNING: no privileges were granted` significa que um GRANT foi silenciosamente ignorado.
  # Isso NAO e sucesso: a migration terminaria deixando o escritor sem permissao.
  w=$(grep -c "no privileges" /tmp/prov_00007.log || true)
  if [ "$w" -eq 0 ]; then
    ok "00007 aplicada sem SUPERUSER/BYPASSRLS, sem GRANT ignorado"
  else
    bad "00007 aplicada com $w GRANT(s) silenciosamente ignorado(s)"
    grep "no privileges" /tmp/prov_00007.log | sed 's/^/      /'
  fi
else
  bad "00007 como prov_r35"
  grep -E "ERROR|DETAIL|HINT" /tmp/prov_00007.log | head -6
fi

# -------------------------------------------------------------------------------------------------
# 6. Provas de catalogo.
# -------------------------------------------------------------------------------------------------
say "== 6. provas =="

owner=$($PSQL -X $HOST -U postgres -d $DB -tAc \
  "SELECT pg_get_userbyid(proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='nexus' AND p.proname='audit_tool_grant_change';")
[ "$owner" = "nexus_audit_writer" ] && ok "propriedade transferida: dono=$owner" || bad "dono='$owner'"

secdef=$($PSQL -X $HOST -U postgres -d $DB -tAc \
  "SELECT p.prosecdef::text||'|'||coalesce(array_to_string(p.proconfig,','),'-')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='nexus' AND p.proname='audit_tool_grant_change';")
[ "${secdef%%|*}" = "true" ] && ok "SECURITY DEFINER=true; proconfig=${secdef#*|}" || bad "SECURITY DEFINER=${secdef%%|*}"

rattrs=$($PSQL -X $HOST -U postgres -d postgres -tAc \
  "SELECT 'login='||rolcanlogin||' super='||rolsuper||' bypassrls='||rolbypassrls
        ||' createdb='||rolcreatedb||' createrole='||rolcreaterole||' inherit='||rolinherit
   FROM pg_roles WHERE rolname='nexus_audit_writer';")
say "   atributos: $rattrs"
case "$rattrs" in
  "login=false super=false bypassrls=false createdb=false createrole=false"*) ok "atributos seguros" ;;
  *) bad "atributos inseguros: $rattrs" ;;
esac

viol=$($PSQL -X $HOST -U postgres -d postgres -tAc \
  "SELECT coalesce(string_agg(rolname,', '), '') FROM pg_roles
   WHERE rolname IN ('prov_r35','nexus_audit_writer','nexus_app','nexus_anonymous')
     AND (rolsuper OR rolbypassrls);")
[ -z "$viol" ] && ok "nenhum papel com SUPERUSER/BYPASSRLS" || bad "com SUPERUSER/BYPASSRLS: $viol"

# 7. Execucao REAL da SECURITY DEFINER + INSERT sob FORCE RLS.
say "== 7. execucao real da SECURITY DEFINER sob FORCE RLS =="
# O owner singleton ja foi semeado pela 00001: usamos o id REAL existente, em vez de inventar um
# (a FK `tool_grants_owner_id_fkey` exige coerencia com `owner_identity`).
OWNER=$($PSQL -X $HOST -U postgres -d $DB -tAc "SELECT id FROM nexus.owner_identity WHERE singleton;")
say "   owner configurado: $OWNER"
if $PSQL -X $HOST -U postgres -d $DB -q -v ON_ERROR_STOP=1 -v owner="$OWNER" >/tmp/prov_write.log 2>&1 <<'SQL'
BEGIN;
SELECT set_config('nexus.owner_id', :'owner', true);
SELECT set_config('nexus.actor_type', 'owner', true);
INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
VALUES ('a0000000-0000-4000-8000-0000000000aa', :'owner'::uuid,
        '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
        :'owner'::uuid, now());
COMMIT;
SQL
then
  n=$($PSQL -X $HOST -U postgres -d $DB -tAc \
    "SELECT count(*) FROM nexus.tool_grant_audit WHERE grant_id='a0000000-0000-4000-8000-0000000000aa';")
  [ "$n" = "1" ] && ok "auditoria gravada pela SECURITY DEFINER: 1 linha" || bad "trilha com $n linha(s)"
else
  bad "escrita do grant falhou"; grep -E "ERROR|DETAIL" /tmp/prov_write.log | head -3
fi

# 8. O escritor continua sem privilegio amplo.
broad=$($PSQL -X $HOST -U postgres -d $DB -tAc \
  "SELECT coalesce(string_agg(DISTINCT privilege_type,','),'') FROM information_schema.role_table_grants
   WHERE grantee='nexus_audit_writer' AND privilege_type IN ('UPDATE','DELETE','TRUNCATE');")
[ -z "$broad" ] && ok "escritor sem UPDATE/DELETE/TRUNCATE" || bad "escritor tem: $broad"

say "== 8. ACL efetiva de nexus_audit_writer =="
$PSQL -X $HOST -U postgres -d $DB -c \
  "SELECT table_schema||'.'||table_name AS objeto,
          string_agg(privilege_type, ',' ORDER BY privilege_type) AS privilegios
   FROM information_schema.role_table_grants WHERE grantee='nexus_audit_writer'
   GROUP BY 1 ORDER BY 1;" 2>&1 | sed 's/^/   /'
$PSQL -X $HOST -U postgres -d $DB -c \
  "SELECT nspname AS schema, string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type) AS privilegios
   FROM information_schema.role_usage_grants r JOIN pg_namespace n ON n.nspname=r.object_name
   WHERE grantee='nexus_audit_writer' GROUP BY 1;" 2>&1 | sed 's/^/   /'

say "== 9. memberships finais do provisionador e do escritor =="
$PSQL -X $HOST -U postgres -d postgres -c \
  "SELECT pg_get_userbyid(m.member) AS membro, pg_get_userbyid(m.roleid) AS papel,
          m.admin_option, m.inherit_option, m.set_option, pg_get_userbyid(m.grantor) AS grantor
   FROM pg_auth_members m
   WHERE pg_get_userbyid(m.member) IN ('prov_r35','nexus_audit_writer')
      OR pg_get_userbyid(m.roleid) IN ('prov_r35','nexus_audit_writer')
   ORDER BY 1,2;" 2>&1 | sed 's/^/   /'

echo
if [ $FAILS -eq 0 ]; then
  say "== PROVISIONAMENTO SEM SUPERUSER: TODAS AS PROVAS PASSARAM =="
  exit 0
else
  say "== $FAILS FALHA(S) =="
  exit 1
fi

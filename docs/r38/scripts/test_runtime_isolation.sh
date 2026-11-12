#!/bin/bash
# =================================================================================================
# R36 — ISOLAMENTO DO RUNTIME.
#
# Banco `nexus_test` ja instalado por /tmp/install_clean.sh. Aqui a conexao e SEMPRE como
# `nexus_app` — a mesma credencial que o servidor Fastify usa via NEXUS_DATABASE_URL.
# =================================================================================================
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
H="-h 127.0.0.1 -p 55432"
DB=nexus_test
OWNER=00000000-0000-4000-8000-000000000004
FAILS=0

say() { printf '%s\n' "$*"; }
ok()  { printf '   OK    %s\n' "$*"; }
bad() { printf '   FALHA %s\n' "$*"; FAILS=$((FAILS+1)); }

as_app() { $PSQL -X $H -U nexus_app -d $DB -tAq -c "$1" 2>&1; }

echo "================================================================================="
echo " 1. IDENTIDADE E ATRIBUTOS DE nexus_app"
echo "================================================================================="
ID=$(as_app "SELECT current_user||'|'||session_user;")
say "   conexao: $ID"
case "$ID" in nexus_app\|nexus_app) ok "conectado como nexus_app" ;;
  *) bad "current_user inesperado: $ID" ;; esac

$PSQL -X $H -U postgres -d postgres -c "
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit
FROM pg_roles WHERE rolname='nexus_app';" 2>&1 | sed 's/^/   /'

SUP=$(as_app "SELECT rolsuper FROM pg_roles WHERE rolname=current_user;")
BYP=$(as_app "SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;")
[ "$SUP" = "f" ] && ok "NOSUPERUSER" || bad "nexus_app e SUPERUSER"
[ "$BYP" = "f" ] && ok "NOBYPASSRLS" || bad "nexus_app tem BYPASSRLS"

echo
echo "================================================================================="
echo " 2. NAO PODE ASSUMIR nexus_audit_writer"
echo "================================================================================="
MEM=$(as_app "SELECT pg_has_role('nexus_app','nexus_audit_writer','MEMBER')::text;")
[ "$MEM" = "false" ] && ok "pg_has_role(nexus_app, writer, MEMBER) = false" || bad "nexus_app e membro do escritor"

out=$(as_app "SET ROLE nexus_audit_writer;" 2>&1)
case "$out" in
  *"permission denied"*|*"must be able"*) ok "SET ROLE nexus_audit_writer recusado: $(echo "$out" | head -1)" ;;
  *) bad "SET ROLE aceito: $out" ;;
esac

EXEC=$(as_app "SELECT has_function_privilege('nexus.audit_tool_grant_change()','EXECUTE')::text;")
[ "$EXEC" = "false" ] && ok "nao executa a SECURITY DEFINER diretamente" || bad "executa a SECURITY DEFINER"

echo
echo "================================================================================="
echo " 3. NAO PODE FAZER DDL NEM ADMINISTRAR ROLES"
echo "================================================================================="
ddl_case() {
  local label="$1" sql="$2"
  local out
  out=$(as_app "$sql" 2>&1)
  case "$out" in
    *"permission denied"*|*"must be owner"*|*"must have"*) ok "$label recusado" ;;
    *) bad "$label NAO foi recusado: $out" ;;
  esac
}
ddl_case "CREATE TABLE em nexus"       "CREATE TABLE nexus.hack(id int);"
ddl_case "CREATE SCHEMA"               "CREATE SCHEMA hack;"
ddl_case "DROP TABLE nexus.tool_grants" "DROP TABLE nexus.tool_grants;"
ddl_case "ALTER TABLE nexus.conversations ADD COLUMN x int" "ALTER TABLE nexus.conversations ADD COLUMN x int;"
ddl_case "CREATE ROLE"                 "CREATE ROLE hack_role;"
ddl_case "ALTER ROLE nexus_app NOSUPERUSER" "ALTER ROLE nexus_app NOSUPERUSER;"
ddl_case "CREATE FUNCTION"             "CREATE FUNCTION nexus.hack() RETURNS int LANGUAGE sql AS 'SELECT 1';"
ddl_case "CREATE DATABASE"             "CREATE DATABASE hack_db;"
# `GRANT` sem privilegio NAO levanta erro: emite WARNING e nao concede. O teste tem que
# verificar o EFEITO (o privilegio passou a existir?), nao a mensagem.
as_app "GRANT SELECT ON nexus.tool_grants TO nexus_anonymous;" >/dev/null 2>&1
EFF=$($PSQL -X $H -U postgres -d $DB -tAq -c "SELECT has_table_privilege('nexus_anonymous','nexus.tool_grants','SELECT')::text;" | head -1)
if [ "$EFF" = "false" ]; then ok "GRANT a outro papel sem efeito (privilegio nao concedido)"
else bad "nexus_app conseguiu conceder privilegio a outro papel"; fi

echo
echo "================================================================================="
echo " 4. OPERACOES NORMAIS DA APLICACAO CONTINUAM FUNCIONANDO"
echo "================================================================================="
$PSQL -X $H -U nexus_app -d $DB -q -v ON_ERROR_STOP=1 >/tmp/rt1.log 2>&1 <<SQL
BEGIN;
SELECT set_config('nexus.owner_id','$OWNER',true);
SELECT set_config('nexus.actor_type','owner',true);
SELECT set_config('nexus.assistant_id','00000000-0000-4000-8000-000000000001',true);
-- conversa
INSERT INTO nexus.conversations (id, owner_id, title)
VALUES ('c1000000-0000-4000-8000-000000000001','$OWNER','runtime check');
-- preferencia pessoal
INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, display_label)
VALUES ('$OWNER','00000000-0000-4000-8000-000000000001','Runtime')
ON CONFLICT (owner_id, assistant_id) DO UPDATE SET display_label=EXCLUDED.display_label;
-- CONCESSAO DE FERRAMENTA: deve disparar o trigger de auditoria
INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
VALUES ('c2000000-0000-4000-8000-000000000001','$OWNER',
        '00000000-0000-4000-8000-000000000001','personal.tasks','granted','$OWNER',now());
-- REVOGACAO
UPDATE nexus.tool_grants SET status='revoked', revoked_by_owner_id='$OWNER',
       revoked_at=now(), updated_at=now()
WHERE id='c2000000-0000-4000-8000-000000000001';
COMMIT;
SQL
if [ $? -eq 0 ]; then ok "conversa + preferencia + concessao + revogacao (tudo como nexus_app)"; else
  bad "operacoes normais falharam"; grep -E "ERROR|DETAIL" /tmp/rt1.log | head -3 | sed 's/^/        /'; fi

echo
echo "================================================================================="
echo " 5. AUDITORIA FUNCIONA PELO TRIGGER + SECURITY DEFINER"
echo "================================================================================="
# LER COM CONTEXTO: a policy de SELECT da trilha tambem exige owner+actor. Ler sem contexto
# devolve 0 — isso e o RLS funcionando, nao ausencia de evento.
read_as_app_ctx() {
  $PSQL -X $H -U nexus_app -d $DB -tAq <<SQL 2>&1
BEGIN;
SELECT set_config('nexus.owner_id','$OWNER',true);
SELECT set_config('nexus.actor_type','owner',true);
$1
COMMIT;
SQL
}
A=$(read_as_app_ctx "SELECT count(*) FROM nexus.tool_grant_audit WHERE grant_id='c2000000-0000-4000-8000-000000000001';" | grep -E '^[0-9]+$' | head -1)
say "   eventos na trilha para o grant: $A (esperado 2: granted + revoked)"
[ "$A" = "2" ] && ok "trigger SECURITY DEFINER gravou 2 eventos sob nexus_app" || bad "esperado 2 eventos, veio $A"

DET=$(read_as_app_ctx "SELECT 'ACOES='||string_agg(action::text,',' ORDER BY id) FROM nexus.tool_grant_audit WHERE grant_id='c2000000-0000-4000-8000-000000000001';" | grep -E '^ACOES=' | sed 's/^ACOES=//')
say "   acoes registradas: $DET"
case "$DET" in granted,revoked) ok "ordem e acoes corretas" ;; *) bad "acoes inesperadas: $DET" ;; esac

SEMCTX=$($PSQL -X $H -U nexus_app -d $DB -tAq -c "SELECT count(*) FROM nexus.tool_grant_audit;" | grep -E '^[0-9]+$' | head -1)
say "   mesma consulta SEM contexto: $SEMCTX (esperado 0 - RLS esconde a trilha)"
[ "${SEMCTX:-1}" = "0" ] && ok "RLS esconde a trilha fora do contexto (defesa em profundidade)" \
                          || bad "trilha visivel sem contexto: $SEMCTX"
say "   quem gravou de fato (dono da funcao):"
$PSQL -X $H -U postgres -d $DB -tAc "
SELECT '     '||pg_get_userbyid(proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='nexus' AND p.proname='audit_tool_grant_change';"

echo
echo "================================================================================="
echo " 6. TRILHA CONTINUA APPEND-ONLY PARA nexus_app"
echo "================================================================================="
for op in "UPDATE nexus.tool_grant_audit SET action='granted'" "DELETE FROM nexus.tool_grant_audit"; do
  out=$(as_app "$op;")
  case "$out" in
    *"permission denied"*|*"violates row-level security"*) ok "recusado: $(echo "$out" | head -1)" ;;
    *) bad "operacao aceita: $op -> $out" ;;
  esac
done
INS=$(as_app "INSERT INTO nexus.tool_grant_audit (owner_id,grant_id,assistant_id,tool_id,action,actor_owner_id) VALUES ('$OWNER',gen_random_uuid(),'00000000-0000-4000-8000-000000000001','personal.tasks','granted','$OWNER');")
case "$INS" in
  *"permission denied"*) ok "INSERT direto na trilha recusado" ;;
  *) bad "INSERT direto aceito: $INS" ;;
esac

echo
echo "================================================================================="
echo " 7. RLS CONTINUA EFETIVA (isolamento e falha fechada)"
echo "================================================================================="
# sem contexto: nao ve nada
SEM=$(as_app "SELECT count(*) FROM nexus.conversations;")
say "   conversas visiveis SEM contexto de owner: $SEM (esperado 0 = falha fechada)"
[ "$SEM" = "0" ] && ok "RLS falha fechada sem contexto" || bad "vazou $SEM linhas sem contexto"

# com contexto: ve as proprias
COM=$($PSQL -X $H -U nexus_app -d $DB -tAq <<SQL 2>&1
BEGIN;
SELECT set_config('nexus.owner_id','$OWNER',true);
SELECT set_config('nexus.actor_type','owner',true);
SELECT count(*) FROM nexus.conversations;
COMMIT;
SQL
)
COM=$(echo "$COM" | grep -E '^[0-9]+$' | head -1)
say "   conversas visiveis COM contexto: $COM (esperado >= 1)"
[ "${COM:-0}" -ge 1 ] && ok "RLS libera o owner correto" || bad "owner nao ve as proprias linhas"

# contexto de outro owner: nao ve nada
OUTRO=$($PSQL -X $H -U nexus_app -d $DB -tAq <<'SQL' 2>&1
BEGIN;
SELECT set_config('nexus.owner_id','99999999-0000-4000-8000-000000000001',true);
SELECT set_config('nexus.actor_type','owner',true);
SELECT count(*) FROM nexus.conversations;
COMMIT;
SQL
)
OUTRO=$(echo "$OUTRO" | grep -E '^[0-9]+$' | head -1)
say "   conversas visiveis com contexto de OUTRO owner: $OUTRO (esperado 0)"
[ "${OUTRO:-1}" = "0" ] && ok "RLS isola o owner" || bad "vazou $OUTRO linhas para outro owner"

# escrita com contexto de outro owner: recusada
W=$($PSQL -X $H -U nexus_app -d $DB -tAq <<'SQL' 2>&1
BEGIN;
SELECT set_config('nexus.owner_id','99999999-0000-4000-8000-000000000001',true);
SELECT set_config('nexus.actor_type','owner',true);
INSERT INTO nexus.conversations (id, owner_id, title)
VALUES ('c3000000-0000-4000-8000-000000000001','99999999-0000-4000-8000-000000000001','forged');
COMMIT;
SQL
)
case "$W" in
  *"violates row-level security"*|*"foreign key"*) ok "escrita com owner forjado recusada" ;;
  *) bad "escrita com owner forjado aceita: $W" ;;
esac

echo
echo "================================================================================="
echo " 8. nexus_app NAO E DONO DE NADA"
echo "================================================================================="
$PSQL -X $H -U postgres -d $DB -tAc "
SELECT '   tabelas de que nexus_app e dono: '||count(*) FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='nexus' AND pg_get_userbyid(c.relowner)='nexus_app';"
$PSQL -X $H -U postgres -d $DB -tAc "
SELECT '   schemas de que nexus_app e dono: '||count(*) FROM pg_namespace
WHERE pg_get_userbyid(nspowner)='nexus_app';"
$PSQL -X $H -U postgres -d $DB -tAc "
SELECT '   funcoes de que nexus_app e dono: '||count(*) FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='nexus' AND pg_get_userbyid(p.proowner)='nexus_app';"

echo
echo "================================================================================="
echo " 9. CREDENCIAL DE RUNTIME NAO CONSEGUE PROVISIONAR"
echo "================================================================================="
out=$(as_app "CREATE ROLE rogue NOLOGIN;" 2>&1)
case "$out" in *"permission denied"*) ok "nexus_app nao cria papeis" ;; *) bad "criou papel: $out" ;; esac
out=$(as_app "ALTER FUNCTION nexus.audit_tool_grant_change() OWNER TO nexus_app;" 2>&1)
case "$out" in *"must be owner"*|*"permission denied"*) ok "nexus_app nao transfere propriedade de funcao" ;; *) bad "transferiu: $out" ;; esac

echo
if [ $FAILS -eq 0 ]; then say "== ISOLAMENTO DO RUNTIME: TODAS AS PROVAS PASSARAM =="; exit 0
else say "== $FAILS FALHA(S) =="; exit 1; fi

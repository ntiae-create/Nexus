#!/bin/bash
# Prova empirica do comportamento de membership automatica no PG 16+ (PG 17.11)
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
P=/tmp/pg17/package/native/bin/psql
S="-h 127.0.0.1 -p 55432 -U postgres -d postgres -tAq"
$P -X $S -c "DROP ROLE IF EXISTS sg_criador, sg_alvo;" 2>/dev/null
$P -X $S -c "CREATE ROLE sg_criador LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS;"
echo "createrole_self_grant (default do cluster): '$($P -X $S -c 'SHOW createrole_self_grant;')'"
$P -X -h 127.0.0.1 -p 55432 -U sg_criador -d postgres -q -c "CREATE ROLE sg_alvo LOGIN;" 2>&1|head -1
echo "-- membership criada automaticamente pelo CREATE ROLE:"
$P -X $S -c "SELECT '   admin='||admin_option||' set='||set_option||' grantor='||pg_get_userbyid(grantor) FROM pg_auth_members am JOIN pg_roles m ON m.oid=am.member WHERE m.rolname='sg_criador';"
echo "-- SET ROLE funciona com essa membership (admin=true, set=false)?"
$P -X -h 127.0.0.1 -p 55432 -U sg_criador -d postgres -q -c "SET ROLE sg_alvo;" 2>&1|head -1
echo "-- o criador concede a si mesmo SET (tem ADMIN):"
$P -X -h 127.0.0.1 -p 55432 -U sg_criador -d postgres -q -c "GRANT sg_alvo TO sg_criador WITH SET TRUE;" 2>&1|head -1
$P -X $S -c "SELECT '   admin='||admin_option||' set='||set_option FROM pg_auth_members am JOIN pg_roles m ON m.oid=am.member JOIN pg_roles r ON r.oid=am.roleid WHERE m.rolname='sg_criador' AND r.rolname='sg_alvo' ORDER BY set_option;"
echo "-- SET ROLE agora? (medido NA MESMA SESSAO)"
out=$($P -X -h 127.0.0.1 -p 55432 -U sg_criador -d postgres -tAq -v ON_ERROR_STOP=1 2>&1 <<'SQL'
SET ROLE sg_alvo;
SELECT 'depois do SET ROLE, current_user = ' || current_user;
SQL
); echo "   $out"
echo "-- e o criador consegue dar SET a TERCEIROS (escalada)? (nao tem ADMIN no alvo criado por ele? tem)"
$P -X $S -c "SELECT '   criador tem ADMIN no alvo: '||admin_option FROM pg_auth_members am JOIN pg_roles m ON m.oid=am.member JOIN pg_roles r ON r.oid=am.roleid WHERE m.rolname='sg_criador' AND r.rolname='sg_alvo' AND admin_option;"
$P -X $S -c "DROP ROLE sg_alvo;" 2>/dev/null; $P -X $S -c "DROP ROLE sg_criador;" 2>/dev/null

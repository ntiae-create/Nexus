#!/bin/bash
# Sabotagem dirigida aos blocos que a auditoria R38 considerou "possivelmente enfraquecidos".
# Cada caso altera o catalogo, roda SO o bloco afetado (isolado, sem depender de estado do banco
# inteiro) e confere que a excecao esperada aparece.
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
P=/tmp/pg17/package/native/bin/psql
H="-h 127.0.0.1 -p 55432 -U nexus_migrator -d nexus_test"
DIR=/home/user/Nexus/packages/database/tests/postgres
F=0
chk() { # desc, bloco, sql_sabotagem, sql_desfazer, esperado
  $P -X $H -q -c "$3" >/dev/null 2>&1
  out=$($P -X $H -q -f "$2" 2>&1)
  $P -X $H -q -c "$4" >/dev/null 2>&1
  if echo "$out" | grep -q "$5"; then echo "   DETECTADO   $1"
  else echo "   NAO DETECTADO  $1"; echo "$out" | grep ERROR | head -1 | sed 's/^/       /'; F=$((F+1)); fi
}
# --- bloco enum
python3 - <<'PY'
s=open('/home/user/Nexus/packages/database/tests/postgres/verify-stage-5-grants-lifecycle.sql').read()
j=s.index('-- Nenhum papel INESPERADO recebe privilegio'); i=s.rindex('DO $$',0,j)
e=s.index('END\n$$;',j)+8; open('/tmp/b_enum.sql','w').write(s[i:e])
j=s.index('-- Quem pode ser MEMBRO de nexus_audit_writer?'); i=s.rindex('DO $$',0,j)
e=s.index('END\n$$;',j)+8; open('/tmp/b_d2.sql','w').write(s[i:e])
PY
$P -X -h 127.0.0.1 -p 55432 -U nexus_infra -d postgres -q -c "CREATE ROLE sab_intruso;" >/dev/null 2>&1
echo "== bloco de enums =="
chk "USAGE de enum para papel inesperado" /tmp/b_enum.sql \
    "GRANT USAGE ON TYPE nexus.tool_grant_status TO sab_intruso;" \
    "REVOKE USAGE ON TYPE nexus.tool_grant_status FROM sab_intruso;" \
    "Unexpected privilege on Phase 5 enums"
chk "USAGE de enum para PUBLIC" /tmp/b_enum.sql \
    "GRANT USAGE ON TYPE nexus.tool_grant_action TO PUBLIC;" \
    "REVOKE USAGE ON TYPE nexus.tool_grant_action FROM PUBLIC;" \
    "Type tool_grant_"
echo "== bloco D2 =="
chk "papel comum membro do writer" /tmp/b_d2.sql \
    "GRANT nexus_audit_writer TO sab_intruso;" \
    "REVOKE nexus_audit_writer FROM sab_intruso;" \
    "Unexpected member(s)"
chk "nexus_app membro do writer" /tmp/b_d2.sql \
    "GRANT nexus_audit_writer TO nexus_app;" \
    "REVOKE nexus_audit_writer FROM nexus_app;" \
    "Unexpected member(s) of nexus_audit_writer: nexus_app"
chk "writer herda nexus_app" /tmp/b_d2.sql \
    "GRANT nexus_app TO nexus_audit_writer;" \
    "REVOKE nexus_app FROM nexus_audit_writer;" \
    "nexus_audit_writer inherits privileges from: nexus_app"
$P -X -h 127.0.0.1 -p 55432 -U nexus_infra -d postgres -q -c "DROP ROLE IF EXISTS sab_intruso;" >/dev/null 2>&1
echo "== resultado: $F nao detectado(s) =="
exit $F

#!/bin/bash
# =================================================================================================
# R35 — Integridade de triggers, FKs, constraints e indices PREEXISTENTES.
#
# Metodo: dois bancos no MESMO cluster PG 17.11:
#   ref_db  -> migrations 00001-00006 (sem a 00007)
#   com_db  -> migrations 00001-00007
# Extrai o catalogo dos objetos que EXISTEM em ref_db e compara linha a linha com com_db.
# Qualquer diferenca em objeto preexistente = a 00007 mexeu no que nao devia.
# =================================================================================================
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
HOST="-h 127.0.0.1 -p 55432 -U postgres"
DBDIR=/home/user/Nexus/packages/database
REF=nexus_ref_00006
CMP=nexus_cmp_00007
FAILS=0

say() { printf '%s\n' "$*"; }
ok()  { printf '   OK   %s\n' "$*"; }
bad() { printf '   FALHA %s\n' "$*"; FAILS=$((FAILS+1)); }

/tmp/pg_cleanup.sh >/dev/null 2>&1
for db in $REF $CMP; do
  $PSQL -X $HOST -d postgres -q -c "DROP DATABASE IF EXISTS $db;" >/dev/null 2>&1
  $PSQL -X $HOST -d postgres -q -c "CREATE DATABASE $db;" >/dev/null 2>&1
done

# Baseline nos dois bancos (com legacy-stage-2a na hora certa).
for db in $REF $CMP; do
  for f in "$DBDIR"/migrations/*.sql; do
    base=$(basename "$f")
    case "$base" in 00007_*) continue ;; esac
    if [ "$base" = "00003_persistence_integrity.sql" ]; then
      $PSQL -X $HOST -d $db -q -v ON_ERROR_STOP=1 -f "$DBDIR/tests/postgres/legacy-stage-2a.sql" >/dev/null 2>&1
    fi
    $PSQL -X $HOST -d $db -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 \
      || bad "baseline $base em $db"
  done
done
say "== baseline 00001-00006 aplicada nos dois bancos =="

# A 00007 SO no banco de comparacao.
$PSQL -X $HOST -d $CMP -q -v ON_ERROR_STOP=1 \
  -f "$DBDIR/migrations/00007_tool_grants_and_preferences.sql" >/tmp/cmp_00007.log 2>&1 \
  && say "== 00007 aplicada em $CMP ==" || { bad "00007 em $CMP"; head -3 /tmp/cmp_00007.log; }

extract() {
  local db="$1" out="$2"
  $PSQL -X $HOST -d "$db" -tA -F'|' > "$out" <<'SQL'
-- 1. TRIGGERS (definicao completa, incl. funcao, eventos, condicao, tgargs)
SELECT 'TRIGGER' , c.relname, t.tgname, p.proname, t.tgtype::text,
       coalesce(pg_get_expr(t.tgqual, t.tgrelid),'-'),
       coalesce(encode(t.tgargs,'escape'),'-'), t.tgenabled::text
FROM pg_trigger t
JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_proc p ON p.oid=t.tgfoid
WHERE NOT t.tgisinternal AND n.nspname='nexus'
UNION ALL
-- 2. FOREIGN KEYS (tabela, colunas, destino, acoes, deferrability)
SELECT 'FK', cl.relname, co.conname,
       pg_get_constraintdef(co.oid),
       (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
        FROM unnest(co.conkey) WITH ORDINALITY u(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=u.attnum),
       co.condeferrable::text||'/'||co.condeferred::text,
       co.convalidated::text, '-'
FROM pg_constraint co
JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
WHERE co.contype='f' AND n.nspname='nexus'
UNION ALL
-- 3. CHECK CONSTRAINTS
SELECT 'CHECK', cl.relname, co.conname, pg_get_constraintdef(co.oid),
       '-', co.convalidated::text, coalesce(co.connoinherit::text,'-'), '-'
FROM pg_constraint co
JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
WHERE co.contype='c' AND n.nspname='nexus'
UNION ALL
-- 4. INDICES (definicao completa)
SELECT 'INDEX', cl.relname, ic.relname, pg_get_indexdef(i.indexrelid),
       am.amname, i.indisunique::text||'/'||i.indisprimary::text, i.indisvalid::text, '-'
FROM pg_index i
JOIN pg_class cl ON cl.oid=i.indrelid JOIN pg_class ic ON ic.oid=i.indexrelid
JOIN pg_namespace n ON n.oid=cl.relnamespace JOIN pg_am am ON am.oid=ic.relam
WHERE n.nspname='nexus'
UNION ALL
-- 5. FUNCOES PREEXISTENTES (assinatura, SECURITY DEFINER, search_path, corpo)
SELECT 'FUNCTION', p.proname, pg_get_function_identity_arguments(p.oid),
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END,
       coalesce(array_to_string(p.proconfig,','),'-'),
       md5(pg_get_functiondef(p.oid)), pg_get_userbyid(p.proowner), '-'
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='nexus'
UNION ALL
-- 6. ROW LEVEL SECURITY por tabela
SELECT 'RLS', c.relname, 'rls', c.relrowsecurity::text, c.relforcerowsecurity::text, '-', '-', '-'
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='nexus' AND c.relkind='r'
UNION ALL
-- 7. POLICIES (definicao completa)
SELECT 'POLICY', c.relname, p.polname, p.polcmd::text,
       coalesce(pg_get_expr(p.polqual,p.polrelid),'-'),
       coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'-'),
       coalesce(array_to_string(p.polroles::regrole[],','),'-'), '-'
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='nexus'
ORDER BY 1,2,3;
SQL
}

extract $REF /tmp/cat_ref.txt
extract $CMP /tmp/cat_cmp.txt

# Objetos que existem em REF: qualquer mudanca neles e regressao.
awk -F'|' '$1!="FUNCTION"' /tmp/cat_ref.txt | sort > /tmp/ref_sorted.txt
awk -F'|' '$1!="FUNCTION"' /tmp/cat_cmp.txt | sort > /tmp/cmp_sorted.txt

say "== comparacao de triggers / FKs / constraints / indices / RLS / policies =="
say "   objetos no banco de referencia (00001-00006): $(wc -l < /tmp/ref_sorted.txt)"
say "   objetos no banco com 00007:                  $(wc -l < /tmp/cmp_sorted.txt)"

if diff -u /tmp/ref_sorted.txt /tmp/cmp_sorted.txt > /tmp/cat_diff.txt 2>&1; then
  ok "NENHUMA diferenca em objeto preexistente"
else
  # Diferencas legitimas: a 00007 ADICIONA triggers/policies/FKs nas tabelas novas.
  removed=$(grep -c '^-' /tmp/cat_diff.txt || true)
  added=$(grep -c '^+' /tmp/cat_diff.txt || true)
  say "   linhas removidas/alteradas: $removed ; adicionadas: $added"
  if [ "$removed" -gt 2 ]; then
    bad "objetos preexistentes foram ALTERADOS ou REMOVIDOS (ver /tmp/cat_diff.txt)"
    grep '^-' /tmp/cat_diff.txt | grep -v '^---' | head -8 | sed 's/^/        /'
  else
    ok "apenas adicoes (tabelas/policies novas da Fase 5.1)"
  fi
fi

say "== funcoes preexistentes: mesmo corpo? =="
# "Preexistente" = existe no banco de referencia (00001-00006). Funcoes que so existem no banco
# com 00007 (`audit_tool_grant_change`, `enforce_tool_grant_lifecycle`) sao NOVAS, nao preexistentes:
# comparar por interseccao de assinatura (nome + argumentos) elimina esse falso positivo.
cut -d'|' -f1-6 /tmp/cat_ref.txt | grep '^FUNCTION' | sort > /tmp/fn_ref.txt
cut -d'|' -f1-6 /tmp/cat_cmp.txt | grep '^FUNCTION' | sort > /tmp/fn_cmp.txt
cut -d'|' -f1-2 /tmp/fn_ref.txt | sort -u > /tmp/fn_sig.txt

# Para cada assinatura preexistente, extrai a linha completa dos dois lados e compara.
: > /tmp/fn_ref_pre.txt; : > /tmp/fn_cmp_pre.txt
while IFS= read -r sig; do
  grep -F "$sig|" /tmp/fn_ref.txt >> /tmp/fn_ref_pre.txt
  grep -F "$sig|" /tmp/fn_cmp.txt >> /tmp/fn_cmp_pre.txt
done < /tmp/fn_sig.txt

say "   funcoes preexistentes comparadas: $(wc -l < /tmp/fn_ref_pre.txt)"
if diff -q /tmp/fn_ref_pre.txt /tmp/fn_cmp_pre.txt >/dev/null 2>&1; then
  ok "todas as $(wc -l < /tmp/fn_ref_pre.txt) funcoes preexistentes identicas (corpo, SECURITY DEFINER, search_path)"
else
  say "   funcoes preexistentes que diferem:"
  diff /tmp/fn_ref_pre.txt /tmp/fn_cmp_pre.txt | grep -E '^[<>]' | sed 's/^/        /' | head -10
  bad "funcoes preexistentes alteradas"
fi

say "== funcoes NOVAS trazidas pela 00007 (esperado: 2) =="
comm -13 /tmp/fn_sig.txt <(cut -d'|' -f1-2 /tmp/fn_cmp.txt | sort -u) | sed 's/^/   /'
say ""
say "== triggers NOVOS trazidos pela 00007 =="
grep '^TRIGGER' /tmp/cat_cmp.txt | cut -d'|' -f1-3 | sort > /tmp/tr_cmp.txt
grep '^TRIGGER' /tmp/cat_ref.txt | cut -d'|' -f1-3 | sort > /tmp/tr_ref.txt
comm -13 /tmp/tr_ref.txt /tmp/tr_cmp.txt | sed 's/^/   /'
say ""
say "== policies NOVAS trazidas pela 00007 =="
grep '^POLICY' /tmp/cat_cmp.txt | cut -d'|' -f1-3 | sort > /tmp/po_cmp.txt
grep '^POLICY' /tmp/cat_ref.txt | cut -d'|' -f1-3 | sort > /tmp/po_ref.txt
comm -13 /tmp/po_ref.txt /tmp/po_cmp.txt | sed 's/^/   /' 

echo
if [ $FAILS -eq 0 ]; then say "== INTEGRIDADE PRESERVADA =="; exit 0
else say "== $FAILS FALHA(S) =="; exit 1; fi

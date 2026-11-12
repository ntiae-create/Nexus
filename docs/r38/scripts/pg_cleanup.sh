#!/bin/bash
# =================================================================================================
# Limpeza ESCOPADA de papeis de teste no cluster PG 17.11.
#
# R40 — CORRECAO DE ESCOPO DESTRUTIVO. O que mudou e por que:
#
#   DEFEITO 1 (R39/D-5.7). A versao anterior percorria TODOS os bancos nao-template e executava
#   `DROP OWNED BY <papel> CASCADE` em cada um, sem nenhum filtro. A lista TEST_DATABASES
#   protegia apenas o `DROP DATABASE`. Objetos de propriedade do papel em bancos fora da lista
#   eram DESTRUIDOS silenciosamente, com o script reportando sucesso. Reproduzido em cluster
#   descartavel: `sentinela_prod` perdeu schema e tabela com 5 linhas.
#
#   DEFEITO 2 (descoberto ao corrigir o 1). A consulta de dependencias nao filtrava `dbid`.
#   `pg_shdepend` e um catalogo COMPARTILHADO: as mesmas linhas sao visiveis de qualquer banco,
#   com `dbid` indicando o banco de origem. Sem `dbid = <banco>`, cada banco reportava as
#   dependencias de TODOS os outros, envenenando a lista `local_found` que decide qual banco
#   derrubar.
#
# ARQUITETURA (a correcao e a ordem, nao apenas o filtro):
#   FASE A — PRE-VOO, somente leitura. Mapeia as dependencias de cada papel. Se qualquer papel
#            tiver dependencia fora de TEST_DATABASES, ABORTA aqui, com exit != 0, sem destruir
#            NADA — nem os bancos de teste. Escopo ambiguo nunca chega a destruir objeto.
#   FASE B — DESTRUICAO, somente apos o pre-voo aprovar. Derruba os bancos de TESTE (leva o
#            pg_shdepend por-banco junto), limpa o que restar, e drops os papeis.
#
# TEST_DATABASES e a UNICA fonte de verdade. Um banco fora dela nunca recebe DROP DATABASE nem
# DROP OWNED. Para autorizar outro banco, edite a lista — de forma explicita e revisavel.
#
# Entrada: nomes de papel a remover (padrao: os papeis de teste conhecidos).
# Saida:   0 = papeis removidos, nenhum objeto fora de TEST_DATABASES tocado.
#          1 = falha OU escopo ambiguo. Nesse caso nada fora da lista foi destruido; em escopo
#              ambiguo (fase A) nada foi destruido de forma alguma.
# =================================================================================================
set -u
set -o pipefail
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
HOST="-h 127.0.0.1 -p 55432 -U postgres"

# Distincao que a versao anterior nao fazia: `$#` igual a 0 significa "sem argumentos" (usa o
# padrao); um argumento VAZIO explicito e erro de uso, nao um pedido para usar o padrao.
if [ $# -eq 0 ]; then
  ROLES="nexus_app nexus_anonymous nexus_audit_writer prov_r35 prov_x writer_x"
else
  ROLES="$*"
  for _a in "$@"; do
    [ -n "$_a" ] || { printf '   ABORTADO: argumento de papel vazio\n'; exit 1; }
  done
fi

# -------------------------------------------------------------------------------------------------
# ESCOPO DESTRUTIVO — unica fonte de verdade.
# -------------------------------------------------------------------------------------------------
TEST_DATABASES="nexus_test nexus_prov_test nexus_preexist_test probe_db"

FAILS=0
bad() { printf '   FALHA %s\n' "$*"; FAILS=$((FAILS+1)); }
die() { printf '   ABORTADO: %s\n' "$*"; exit 1; }

# -------------------------------------------------------------------------------------------------
# Validacao de identificadores. Os nomes vem da linha de comando e sao interpolados em SQL. Sem
# validacao, `x; DROP DATABASE producao` executaria codigo arbitrario como superusuario.
# -------------------------------------------------------------------------------------------------
VALID_IDENT='^[A-Za-z_][A-Za-z0-9_]*$'
validar_nome() {
  [ -n "${1:-}" ] || { bad "nome vazio"; return 1; }
  printf '%s' "$1" | grep -Eq "$VALID_IDENT" \
    || { bad "identificador invalido: '$1' (esperado $VALID_IDENT)"; return 1; }
  [ ${#1} -le 63 ] || { bad "identificador maior que 63 bytes: '$1'"; return 1; }
  return 0
}

is_test_db() { case " $TEST_DATABASES " in *" $1 "*) return 0 ;; esac; return 1; }

# =================================================================================================
# FASE A — PRE-VOO (somente leitura). Nenhum DROP nesta fase.
# =================================================================================================
echo "== A. pre-voo: validacao de entrada (somente leitura) =="
for db in $TEST_DATABASES; do
  validar_nome "$db" || die "TEST_DATABASES contem nome invalido"
  printf '   escopo autorizado: %s\n' "$db"
done
for r in $ROLES; do
  validar_nome "$r" || die "papel invalido na linha de comando"
  is_test_db "$r" && die "nome de papel colide com nome de banco de teste: '$r'"
done
[ $FAILS -eq 0 ] || die "entrada invalida; nada foi executado"

echo "== B. pre-voo: mapeamento de dependencias por papel (somente leitura) =="
# Para cada papel existente: onde ele tem dependencias?
#   - dbid = 0            -> compartilhado (membership, dono de banco, tablespace)
#   - dbid = banco teste  -> dentro do escopo
#   - dbid = outro banco  -> FORA do escopo => aborto
escopo_sujo=0
papel_para_limpar=""

for r in $ROLES; do
  oid=$($PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 \
          -c "SELECT oid FROM pg_roles WHERE rolname = '$r';" 2>&1); rc=$?
  [ $rc -eq 0 ] || { printf '   %s\n' "$oid"; bad "consulta de oid de $r falhou (rc=$rc)"; continue; }
  if [ -z "$oid" ]; then
    echo "   $r: nao existe (nada a fazer)"
    continue
  fi
  echo "   --- $r (oid $oid) ---"

  # Dependencias por banco. O filtro por dbid e o que torna o mapa correto: sem ele, pg_shdepend
  # (catalogo compartilhado) reportaria a mesma linha vinda de todos os bancos.
  mapa=$($PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 -F'|' -c "
    SELECT COALESCE(d.datname, '<cluster>'), count(*)
    FROM pg_shdepend s
    LEFT JOIN pg_database d ON d.oid = s.dbid
    WHERE s.refobjid = '$oid'::oid
    GROUP BY 1 ORDER BY 1;" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    printf '   %s\n' "$mapa"; bad "mapa de dependencias de $r falhou (rc=$rc)"; continue
  fi

  # O papel e dono de algum banco? A propriedade do banco fica em pg_shdepend com dbid=0, mas o
  # nome do banco nao aparece la — por isso consultamos pg_database.datdba diretamente.
  dono_de=$($PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 \
              -c "SELECT datname FROM pg_database WHERE datdba = '$oid'::oid ORDER BY 1;" 2>&1); rc=$?
  [ $rc -eq 0 ] || { printf '   %s\n' "$dono_de"; bad "consulta de bancos de $r falhou (rc=$rc)"; continue; }

  fora=""
  while IFS='|' read -r db n; do
    [ -n "${db:-}" ] || continue
    case "$db" in
      '<cluster>') echo "     [cluster] $n dependencia(s) compartilhada(s) — nenhum DROP OWNED as remove" ;;
      *)
        if is_test_db "$db"; then echo "     [teste]   $db: $n dependencia(s) — dentro do escopo"
        else                 echo "     [FORA]    $db: $n dependencia(s) — BANCO NAO AUTORIZADO"
                             fora="$fora $db"; fi ;;
    esac
  done <<EOF
$mapa
EOF

  # Bancos cuja propriedade pertence ao papel: se nao for de teste, DROP ROLE vai falhar e,
  # pior, qualquer tentativa de "resolver" exigiria mexer fora do escopo.
  while read -r dbdono; do
    [ -n "${dbdono:-}" ] || continue
    if is_test_db "$dbdono"; then
      echo "     [teste]   $dbdono: banco e do papel (sera derrubado)"
    else
      # `postgres` e o banco de manutencao; raramente e dos papeis de teste. Sinaliza, nao bloqueia
      # se for apenas o banco `postgres` sem objetos do papel — mas registra.
      echo "     [FORA]    $dbdono: o BANCO pertence ao papel — NAO AUTORIZADO"
      fora="$fora $dbdono(banco)"
    fi
  done <<EOF
$dono_de
EOF

  if [ -n "$fora" ]; then
    bad "papel $r tem dependencias fora do escopo:$fora"
    escopo_sujo=1
  else
    papel_para_limpar="$papel_para_limpar $r:$oid"
  fi
done

if [ $escopo_sujo -ne 0 ]; then
  echo
  echo "== ESCOPO AMBIGUO: remover estes papeis exigiria destruir objetos fora de TEST_DATABASES =="
  echo "   Nada foi destruido. Nenhum DROP DATABASE, DROP OWNED ou DROP ROLE foi executado."
  echo "   Remova essas dependencias manualmente ou autorize os bancos explicitamente em TEST_DATABASES."
  exit 1
fi
[ $FAILS -eq 0 ] || { echo "   pre-voo registrou $FAILS falha(s); abortando antes de destruir."; exit 1; }

# =================================================================================================
# FASE C — DESTRUICAO. Só chega aqui o que passou pelo pre-voo.
# =================================================================================================
# -------------------------------------------------------------------------------------------------
# C.1 — DROP OWNED, ANTES de derrubar os bancos. Motivo de ordem (corrigido no R40): se o banco
# fosse derrubado primeiro, este laco nunca encontraria um banco existente para limpar e todo o
# DROP OWNED seria codigo inalcancavel — codigo destrutivo que ninguem consegue provar seguro.
# Limpar primeiro torna a operacao exercitada e portanto testavel.
# Escopo: SOMENTE nomes de TEST_DATABASES. Nenhum outro banco e visitado.
# -------------------------------------------------------------------------------------------------
echo "== C. limpar objetos dos papeis nos bancos de TESTE (DROP OWNED) =="
for par in $papel_para_limpar; do
  r="${par%%:*}"; oid="${par##*:}"
  for db in $TEST_DATABASES; do
    is_test_db "$db" || die "logica inconsistente: '$db' fora do escopo"
    existe=$($PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 \
               -c "SELECT count(*) FROM pg_database WHERE datname = '$db';" 2>&1); rc=$?
    if [ $rc -ne 0 ]; then
      printf '     %s\n' "$existe"; bad "consulta de existencia de $db falhou (rc=$rc)"; continue
    fi
    if [ "$existe" = "0" ]; then
      echo "     $r @ $db: banco nao existe — nada a limpar"
      continue
    fi
    out=$($PSQL -X $HOST -d "$db" -q -v ON_ERROR_STOP=1 \
            -c "DROP OWNED BY \"$r\" CASCADE;" 2>&1); rc=$?
    if [ $rc -eq 0 ]; then
      echo "     $r @ $db: DROP OWNED ok"
    else
      printf '     %s\n' "$out"; bad "DROP OWNED de $r em $db falhou (rc=$rc)"
    fi
  done
done
[ $FAILS -eq 0 ] || die "falha no DROP OWNED; abortando antes de derrubar qualquer banco"

# -------------------------------------------------------------------------------------------------
# C.2 — Derrubar os bancos de teste. Só os da lista; o status de cada DROP é verificado.
# -------------------------------------------------------------------------------------------------
echo "== C.2 derrubar os bancos de TESTE (somente os da lista autorizada) =="
for db in $TEST_DATABASES; do
  is_test_db "$db" || die "logica inconsistente: '$db' fora do escopo"
  out=$($PSQL -X $HOST -d postgres -q -v ON_ERROR_STOP=1 \
          -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    printf '   %s: removido (ou inexistente)\n' "$db"
  else
    printf '   %s: %s\n' "$db" "$out"
    bad "DROP DATABASE $db falhou (rc=$rc)"
  fi
done
[ $FAILS -eq 0 ] || die "falha ao derrubar banco de teste; abortando antes do DROP ROLE"

echo "== D. dropar os papeis =="
# O DROP OWNED ja rodou em C.1, quando os bancos de teste ainda existiam. Aqui resta apenas o
# DROP ROLE. Nao ha segundo DROP OWNED: quando um banco e derrubado, seus objetos vao junto, entao
# repetir a limpeza seria codigo morto disfarcado de seguranca.
for par in $papel_para_limpar; do
  r="${par%%:*}"; oid="${par##*:}"
  echo "   --- $r (oid $oid) ---"
  out=$($PSQL -X $HOST -d postgres -q -v ON_ERROR_STOP=1 -c "DROP ROLE \"$r\";" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    echo "     DROP ROLE: ok"
  else
    printf '     %s\n' "$out" | head -4
    bad "DROP ROLE $r falhou (rc=$rc) — dependencias remanescentes"
  fi
done

echo "== E. estado final =="
# O resumo nao pode ser incondicional. Se nenhum papel foi efetivamente removido (todos ja
# ausentes), `exit 0` significa "nada a fazer", nao "limpeza realizada". Dizemos qual dos dois foi.
REMOVIDOS=0
for par in $papel_para_limpar; do
  r="${par%%:*}"
  ainda=$($PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 \
            -c "SELECT count(*) FROM pg_roles WHERE rolname = '$r';" 2>&1)
  [ "$ainda" = "0" ] && REMOVIDOS=$((REMOVIDOS+1))
done
$PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 \
  -c "SELECT '   bancos: '||coalesce(string_agg(datname,', ' ORDER BY datname),'(nenhum)')
      FROM pg_database WHERE NOT datistemplate;" 2>&1 || bad "consulta de estado final falhou"
$PSQL -X $HOST -d postgres -tAq -v ON_ERROR_STOP=1 \
  -c "SELECT '   papeis: '||coalesce(string_agg(rolname,', ' ORDER BY rolname),'(nenhum)')
      FROM pg_roles WHERE rolname = ANY (string_to_array('$ROLES',' '));" 2>&1 \
  || bad "consulta de papeis remanescentes falhou"

echo
if [ $FAILS -eq 0 ]; then
  printf '== LIMPEZA CONCLUIDA: %d papel(is) removido(s); nenhum objeto fora de TEST_DATABASES foi tocado ==\n' "$REMOVIDOS"
  exit 0
else
  echo "== $FAILS FALHA(S) — nada fora de TEST_DATABASES foi destruido =="
  exit 1
fi

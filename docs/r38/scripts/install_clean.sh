#!/bin/bash
# =================================================================================================
# R36 -> R39 — INSTALACAO LIMPA com TRES PAPEIS SEPARADOS.
#
#   nexus_migrator     LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB  -> migrations
#   nexus_app          LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB  -> runtime
#   nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS                     -> SECURITY DEFINER
#   nexus_infra        LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS   -> bootstrap inicial
#
# O QUE ESTE SCRIPT PROVA (e o que NAO prova) — correcao de afirmacao do R38:
#   - 00001..00007 + bootstrap + seeds + verificadores rodam como `nexus_migrator`;
#   - NENHUMA migration, NENHUM DDL de schema, NENHUM dado e NENHUM `GRANT` de tabela executam
#     como SUPERUSER;
#   - `DROP DATABASE`/`CREATE DATABASE`/`CREATE ROLE` rodam como `nexus_infra` (CREATEROLE+CREATEDB);
#   - EXCECAO inevitavel e declarada: UM comando como `postgres` — a criacao do PRIMEIRO papel do
#     cluster (`nexus_infra`), porque um papel inexistente nao pode criar a si mesmo. Em Neon esse
#     ato e o "owner" do projeto no console.
#   - O cleanup de papeis (`docs/r38/scripts/pg_cleanup.sh`) conecta como `postgres` em todas as
#     suas conexoes. Ele tem escopo destrutivo limitado a TEST_DATABASES desde o R40.
# Portanto a afirmacao "sem SUPERUSER em nenhuma etapa" era FALSA e foi removida.
#
# R41 — INTEGRIDADE DE EXECUCAO. Este script executa o cleanup VERSIONADO ao lado dele
# (`$SCRIPT_DIR/pg_cleanup.sh`), resolvido a partir de BASH_SOURCE, com SHA256 conferido contra o
# artefato auditado no R40 ANTES de qualquer operacao destrutiva. Ate o R40 ele executava
# `/tmp/pg_cleanup.sh` — uma copia arbitraria; uma versao antiga e insegura em /tmp era executada
# no lugar do artefato auditado, e o fluxo ainda reportava 29 OK / 0 FALHA.
# =================================================================================================
set -u
export LD_LIBRARY_PATH=/tmp/pg17/package/native/lib
PSQL=/tmp/pg17/package/native/bin/psql
# Conexao de BOOTSTRAP: papel dedicado apenas com CREATEROLE+CREATEDB — NUNCA superuser.
# Ele so cria/derruba papel e banco; nao tem acesso a dados e nao aplica migration nenhuma.
HBOOT="-h 127.0.0.1 -p 55432 -U nexus_infra"
H="-h 127.0.0.1 -p 55432 -U nexus_migrator"
DB=nexus_test

# -------------------------------------------------------------------------------------------------
# R41 — RESOLUCAO DE CAMINHOS A PARTIR DA LOCALIZACAO DO PROPRIO SCRIPT
#
# DEFEITO (R40 §12.5): o fluxo executava `/tmp/pg_cleanup.sh` por caminho ABSOLUTO e fixo, e
# `DBDIR` estava fixo em `/home/user/Nexus/packages/database`. Consequencia medida: uma copia
# ANTIGA e insegura colocada em /tmp era executada no lugar do script versionado e auditado,
# e o fluxo reportava 29 OK / 0 FALHA. O caminho nao pode vir do diretorio de trabalho nem de
# um literal: vem da localizacao real do arquivo (BASH_SOURCE), resolvida por symlinks.
# -------------------------------------------------------------------------------------------------
# Resolve o caminho REAL do arquivo seguindo symlinks. `BASH_SOURCE` sozinho nao resolve: se o
# script for invocado por um link em /tmp, `dirname` devolveria /tmp e todo o resto quebraria.
_self="${BASH_SOURCE[0]}"
while [ -L "$_self" ]; do
  _dir=$(cd -- "$(dirname -- "$_self")" > /dev/null 2>&1 && pwd -P)
  _self=$(readlink -- "$_self")
  case "$_self" in /*) ;; *) _self="$_dir/$_self" ;; esac
done
SCRIPT_DIR=$(cd -- "$(dirname -- "$_self")" > /dev/null 2>&1 && pwd -P) || SCRIPT_DIR=""
[ -n "$SCRIPT_DIR" ] || { echo "   ABORTADO: nao foi possivel resolver o diretorio do script"; exit 1; }

# DBDIR = raiz do repositorio + packages/database. subimos de docs/r38/scripts ate a raiz.
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../../.." > /dev/null 2>&1 && pwd -P) || REPO_ROOT=""
DBDIR="$REPO_ROOT/packages/database"
[ -d "$DBDIR" ] || { echo "   ABORTADO: DBDIR nao existe: $DBDIR"; exit 1; }

# O cleanup versionado e o UNICO que pode rodar. Nao ha copia intermediaria em /tmp.
CLEANUP_SRC="$SCRIPT_DIR/pg_cleanup.sh"
[ -f "$CLEANUP_SRC" ] || { echo "   ABORTADO: cleanup versionado ausente: $CLEANUP_SRC"; exit 1; }
[ -x "$CLEANUP_SRC" ] || { echo "   ABORTADO: cleanup versionado nao e executavel: $CLEANUP_SRC"; exit 1; }

# SHA256 do artefato auditado no R40. Se o arquivo em disco divergir, abortamos ANTES de qualquer
# operacao destrutiva: um cleanup alterado nao e o cleanup auditado.
CLEANUP_SHA256_ESPERADO=1ccc43fb4397632c4210b3f4588da3df4a1e6e573b87c2bc5b23ceaef67803a2
CLEANUP_SHA256_REAL=$(sha256sum "$CLEANUP_SRC" | cut -d' ' -f1)
if [ "$CLEANUP_SHA256_REAL" != "$CLEANUP_SHA256_ESPERADO" ]; then
  echo "   ABORTADO: SHA256 do cleanup nao confere."
  echo "     esperado: $CLEANUP_SHA256_ESPERADO"
  echo "     obtido:   $CLEANUP_SHA256_REAL"
  echo "     arquivo:  $CLEANUP_SRC"
  exit 1
fi
OWNER=00000000-0000-4000-8000-000000000004
FAILS=0

say() { printf '%s\n' "$*"; }
ok()  { printf '   OK    %s\n' "$*"; }
bad() { printf '   FALHA %s\n' "$*"; FAILS=$((FAILS+1)); }

# runner de arquivo SQL como papel limitado, com contexto RLS de sessao
run_as() {
  local role="$1" label="$2" file="$3"
  local out rc
  out=$($PSQL -X $H -U "$role" -d $DB -q -f "$file" 2>&1)
  rc=$?
  echo "$out" | grep -E "NOTICE" | sed 's/^psql:[^:]*:[0-9]*: /        /' | head -6
  if [ $rc -eq 0 ]; then ok "$label"; else
    bad "$label"
    echo "$out" | grep -E "ERROR|DETAIL|HINT" | head -4 | sed 's/^/        /'
  fi
  return $rc
}

run_with_ctx() {
  local role="$1" label="$2" file="$3"
  printf "SELECT set_config('nexus.owner_id','%s',false);\nSELECT set_config('nexus.actor_type','owner',false);\n\\set ON_ERROR_STOP on\n\\i %s\n" \
    "$OWNER" "$file" > /tmp/install_ctx.sql
  run_as "$role" "$label" /tmp/install_ctx.sql
}

echo "================================================================================="
echo " 1. LIMPEZA E CRIACAO DOS TRES PAPEIS"
echo "================================================================================="
# A limpeza NAO pode ser silenciosa: se sobrar papel de execucao anterior, o CREATE ROLE falha e
# queremos o motivo na tela. A saida do cleanup vai para log e o status e conferido.
# R41: executa o artefato VERSIONADO e cujo SHA256 foi conferido acima — nunca /tmp.
say "   cleanup em uso: $CLEANUP_SRC (sha256 ${CLEANUP_SHA256_REAL:0:16}…)"
out=$("$CLEANUP_SRC" nexus_migrator nexus_app nexus_anonymous nexus_audit_writer nexus_infra 2>&1); rc=$?
echo "$out" > /tmp/cleanup.log
[ $rc -eq 0 ] && ok "papeis de execucao anterior removidos (log: /tmp/cleanup.log)" \
              || { bad "cleanup de papeis"; tail -20 /tmp/cleanup.log; exit 1; }
if grep -q "AINDA PENDENTE" /tmp/cleanup.log; then
  bad "cleanup deixou papel pendente"; grep "AINDA PENDENTE" /tmp/cleanup.log; exit 1
fi

# ---------------------------------------------------------------------------------------------
# PRE-REQUISITO DE PLATAFORMA (fora do fluxo de instalacao): alguem tem de criar o PRIMEIRO
# papel do cluster. Nao ha como um papel inexistente criar a si mesmo. Em Neon isso e o "owner"
# que o provedor entrega no console; aqui e o superusuario local do cluster de teste.
# Este e o UNICO ponto do script que fala como superusuario, e ele cria apenas:
#   nexus_infra  LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS
# Nenhum DDL de schema, nenhuma migration, nenhum dado e nenhum GRANT de tabela passam por ele.
# ---------------------------------------------------------------------------------------------
out=$($PSQL -X -h 127.0.0.1 -p 55432 -U postgres -d postgres -q -v ON_ERROR_STOP=1 2>&1 <<'SQL'
DROP ROLE IF EXISTS nexus_infra;
CREATE ROLE nexus_infra LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS;
SQL
); rc=$?; echo "$out" | sed 's/^/   /'
[ $rc -eq 0 ] && ok "nexus_infra criado (CREATEROLE+CREATEDB, NOSUPERUSER) - unico ato de superusuario, pre-requisito de plataforma" || { bad "nexus_infra"; exit 1; }
# `DROP DATABASE` exige ser dono do banco ou ter CREATEDB. O `nexus_infra` tem CREATEDB e
# NAO e superuser. Se o banco de uma execucao anterior pertencer a outro papel, o DROP falha
# alto (sem 2>/dev/null) — nao queremos limpeza silenciosa que deixa residuo.
$PSQL -X $HBOOT -d postgres -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB;"
[ $? -eq 0 ] && ok "banco anterior removido (por nexus_infra, sem SUPERUSER)" || { bad "DROP DATABASE"; exit 1; }

# O `nexus_infra` cria o papel de migrations. Nenhum superusuario participa.
out=$($PSQL -X $HBOOT -d postgres -q -v ON_ERROR_STOP=1 2>&1 <<'SQL'
CREATE ROLE nexus_migrator LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB NOINHERIT;
SQL
); rc=$?; echo "$out" | sed 's/^/   /'
[ $rc -eq 0 ] && ok "nexus_migrator criado (CREATEROLE, sem SUPERUSER/BYPASSRLS/CREATEDB)" || { bad "nexus_migrator"; exit 1; }

# No PG 16+, quem cria um papel recebe membership AUTOMATICA com admin=true e set=false.
# `CREATE DATABASE ... OWNER` exige poder SET ROLE no dono, portanto o `nexus_infra` precisa
# elevar a propria membership a set=true. Isso e auto-concessao sobre um papel que ele mesmo
# criou: nao amplia poder algum que ele ja nao tenha (ele pode fazer DROP OWNED / DROP ROLE).
# FATOS MEDIDOS (PG 17.11, verificados em /tmp/exp_selfgrant.sh):
#   * quem cria um papel recebe membership AUTOMATICA com admin_option=true, set_option=false;
#   * `admin_option` NAO permite SET ROLE; para isso e preciso uma segunda membership com
#     set_option=true, que o criador PODE conceder a si mesmo (tem ADMIN);
#   * nao depende de `createrole_self_grant` estar definido.
# Por isso o passo abaixo e necessario e suficiente, e continua sem superusuario.
# `INHERIT FALSE` e ESSENCIAL e foi um achado da auditoria: sem ele o `nexus_infra` HERDA todos os
# privilegios de dono do schema (comprovado: `CREATE TABLE nexus....` passava) — privilegio muito
# alem do necessario. Com `INHERIT FALSE` ele nao herda nada e continua podendo `SET ROLE`, que e
# o unico poder de que precisa (`CREATE DATABASE ... OWNER`).
$PSQL -X $HBOOT -d postgres -q -v ON_ERROR_STOP=1 -c "GRANT nexus_migrator TO nexus_infra WITH SET TRUE, INHERIT FALSE;"
[ $? -eq 0 ] && ok "nexus_infra pode SET ROLE nexus_migrator SEM herdar privilegios (INHERIT FALSE)" || { bad "GRANT SET infra"; exit 1; }
# A PROVA NEGATIVA de INHERIT FALSE nao pode rodar aqui: depende de tres pre-condicoes que ainda
# nao existem neste ponto (D-6 do R38). Ela roda em §2, imediatamente depois de:
#   (1) CREATE DATABASE nexus_test  (linha seguinte, adiante)
#   (2) 00001_initial_schema.sql aplicada com sucesso
#   (3) schema `nexus` efetivamente criado
# Ver `prova_negativa_inherit` abaixo.

$PSQL -X $HBOOT -d postgres -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB OWNER nexus_migrator;"
[ $? -eq 0 ] && ok "banco $DB criado com OWNER nexus_migrator (sem SUPERUSER)" || { bad "CREATE DATABASE"; exit 1; }
# Dono do banco pode ceder o schema `public` daquele banco a si mesmo.
$PSQL -X $H -d $DB -q -v ON_ERROR_STOP=1 -c "ALTER SCHEMA public OWNER TO nexus_migrator;"
[ $? -eq 0 ] && ok "schema public cedido a nexus_migrator (sem SUPERUSER)" || { bad "ALTER SCHEMA public" ; exit 1; }

echo
echo "================================================================================="
echo " 2. MIGRATIONS COMO nexus_migrator (contexto RLS de sessao)"
echo "================================================================================="
run_with_ctx nexus_migrator "00001_initial_schema"          "$DBDIR/migrations/00001_initial_schema.sql"

# =================================================================================================
# D-6 (R39) — PROVA NEGATIVA DE INHERIT FALSE, nas condicoes corretas
# =================================================================================================
# Requisitos atendidos neste ponto:
#   (1) `CREATE DATABASE $DB` ja executou (secao 1);
#   (2) `00001_initial_schema.sql` acabou de ser aplicada. Observe que `run_with_ctx` NAO aborta o
#       script em caso de falha (ele contabiliza em FAILS e segue). Por isso a funcao abaixo NAO
#       confia no sucesso da 00001: ela verifica a pre-condicao 3 diretamente (schema existe) e
#       falha com INCONCLUSIVO se ela nao valer. A pre-condicao e verificada, nao presumida;
#   (3) o schema `nexus` existe (criado por `CREATE SCHEMA nexus;` na 00001).
#
# A versao anterior desta prova rodava ANTES de o banco existir: o `psql` falhava por
# `database ... does not exist` (SQLSTATE de conexao, nao de privilegio) e a assercao passava
# mesmo com a regressao de INHERIT presente. Era um falso positivo.
#
# Agora exigimos o SQLSTATE ESPECIFICO `42501` (insufficient_privilege). Qualquer outra causa
# — banco inexistente, schema inexistente, falha de conexao, erro de sintaxe — e REJEITADA como
# inconclusiva, porque nao demonstra o que a prova afirma demonstrar.
prova_negativa_inherit() {
  local sqlstate out rc
  # Pre-condicao 3: o schema `nexus` tem de existir. Sem isso, `permission denied for schema`
  # nao poderia ser distinguido de `schema does not exist`.
  out=$($PSQL -X $HBOOT -d $DB -tAq -v ON_ERROR_STOP=1 2>&1 \
        -c "SELECT count(*) FROM pg_namespace WHERE nspname='nexus';")
  rc=$?
  if [ $rc -ne 0 ] || [ "$(echo "$out" | tr -d '[:space:]')" != "1" ]; then
    bad "D-6 pre-condicao: schema nexus ausente ou banco inacessivel (rc=$rc, saida='$out')"
    return 1
  fi

  # Captura o SQLSTATE REAL via \set VERBOSITY sqlstate nao existe; usamos o codigo do psql:
  # `-v ON_ERROR_STOP=1` faz o psql sair != 0 e a mensagem traz "ERROR: permission denied".
  # Para obter o SQLSTATE de forma inequivoca, executamos dentro de um bloco que o PRESERVA.
  out=$($PSQL -X $HBOOT -d $DB -q -v ON_ERROR_STOP=1 2>&1 \
        -c "\set VERBOSITY verbose" \
        -c "CREATE TABLE nexus.prova_infra(i int);" )
  rc=$?
  # psql com VERBOSITY verbose emite "ERROR:  42501: permission denied for schema nexus"
  sqlstate=$(printf '%s\n' "$out" | sed -n 's/.*ERROR: *\([0-9A-Z]\{5\}\):.*/\1/p' | head -1)

  if [ $rc -eq 0 ]; then
    bad "D-6 REGRESSAO: nexus_infra EXECUTOU DDL direto (herdou privilegios de nexus_migrator)"
    $PSQL -X $HBOOT -d $DB -q -c "DROP TABLE IF EXISTS nexus.prova_infra;"
    return 1
  fi
  if [ "$sqlstate" != "42501" ]; then
    bad "D-6 INCONCLUSIVO: esperava SQLSTATE 42501 (insufficient_privilege), obteve '${sqlstate:-<nenhum>}'"
    printf '%s\n' "$out" | sed 's/^/        /'
    return 1
  fi

  # Confirmacao positiva de que NENHUMA tabela foi criada (o efeito, nao a mensagem).
  out=$($PSQL -X $HBOOT -d $DB -tAq -v ON_ERROR_STOP=1 2>&1 \
        -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='nexus' AND c.relname='prova_infra';")
  if [ "$(echo "$out" | tr -d '[:space:]')" != "0" ]; then
    bad "D-6: a tabela prova_infra EXISTE no schema nexus (o DDL teve efeito)"
    return 1
  fi
  ok "D-6 prova negativa: DDL direto recusado com SQLSTATE 42501 e nenhuma tabela criada"
  return 0
}
prova_negativa_inherit || exit 1
run_with_ctx nexus_migrator "00002_auth_security"           "$DBDIR/migrations/00002_auth_security.sql"
run_with_ctx nexus_migrator "legacy-stage-2a (seed)"        "$DBDIR/tests/postgres/legacy-stage-2a.sql"
run_with_ctx nexus_migrator "00003_persistence_integrity"   "$DBDIR/migrations/00003_persistence_integrity.sql"
run_with_ctx nexus_migrator "verify-stage-2b"               "$DBDIR/tests/postgres/verify-stage-2b-migration.sql"
run_with_ctx nexus_migrator "00004_core_execution_hierarchy" "$DBDIR/migrations/00004_core_execution_hierarchy.sql"
run_with_ctx nexus_migrator "00005_assistant_seed_parity"   "$DBDIR/migrations/00005_assistant_seed_parity.sql"
run_with_ctx nexus_migrator "00006_assistant_seed_vivy"     "$DBDIR/migrations/00006_assistant_seed_vivy.sql"

# --- provisionamento do escritor, pelo PROPRIO nexus_migrator ---
echo
echo "--- provisionamento do nexus_audit_writer (por nexus_migrator) ---"
$PSQL -X $H -U nexus_migrator -d $DB -q -v ON_ERROR_STOP=1 >/tmp/i1.log 2>&1 <<'SQL'
CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
[ $? -eq 0 ] && ok "CREATE ROLE nexus_audit_writer por CREATEROLE" || { bad "CREATE ROLE"; cat /tmp/i1.log; }

$PSQL -X $H -U nexus_migrator -d $DB -q -v ON_ERROR_STOP=1 >/tmp/i2.log 2>&1 <<'SQL'
GRANT nexus_audit_writer TO nexus_migrator WITH SET TRUE;
SQL
[ $? -eq 0 ] && ok "GRANT ... WITH SET TRUE por nexus_migrator (tem ADMIN por ter criado o papel)" \
             || { bad "GRANT SET"; cat /tmp/i2.log; }

# DESTES QUATRO GRANTS, apenas UM e necessario, e ele e executado pelo DONO DO SCHEMA — nunca pelo
# superusuario (era a ultima etapa do R38 que ainda dependia de `postgres`):
#
#   * `GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer`  -> NECESSARIO.
#     `ALTER FUNCTION ... OWNER TO nexus_audit_writer` exige que o novo dono tenha CREATE no
#     schema onde o objeto vive. Sem isso a 00007 falha.
#   * `GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_migrator`      -> REDUNDANTE: e o dono.
#   * `GRANT ALL ON ALL TABLES/SEQUENCES ... TO nexus_migrator`    -> REDUNDANTE: aplicou
#     00001-00006 e portanto e dono de todas as tabelas/sequences do schema.
#
# Removidas as tres redundantes, a instalacao inteira deixa de emitir qualquer DDL/GRANT como
# superusuario. O efeito de cada uma e comprovado pelo proprio resultado da 00007 e pelos
# verificadores que checam ACL de tabela e de tipo.
$PSQL -X $H -U nexus_migrator -d $DB -q -v ON_ERROR_STOP=1 >/tmp/i3.log 2>&1 \
  -c "GRANT USAGE, CREATE ON SCHEMA nexus TO nexus_audit_writer;"
[ $? -eq 0 ] && ok "GRANT USAGE,CREATE ON SCHEMA nexus TO nexus_audit_writer (pelo DONO do schema)" \
             || { bad "GRANT schema a writer"; cat /tmp/i3.log; }

run_with_ctx nexus_migrator "00007_tool_grants_and_preferences" "$DBDIR/migrations/00007_tool_grants_and_preferences.sql"

echo
echo "--- verificacao de idempotencia de seeds (00005/00006 reaplicadas) ---"
cp "$DBDIR"/migrations/*.sql /tmp/
run_as nexus_migrator "verify-assistant-seed-parity" "$DBDIR/tests/postgres/verify-assistant-seed-parity.sql"

echo
echo "================================================================================="
echo " 3. BOOTSTRAP (cria nexus_app/nexus_anonymous e concede privilegios)"
echo "================================================================================="
# O bootstrap exige que os papeis NAO existam e roda verificacoes de catalogo.
run_as nexus_migrator "bootstrap.sql" "$DBDIR/tests/postgres/bootstrap.sql"

# O provisionador PRECISA poder assumir os papeis de runtime para os verificadores que fazem
# SET ROLE (cascade). No PG 16+ quem cria um papel recebe membership com admin=true e set=false;
# `SET ROLE` exige set=true. Nao e escalada: o migrator ja e dono do schema nexus e nao ganha
# nenhum acesso novo por assumir nexus_app — so perde, na verdade, o privilegio de dono.
# Auto-concessao: o migrator CRIOU estes papeis (via bootstrap), logo tem ADMIN sobre eles.
$PSQL -X $H -d $DB -q -v ON_ERROR_STOP=1 -c "GRANT nexus_app TO nexus_migrator WITH SET TRUE;"
[ $? -eq 0 ] || { bad "GRANT SET nexus_app"; exit 1; }
$PSQL -X $H -d $DB -q -v ON_ERROR_STOP=1 -c "GRANT nexus_anonymous TO nexus_migrator WITH SET TRUE;"
[ $? -eq 0 ] || { bad "GRANT SET nexus_anonymous"; exit 1; }
ok "nexus_migrator pode assumir os papeis de runtime (SET TRUE, sem SUPERUSER)"

echo
echo "================================================================================="
echo " 3b. VERIFICADORES QUE EXIGEM TABELAS DA FASE 5 VAZIAS"
echo "================================================================================="
# ORDEM — e aqui esta uma INCOMPATIBILIDADE REAL do script oficial que so nao aparece porque o
# CI roda cada verificador num banco recem-criado:
#   * owner-deletion exige `assistant_memories` SEMEADA, e quem a semeia e `integration.sql`;
#   * owner-deletion tambem exige `tool_grants`/`tool_grant_audit`/`user_assistant_preferences`
#     VAZIAS — e `integration.sql` NAO escreve nessas tabelas (elas sao da Fase 5).
# Logo a ordem correta e: integration.sql PRIMEIRO (semeia memories), DEPOIS owner-deletion.
# grants-lifecycle e preferences rodam antes porque escrevem nas tabelas da Fase 5 e o
# owner-deletion as exige vazias.
run_as nexus_app "integration.sql (runtime real)" "$DBDIR/tests/postgres/integration.sql"

# ORDEM CRITICA, e a razao e dura: `tool_grant_audit` e APPEND-ONLY (so tem policies de SELECT e
# INSERT; `DELETE` afeta 0 linhas SEM erro, inclusive para o dono sob FORCE RLS). Depois que
# QUALQUER verificador escreve na trilha, o banco deixa de servir para o teste de cascata, que
# exige as tabelas da Fase 5 vazias. Nao existe "limpar entre cenarios" possivel: a unica saida e
# rodar o cascade AGORA, antes dos verificadores que escrevem, e nao reciclar o banco depois.
run_as nexus_migrator "verify-stage-5-cascade-without-delete-policy" "$DBDIR/tests/postgres/verify-stage-5-cascade-without-delete-policy.sql"
run_as nexus_migrator "verify-stage-5-grants-lifecycle" "$DBDIR/tests/postgres/verify-stage-5-grants-lifecycle.sql"
run_as nexus_migrator "verify-stage-5-preferences" "$DBDIR/tests/postgres/verify-stage-5-preferences.sql"
run_as nexus_migrator "verify-stage-5-owner-deletion" "$DBDIR/tests/postgres/verify-stage-5-owner-deletion.sql"

echo
echo "================================================================================="
echo " 3c. RLS COMO nexus_app + CASCATA"
echo "================================================================================="
run_as nexus_app "verify-stage-5-rls (como nexus_app)" "$DBDIR/tests/postgres/verify-stage-5-rls.sql"
# Estas verificacoes deixam linhas nas tabelas da Fase 5 (por design: precisam de dados reais).
# O cascade exige `tool_grants` vazia e roda PRIMEIRO, antes dos verificadores que escrevem.
# Nao existe "limpar e rodar de novo": `tool_grant_audit` e APPEND-ONLY (so tem policies de SELECT
# e INSERT), entao `DELETE` afeta 0 linhas SEM erro — nem o dono da tabela consegue limpar sob
# FORCE RLS. A unica sequencia valida e banco recem-instalado -> cascade -> demais verificadores.

echo
echo "================================================================================="
echo " 4. RESULTADO DA INSTALACAO"
echo "================================================================================="
# D-7 (R39): ESTAS CONSULTAS TINHAM O STATUS IGNORADO. Se o banco nao existisse (ou qualquer
# consulta falhasse), o script imprimia "SEM SUPERUSER EM NENHUMA ETAPA" e saia com 0 — mesmo com
# a instalacao inteira perdida. Cada consulta agora tem o status verificado e uma falha incrementa
# FAILS, de modo que o resumo final nao pode ser exit 0.
consulta() {                      # consulta <rotulo> <sql>
  local rotulo="$1" sql="$2" out rc
  out=$($PSQL -X $H -d $DB -tAq -v ON_ERROR_STOP=1 -c "$sql" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then printf '%s\n' "$out"
  else bad "consulta de resultado falhou ($rotulo): $(printf '%s\n' "$out" | head -1)"; fi
}

n_tabelas=$(consulta "tabelas nexus" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND c.relkind='r';")
n_force=$(consulta   "FORCE RLS"     "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nexus' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;")
n_pol=$(consulta     "policies"      "SELECT count(*) FROM pg_policies WHERE schemaname='nexus';")
n_fk=$(consulta      "FKs"           "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='nexus' AND c.contype='f';")
dono=$(consulta      "dono da funcao" "SELECT pg_get_userbyid(proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nexus' AND p.proname='audit_tool_grant_change';")

say "   tabelas nexus: $n_tabelas"
say "   FORCE RLS: $n_force"
say "   policies: $n_pol"
say "   FKs: $n_fk"
say "   dono de audit_tool_grant_change(): $dono"
# As contagens nao sao decorativas: sao o retrato do estado instalado. Conferi-las impede que uma
# instalacao parcial (por exemplo, 0 tabelas) seja reportada como sucesso.
[ "$n_tabelas" = "27" ] || bad "esperava 27 tabelas em nexus, encontrei '${n_tabelas:-<vazio>}'"
[ "$n_force"   = "20" ] || bad "esperava 20 tabelas com FORCE RLS, encontrei '${n_force:-<vazio>}'"
[ "$n_pol"     = "49" ] || bad "esperava 49 policies, encontrei '${n_pol:-<vazio>}'"
[ "$n_fk"      = "56" ] || bad "esperava 56 FKs, encontrei '${n_fk:-<vazio>}'"
[ "$dono" = "nexus_audit_writer" ] || bad "esperava dono nexus_audit_writer, encontrei '${dono:-<vazio>}'"

echo
echo "--- atributos dos tres papeis ---"
out=$($PSQL -X $H -d postgres -v ON_ERROR_STOP=1 -c "
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolinherit
FROM pg_roles WHERE rolname IN ('nexus_migrator','nexus_app','nexus_anonymous','nexus_audit_writer')
ORDER BY 1;" 2>&1); rc=$?
printf '%s\n' "$out" | sed 's/^/   /'
[ $rc -eq 0 ] || bad "consulta de atributos dos papeis falhou"

echo
# A mensagem final so pode afirmar ausencia de superuser se TODAS as assercoes passaram. Ela deixa
# de ser uma afirmacao incondicional: e o resultado de FAILS == 0.
if [ $FAILS -eq 0 ]; then
  say "== INSTALACAO LIMPA: nenhuma etapa executou como SUPERUSER (exceto o bootstrap do 1o papel) =="
  exit 0
else
  say "== $FAILS FALHA(S) =="
  exit 1
fi

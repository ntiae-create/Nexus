#!/bin/sh
# =============================================================================
# NEXUS — instalacao do banco em PRODUCAO (Railway), em tres fases
# =============================================================================
#   FASE 1  (admin)    00_prepare.sql        papeis + permissoes administrativas
#   FASE 1b (admin)    senhas               via verificador SCRAM, sem texto claro
#   FASE 2  (migrator) migrate.sh           as 8 migrations
#   FASE 3  (migrator) 20_grant_runtime.sql GRANTs de runtime para nexus_app
#   VERIF   (migrator) 30_verify.sql        conferencia final
#
# POR QUE A SENHA VEM ANTES DAS MIGRATIONS
# Este script e nao-interativo depois de coletar as senhas. Se ele deixasse as
# senhas para o fim, a fase 2 precisaria autenticar como nexus_migrator antes de
# o papel ter senha — e a unica saida seria uma segunda conexao administrativa
# no meio do processo. Coletar antes elimina esse caminho.
#
# COMO A SENHA E APLICADA SEM TEXTO CLARO
# Nao usamos `ALTER ROLE ... PASSWORD 'senha'`. Geramos localmente o verificador
# SCRAM-SHA-256 (o mesmo formato que o PostgreSQL guardaria) com gen-scram.mjs e
# enviamos apenas o verificador. Medido num cluster com SCRAM obrigatorio:
#   * o verificador aplicado autentica a senha real        -> OK
#   * o proprio verificador usado como senha e recusado    -> OK
#   * `pg_authid.rolpassword` guarda o hash, nunca a senha -> OK
#
# CREDENCIAIS
# Host/porta/banco vem de PGHOST/PGPORT/PGDATABASE (padrao do libpq). A senha do
# admin e pedida com eco desligado, usada so em memoria, e nunca e impressa.
# Nenhuma URL completa e montada na linha de comando.
#
# Uso (a partir da raiz do repositorio):
#   PGHOST=... PGPORT=... PGDATABASE=railway sh packages/database/scripts/production/install-production.sh
#
# Idempotente: as tres fases podem ser re-executadas. Nenhum DROP, nenhum DELETE.
# Nao altera a aplicacao. Nao toca em servico do Railway.
# =============================================================================
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
migrate_sh="$script_dir/../migrate.sh"
[ -f "$migrate_sh" ] || {
  echo "migrate.sh nao encontrado em $migrate_sh" >&2
  exit 2
}

psql_bin=${PSQL_BIN:-psql}
command -v "$psql_bin" >/dev/null 2>&1 || {
  echo "psql nao encontrado. Instale o cliente do PostgreSQL ou defina PSQL_BIN." >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "node nao encontrado (necessario para gerar o verificador SCRAM)." >&2
  exit 2
}

: "${PGHOST:?defina PGHOST (Railway: host do Tcp Proxy)}"
: "${PGPORT:?defina PGPORT (Railway: porta do Tcp Proxy)}"
: "${PGDATABASE:?defina PGDATABASE (Railway: railway)}"

ssl_mode=${PGSSLMODE:-require}

redact() {
  sed -E 's#(postgres(ql)?)://[^ 　"]*#<redacted-url>#g'
}

echo "Alvo: $PGHOST:$PGPORT/$PGDATABASE (sslmode=$ssl_mode)"
echo

ask_password() {
  _role=$1
  _prompt=$2
  printf '%s' "$_prompt"
  stty -echo 2>/dev/null || true
  IFS= read -r _pw
  stty echo 2>/dev/null || true
  printf '\n'
  if [ -z "$_pw" ]; then
    echo "Valor vazio para $_role — abortado." >&2
    exit 2
  fi
  eval "PW_${_role}=\$_pw"
  unset _pw
}

# Verificador SCRAM gerado localmente a partir da senha. O hash vai para o banco;
# a senha em texto claro fica apenas na variavel PW_* desta sessao.
scram_verifier() {
  printf '%s' "$1" | SENHA_FROM_STDIN=1 node -e '
    const crypto = require("node:crypto");
    let pw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (pw += c));
    process.stdin.on("end", () => {
      if (pw.length < 12) { process.stderr.write("curta\n"); process.exit(2); }
      const salt = crypto.randomBytes(16);
      const salted = crypto.pbkdf2Sync(Buffer.from(pw, "utf8"), salt, 4096, 32, "sha256");
      const ck = crypto.createHmac("sha256", salted).update("Client Key").digest();
      const sk = crypto.createHash("sha256").update(ck).digest();
      const sv = crypto.createHmac("sha256", salted).update("Server Key").digest();
      process.stdout.write(`SCRAM-SHA-256$4096:${salt.toString("base64")}$${sk.toString("base64")}:${sv.toString("base64")}`);
    });
  '
}

# =============================================================================
echo "=================================================================="
echo "FASE 1 de 3 — papeis e permissoes administrativas"
echo "=================================================================="
ask_password postgres "Senha do usuario 'postgres' (admin do Railway): "
echo

prepare_log=$(mktemp)
if ! PGPASSWORD=$PW_postgres PGUSER=postgres \
     "$psql_bin" --no-psqlrc --set ON_ERROR_STOP=1 \
     --file "$script_dir/00_prepare.sql" >"$prepare_log" 2>&1; then
  redact < "$prepare_log" >&2
  rm -f "$prepare_log"
  echo >&2
  echo "FASE 1 FALHOU. Nada foi aplicado no schema nexus." >&2
  echo "Se a mensagem foi 'password authentication failed', a senha do admin esta" >&2
  echo "errada. Se foi 'permission denied', o usuario nao e administrador." >&2
  exit 1
fi
redact < "$prepare_log"
rm -f "$prepare_log"

# -----------------------------------------------------------------------------
# FASE 1b — senhas dos dois papeis de login, aplicadas como admin
# -----------------------------------------------------------------------------
echo
echo "--- senhas dos papeis (minimo 12 caracteres; use gerenciador de segredos) ---"
echo

ask_password nexus_migrator "Nova senha para nexus_migrator (fica oculta): "
PW1_hash=$(scram_verifier "$PW_nexus_migrator") || {
  echo "Senha de nexus_migrator recusada (minimo 12 caracteres)." >&2; exit 2; }

ask_password nexus_app "Nova senha para nexus_app (fica oculta): "
PW2_hash=$(scram_verifier "$PW_nexus_app") || {
  echo "Senha de nexus_app recusada (minimo 12 caracteres)." >&2; exit 2; }

# O verificador contem apenas [A-Za-z0-9+/=:$], nunca aspas — a interpolacao e
# segura. `ALTER ROLE ... PASSWORD '<verificador>'` grava o hash como esta.
pw_log=$(mktemp)
if ! PGPASSWORD=$PW_postgres PGUSER=postgres \
     "$psql_bin" --no-psqlrc --set ON_ERROR_STOP=1 -q \
     -c "ALTER ROLE nexus_migrator PASSWORD '$PW1_hash';" \
     -c "ALTER ROLE nexus_app PASSWORD '$PW2_hash';" >"$pw_log" 2>&1; then
  redact < "$pw_log" >&2
  rm -f "$pw_log"
  echo "Falha ao definir as senhas. As fases seguintes nao rodaram." >&2
  exit 1
fi
rm -f "$pw_log"
echo "  senhas definidas (verificador SCRAM; a senha em texto claro nunca saiu daqui)"
unset PW_postgres PW1_hash PW2_hash
unset PW_nexus_migrator PW_nexus_app

# =============================================================================
echo
echo "=================================================================="
echo "FASE 2 de 3 — migrations (como nexus_migrator)"
echo "=================================================================="
# As senhas acabaram de ser definidas; pedimos de novo para a fase 2, porque o
# script nao as mantem em memoria mais tempo que o necessario.
ask_password migrator_pw "Senha de nexus_migrator (a que voce acabou de definir): "
echo

encoded_pw=$(printf '%s' "$PW_migrator_pw" \
  | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's#/#%2F#g' \
        -e 's/?/%3F/g' -e 's/#/%23/g')
NEXUS_MIGRATION_DATABASE_URL="postgresql://nexus_migrator:${encoded_pw}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=${ssl_mode}"
export NEXUS_MIGRATION_DATABASE_URL
unset encoded_pw

# `set -e` nao enxerga a falha de um comando dentro de pipe; por isso a saida
# vai para um arquivo e o codigo de saida e checado no comando, nao no pipe.
# (Descoberto em teste: com o pipe, "Aborted" nao interrompia nada e o script
# imprimia CONCLUIDO com o banco vazio.)
migrate_log=$(mktemp)
if ! NEXUS_MIGRATE_ASSUME_YES=1 sh "$migrate_sh" >"$migrate_log" 2>&1; then
  redact < "$migrate_log" >&2
  rm -f "$migrate_log"
  echo >&2
  echo "FASE 2 FALHOU. Migrations posteriores NAO rodaram." >&2
  echo "NAO re-execute nada antes de rodar a verificacao (fase de leitura):" >&2
  echo "    PGPASSWORD=<senha> PGUSER=nexus_migrator psql -f 30_verify.sql" >&2
  echo "e ler a secao 'Diagnostico' de docs/deploy/MIGRAR_RAILWAY.md." >&2
  exit 1
fi
redact < "$migrate_log"
rm -f "$migrate_log"
unset NEXUS_MIGRATION_DATABASE_URL

# =============================================================================
echo
echo "=================================================================="
echo "FASE 3 de 3 — permissoes de runtime (nexus_app)"
echo "=================================================================="
grant_log=$(mktemp)
if ! PGPASSWORD=$PW_migrator_pw PGUSER=nexus_migrator \
     "$psql_bin" --no-psqlrc --set ON_ERROR_STOP=1 \
     --file "$script_dir/20_grant_runtime.sql" >"$grant_log" 2>&1; then
  redact < "$grant_log" >&2
  rm -f "$grant_log"
  echo >&2
  echo "FASE 3 FALHOU. As migrations estao aplicadas, mas nexus_app nao tem os" >&2
  echo "GRANTs completos — a API respondera erro de permissao. Re-execute so esta" >&2
  echo "fase; nao ha necessidade de reaplicar migrations." >&2
  exit 1
fi
redact < "$grant_log"
rm -f "$grant_log"

# =============================================================================
echo
echo "=================================================================="
echo "VERIFICACAO"
echo "=================================================================="
# A verificacao roda com ON_ERROR_STOP dentro do 30_verify.sql e FALHA de
# verdade (RAISE EXCEPTION no primeiro invariante violado).
#
# O codigo de saida TEM de vir do psql, nao de um pipe: em
#     psql ... 2>&1 | redact
# o shell reporta o status do `redact`, que sempre sai 0 — foi assim que uma
# versao anterior deste script imprimia "CONCLUIDO" sobre uma verificacao que
# tinha falhado. Saida vai para arquivo; o status e checado no comando.
verify_log=$(mktemp)
if ! PGPASSWORD=$PW_migrator_pw PGUSER=nexus_migrator \
     "$psql_bin" --no-psqlrc --set ON_ERROR_STOP=1 \
     --file "$script_dir/30_verify.sql" >"$verify_log" 2>&1; then
  redact < "$verify_log" >&2
  rm -f "$verify_log"
  unset PW_migrator_pw
  echo >&2
  echo "==================================================================" >&2
  echo "VERIFICACAO FALHOU — NAO CONCLUIDO" >&2
  echo "==================================================================" >&2
  echo "Um invariante obrigatorio nao se confirmou (ver FALHA: acima)." >&2
  echo "O banco NAO esta pronto: nao aponte NEXUS_DATABASE_URL para ele nem" >&2
  echo "libere acesso pela API antes de resolver." >&2
  echo "" >&2
  echo "As fases 1-3 ja foram aplicadas; re-executa-las e idempotente. Se a" >&2
  echo "falha for de privilegio (FALTA GRANT), re-execute so a fase 3:" >&2
  echo "  psql -f $script_dir/20_grant_runtime.sql" >&2
  echo "Consulte a secao 'Diagnostico' de docs/deploy/MIGRAR_RAILWAY.md." >&2
  exit 1
fi
redact < "$verify_log"
rm -f "$verify_log"
unset PW_migrator_pw

echo
echo "=================================================================="
echo "CONCLUIDO"
echo "=================================================================="
echo "Proximo passo: no Vercel, aponte NEXUS_DATABASE_URL para o usuario"
echo "nexus_app, usando o host/porta do Tcp Proxy e ?sslmode=require."
echo "Depois teste a API publicada (runbook, secao 4)."
echo
echo "O Vercel NAO alcanca a URL privada do Railway (postgres.railway.internal)."

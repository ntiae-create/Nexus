#!/bin/sh
# =============================================================================
# NEXUS — produção do banco PostgreSQL (Railway); sem tocar Railway/Vercel
# =============================================================================
#   PREFLIGHT (admin, somente-leitura)  papéis, ACLs, ownership, funções e ledger
#   FASE 1     (admin)                  00_prepare.sql
#   CREDENCIAIS                         \password do psql só para papéis recém-criados
#                                       ou com --rotate-passwords explícito
#   FASE 2     (nexus_migrator)         migrate.sh (DDL + ledger atômicos)
#   FASE 3     (nexus_migrator)         20_grant_runtime.sql
#   VERIFICAÇÃO (nexus_migrator)        30_verify.sql
#
# Credenciais nunca são passadas em URLs, argv, PGPASSWORD, ambiente ou logs.
# Autenticação libpq usa arquivos passfile privados (0600) removidos no trap;
# psql \password oculta os segredos e evita gravá-los no histórico/query log.
# =============================================================================
set -eu
umask 077

usage() {
  cat <<'USAGE'
Uso:
  PGHOST=... PGPORT=... PGDATABASE=... [PGSSLMODE=require] \
    sh packages/database/scripts/production/install-production.sh [opções]

Opções:
  --rotate-passwords       rotaciona intencionalmente nexus_migrator e nexus_app
  --adopt-legacy-ledger    valida 30_verify.sql e adota checksums em ledger legado completo
  --help                   mostra esta ajuda

Sem --rotate-passwords, senhas existentes são preservadas. Uma senha só é
criada automaticamente quando o respectivo papel de login ainda não existia.
USAGE
}

rotate_passwords=0
adopt_legacy=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --rotate-passwords) rotate_passwords=1 ;;
    --adopt-legacy-ledger) adopt_legacy=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if [ "$rotate_passwords" -eq 1 ] && [ "$adopt_legacy" -eq 1 ]; then
  echo "Não combine rotação de senhas com adoção de ledger legado; faça em execuções separadas." >&2
  exit 2
fi

if [ -n "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD não é aceito. Remova-o do ambiente e use o prompt interativo." >&2
  exit 2
fi
if [ "${NEXUS_MIGRATION_DATABASE_URL+x}" = x ]; then
  echo "NEXUS_MIGRATION_DATABASE_URL não é aceito; use PGHOST/PGPORT/PGDATABASE e PGPASSFILE temporário." >&2
  exit 2
fi
unset PGPASSWORD PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS

: "${PGHOST:?defina PGHOST (host TCP do PostgreSQL)}"
: "${PGPORT:?defina PGPORT (porta TCP do PostgreSQL)}"
: "${PGDATABASE:?defina PGDATABASE (banco-alvo exato)}"
case "$PGHOST" in
  *://*|*@*|*'?'*|*'#'*|*[!A-Za-z0-9._:-]*)
    echo "PGHOST deve conter apenas hostname/endereço (não URL nem credencial)." >&2; exit 2 ;;
esac
case "$PGDATABASE" in
  ""|*[!A-Za-z0-9_.-]*) echo "PGDATABASE deve conter apenas letras, números, ponto, underscore ou hífen." >&2; exit 2 ;;
esac
case "$PGPORT" in
  ""|*[!0-9]*) echo "PGPORT deve ser numérico." >&2; exit 2 ;;
esac
port_number=$(printf '%s' "$PGPORT" | sed 's/^0*//')
[ -n "$port_number" ] || port_number=0
[ "$port_number" -ge 1 ] 2>/dev/null && [ "$port_number" -le 65535 ] 2>/dev/null || {
  echo "PGPORT deve estar entre 1 e 65535." >&2; exit 2;
}

# TLS é obrigatório; require cifra a conexão. Se houver CA configurada,
# verify-ca/verify-full também valida o certificado do proxy.
ssl_mode=${PGSSLMODE:-require}
case "$ssl_mode" in
  require|verify-ca|verify-full) ;;
  *) echo "PGSSLMODE deve ser require, verify-ca ou verify-full; TLS não pode ser desativado." >&2; exit 2 ;;
esac
export PGSSLMODE="$ssl_mode"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
migrate_sh="$script_dir/../migrate.sh"
preflight_sql="$script_dir/00_preflight.sql"
prepare_sql="$script_dir/00_prepare.sql"
grant_sql="$script_dir/20_grant_runtime.sql"
verify_sql="$script_dir/30_verify.sql"
for file in "$migrate_sh" "$preflight_sql" "$prepare_sql" "$grant_sql" "$verify_sql"; do
  [ -f "$file" ] || { echo "Arquivo de produção ausente: $file" >&2; exit 2; }
done
psql_bin=${PSQL_BIN:-psql}
command -v "$psql_bin" >/dev/null 2>&1 || {
  echo "psql não encontrado. Instale o cliente do PostgreSQL ou defina PSQL_BIN." >&2
  exit 2
}

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/nexus-production.XXXXXX") || {
  echo "Não foi possível criar diretório temporário privado." >&2; exit 2;
}
admin_passfile="$work_dir/admin.pgpass"
migrator_passfile="$work_dir/migrator.pgpass"
prepare_log="$work_dir/prepare.log"
preflight_log="$work_dir/preflight.log"
ledger_log="$work_dir/ledger-check.log"
password_log="$work_dir/password-check.log"
grant_log="$work_dir/grant.log"
verify_log="$work_dir/verify.log"
tty_echo_disabled=0

restore_tty_echo() {
  if [ "$tty_echo_disabled" -eq 1 ]; then
    stty echo </dev/tty 2>/dev/null || true
    tty_echo_disabled=0
  fi
}
cleanup() {
  exit_status=$?
  trap - 0 HUP INT TERM
  restore_tty_echo
  unset admin_password migrator_password secret_reply REPLY
  if [ -n "${work_dir:-}" ] && [ -d "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
  exit "$exit_status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# If a controlling terminal is available, read directly from it with echo off;
# in a pipe-based test, stdin itself is non-echoing. Failure to disable a real
# terminal's echo is fatal instead of silently exposing a password.
read_secret() {
  prompt=$1
  secret_reply=
  read_status=0
  if [ -t 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s' "$prompt" >/dev/tty
    if ! stty -echo </dev/tty 2>/dev/null; then
      echo "Não foi possível desativar o eco do terminal; senha não lida." >&2
      return 2
    fi
    tty_echo_disabled=1
    if IFS= read -r secret_reply </dev/tty; then read_status=0; else read_status=$?; fi
    restore_tty_echo
    printf '\n' >/dev/tty
  else
    printf '%s' "$prompt" >&2
    if IFS= read -r secret_reply; then read_status=0; else read_status=$?; fi
    printf '\n' >&2
  fi
  if [ "$read_status" -ne 0 ]; then
    echo "Entrada encerrada antes de receber a senha." >&2
    return 2
  fi
  if [ -z "$secret_reply" ]; then
    echo "Senha vazia; operação cancelada." >&2
    return 2
  fi
  REPLY=$secret_reply
  unset secret_reply
}

# libpq passfiles escape backslash and colon. The file is created under umask
# 077 and chmod 0600; its pathname, not its content, is the only env value.
pgpass_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g'
}
write_passfile() {
  target_file=$1
  target_role=$2
  target_password=$3
  host_field=$(pgpass_escape "$PGHOST")
  port_field=$(pgpass_escape "$PGPORT")
  database_field=$(pgpass_escape "$PGDATABASE")
  role_field=$(pgpass_escape "$target_role")
  password_field=$(pgpass_escape "$target_password")
  printf '%s:%s:%s:%s:%s\n' "$host_field" "$port_field" "$database_field" "$role_field" "$password_field" > "$target_file"
  chmod 600 "$target_file"
  unset host_field port_field database_field role_field password_field target_password
}

redact() {
  sed -E \
    -e 's#(postgres(ql)?|mysql|mongodb(\+srv)?)://[^[:space:]" ]*#<redacted-url>#g' \
    -e 's#SCRAM-SHA-256[^[:space:]]*#<redacted-verifier>#g' \
    -e 's#role "[^"]*"#role <redacted>#g'
}

admin_psql() {
  PGPASSFILE="$admin_passfile" PGHOST="$PGHOST" PGPORT="$PGPORT" \
  PGDATABASE="$PGDATABASE" PGUSER=postgres PGSSLMODE="$ssl_mode" \
    "$psql_bin" --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@"
}
migrator_psql() {
  PGPASSFILE="$migrator_passfile" PGHOST="$PGHOST" PGPORT="$PGPORT" \
  PGDATABASE="$PGDATABASE" PGUSER=nexus_migrator PGSSLMODE="$ssl_mode" \
    "$psql_bin" --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@"
}
run_admin_file() {
  sql_file=$1
  output_file=$2
  if ! admin_psql --file "$sql_file" >"$output_file" 2>&1; then
    redact < "$output_file" >&2
    return 1
  fi
  redact < "$output_file"
}
admin_scalar() {
  sql=$1
  if ! admin_psql --tuples-only --no-align --command "$sql" >"$password_log" 2>"$work_dir/query.err"; then
    redact < "$work_dir/query.err" >&2
    return 1
  fi
  tr -d '\r\n' < "$password_log"
}

printf '%s\n' "Alvo confirmado: $PGHOST:$PGPORT/$PGDATABASE (sslmode=$ssl_mode)"
printf '%s\n' "Nenhuma alteração é feita no Railway/Vercel por este script; confirme que o banco-alvo é o pretendido."
read_secret "Senha do administrador PostgreSQL (postgres; entrada oculta): " || exit 2
admin_password=$REPLY
unset REPLY
write_passfile "$admin_passfile" postgres "$admin_password"
unset admin_password

# FATAL read-only preflight: no managed-role password is asked/set and no
# migration is run before the SQL and ledger checks both succeed.
if ! run_admin_file "$preflight_sql" "$preflight_log"; then
  echo "PREFLIGHT FALHOU. Nenhuma senha de nexus_* foi pedida/alterada e nenhuma migration foi iniciada." >&2
  exit 1
fi

# Inspect the ledger using the same local migration files before phase 1.
if env PGHOST="$PGHOST" PGPORT="$PGPORT" PGDATABASE="$PGDATABASE" PGUSER=postgres \
       PGPASSFILE="$admin_passfile" PGSSLMODE="$ssl_mode" PSQL_BIN="$psql_bin" \
       sh "$migrate_sh" --check-only >"$ledger_log" 2>&1; then
  ledger_check_status=0
else
  ledger_check_status=$?
fi
case "$ledger_check_status" in
  0)
    redact < "$ledger_log"
    if [ "$adopt_legacy" -eq 1 ]; then
      echo "--adopt-legacy-ledger foi especificado, mas o ledger não é legado." >&2
      exit 2
    fi
    legacy_ledger=0
    ;;
  10)
    redact < "$ledger_log" >&2
    if [ "$adopt_legacy" -ne 1 ]; then
      echo "Ledger legado exige revisão/backup e a opção explícita --adopt-legacy-ledger; nenhum papel/senha/migration foi alterado." >&2
      exit 2
    fi
    legacy_ledger=1
    ;;
  *)
    redact < "$ledger_log" >&2
    echo "PREFLIGHT DO LEDGER FALHOU. Nenhuma senha de nexus_* foi pedida/alterada e nenhuma migration foi iniciada." >&2
    exit 1
    ;;
esac

migrator_existed=$(admin_scalar "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_migrator')")
app_existed=$(admin_scalar "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app')")
# psql serializes booleans as t/f; normalize in case a client formats true/false.
case "$migrator_existed" in t|true) migrator_existed=1 ;; f|false) migrator_existed=0 ;; *) echo "Could not determine nexus_migrator existence." >&2; exit 1 ;; esac
case "$app_existed" in t|true) app_existed=1 ;; f|false) app_existed=0 ;; *) echo "Could not determine nexus_app existence." >&2; exit 1 ;; esac

# Phase 1 re-runs the read-only SQL preflight immediately before its idempotent
# role/GRANT statements, limiting the time-of-check/time-of-use window.
if ! run_admin_file "$prepare_sql" "$prepare_log"; then
  echo "FASE 1 FALHOU. Nenhuma migration foi iniciada; consulte o erro acima." >&2
  exit 1
fi

set_migrator_password=0
set_app_password=0
if [ "$rotate_passwords" -eq 1 ]; then
  set_migrator_password=1
  set_app_password=1
else
  [ "$migrator_existed" -eq 1 ] || set_migrator_password=1
  [ "$app_existed" -eq 1 ] || set_app_password=1
fi

# psql's \password prompts with echo disabled and uses libpq's protected password
# path; no plaintext or SCRAM verifier is placed in shell argv, SQL command text,
# environment, or local logs. The BEGIN/COMMIT makes an explicit two-role rotation
# all-or-nothing. Ordinary re-runs never execute \password.
if [ "$set_migrator_password" -eq 1 ] || [ "$set_app_password" -eq 1 ]; then
  echo "Guarde as senhas novas no gerenciador de segredos. nexus_app não será exibida nem recuperável pelo instalador." >&2
  if [ "$set_migrator_password" -eq 1 ] && [ "$set_app_password" -eq 1 ]; then
    if ! admin_psql --command 'BEGIN;' \
                    --command '\password nexus_migrator' \
                    --command '\password nexus_app' \
                    --command 'COMMIT;'; then
      echo "Definição de senhas falhou; nenhuma migration foi iniciada. Se ocorreu durante rotação, consulte a transação/saída e autentique antes de repetir." >&2
      exit 1
    fi
  elif [ "$set_migrator_password" -eq 1 ]; then
    if ! admin_psql --command 'BEGIN;' \
                    --command '\password nexus_migrator' \
                    --command 'COMMIT;'; then
      echo "Definição da senha de nexus_migrator falhou; nenhuma migration foi iniciada." >&2
      exit 1
    fi
  else
    if ! admin_psql --command 'BEGIN;' \
                    --command '\password nexus_app' \
                    --command 'COMMIT;'; then
      echo "Definição da senha de nexus_app falhou; nenhuma migration foi iniciada." >&2
      exit 1
    fi
  fi
fi

# Authentication material is now limited to this mode-0600 temporary file.
read_secret "Senha atual/nova de nexus_migrator para a fase de migrations (entrada oculta): " || exit 2
migrator_password=$REPLY
unset REPLY
write_passfile "$migrator_passfile" nexus_migrator "$migrator_password"
unset migrator_password
rm -f "$admin_passfile"

run_migrate() {
  migrate_option=$1
  if [ -n "$migrate_option" ]; then
    if ! env PGHOST="$PGHOST" PGPORT="$PGPORT" PGDATABASE="$PGDATABASE" PGUSER=nexus_migrator \
         PGPASSFILE="$migrator_passfile" PGSSLMODE="$ssl_mode" PSQL_BIN="$psql_bin" \
         NEXUS_MIGRATE_ASSUME_YES=1 sh "$migrate_sh" "$migrate_option" >"$ledger_log" 2>&1; then
      redact < "$ledger_log" >&2
      return 1
    fi
  else
    if ! env PGHOST="$PGHOST" PGPORT="$PGPORT" PGDATABASE="$PGDATABASE" PGUSER=nexus_migrator \
         PGPASSFILE="$migrator_passfile" PGSSLMODE="$ssl_mode" PSQL_BIN="$psql_bin" \
         NEXUS_MIGRATE_ASSUME_YES=1 sh "$migrate_sh" >"$ledger_log" 2>&1; then
      redact < "$ledger_log" >&2
      return 1
    fi
  fi
  redact < "$ledger_log"
}

run_migrator_file() {
  sql_file=$1
  output_file=$2
  if ! migrator_psql --file "$sql_file" >"$output_file" 2>&1; then
    redact < "$output_file" >&2
    return 1
  fi
  redact < "$output_file"
}

# A legacy ledger is never silently blessed. The explicit recovery path first
# restores the known runtime grants, then runs the full read-only verifier and
# only then stores hashes. No migration SQL is rerun during adoption.
if [ "$legacy_ledger" -eq 1 ]; then
  echo "RECUPERAÇÃO LEGADA: validando grants existentes sem remover privilégios."
  if ! run_migrator_file "$grant_sql" "$grant_log"; then
    echo "Falha nos GRANTs conhecidos; checksums não foram adotados e migrations não foram executadas." >&2
    exit 1
  fi
  if ! run_migrate --adopt-legacy-ledger; then
    echo "Adoção cancelada/falhou. O ledger legado não foi reexecutado; consulte o runbook." >&2
    exit 1
  fi
fi

# =============================================================================
echo
echo "=================================================================="
echo "FASE 2 — migrations como nexus_migrator"
echo "=================================================================="
if ! run_migrate ""; then
  echo >&2
  echo "FASE 2 FALHOU. A migration com falha e sua linha do ledger foram revertidas juntas." >&2
  echo "Nenhuma migration posterior foi iniciada. Leia o ledger e o runbook antes de repetir." >&2
  exit 1
fi

# =============================================================================
echo
echo "=================================================================="
echo "FASE 3 — privilégios runtime (nexus_app)"
echo "=================================================================="
if ! run_migrator_file "$grant_sql" "$grant_log"; then
  echo >&2
  echo "FASE 3 FALHOU. Migrations e ledger permanecem aplicados; execute somente os GRANTs conhecidos após corrigir a causa." >&2
  exit 1
fi

echo
echo "=================================================================="
echo "VERIFICAÇÃO FINAL"
echo "=================================================================="
if ! run_migrator_file "$verify_sql" "$verify_log"; then
  echo >&2
  echo "VERIFICAÇÃO FALHOU. Não conecte a aplicação a este banco até resolver todos os invariantes." >&2
  echo "Não há REVOKE/ownership repair automático; consulte a seção de recuperação do runbook." >&2
  exit 1
fi

rm -f "$migrator_passfile"
echo
echo "CONCLUÍDO — ledger e checksums 1..8 conferidos; allowlist de privilégios validada."
echo "Nenhuma variável do Vercel foi alterada e nenhum deploy foi executado."

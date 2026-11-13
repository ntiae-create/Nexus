-- =============================================================================
-- NEXUS — FASE 1 de 3: preparacao administrativa
-- =============================================================================
-- Executar como ADMINISTRADOR do PostgreSQL (no Railway: o papel `postgres`).
-- SOMENTE nesta fase o superusuario e necessario.
--
-- Este arquivo NAO usa `bootstrap.sql`: aquele script e FIXTURE DE TESTE e falha
-- de proposito fora dele. Medido:
--   * `IF current_database() <> 'nexus_test' THEN RAISE EXCEPTION`   (linha 14)
--   * `GRANT CONNECT ON DATABASE nexus_test`                          (linha 72)
--   * exige PostgreSQL 17 e contagens exatas de teste                  (linha 17)
--   * `RAISE EXCEPTION 'nexus_app unexpectedly exists'`                (linha 61)
--   * INSERE providers de teste `test-free`/`test-paid` e 4 modelos    (linhas 100-109)
--
-- As concessoes de runtime ficam em 20_grant_runtime.sql, rodadas por
-- `nexus_migrator` DEPOIS das migrations (as tabelas ainda nao existem aqui).
--
-- Idempotente: pode ser executado quantas vezes for preciso. Nenhum DROP,
-- nenhum DELETE, nenhuma alteracao de dado.
-- =============================================================================

\set ON_ERROR_STOP on
\echo '== Fase 1: papeis =='

-- -----------------------------------------------------------------------------
-- nexus_migrator — aplica as migrations. NAO tem SUPERUSER nem BYPASSRLS.
--
-- NOCREATEROLE e proposital: `nexus_audit_writer` e criado AQUI, na fase
-- administrativa, e o bloco `DO` da 00007 so cria se ainda nao existir. Assim o
-- migrator nunca precisa de CREATEROLE — menos privilegio, mesmo resultado.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_migrator') THEN
    CREATE ROLE nexus_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'nexus_migrator: criado';
  ELSE
    RAISE NOTICE 'nexus_migrator: ja existe (nada a fazer)';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- nexus_audit_writer — escritor da trilha de auditoria (00007).
-- NOLOGIN + NOINHERIT: nao e credencial de login nem pode herdar privilegios
-- de memberships futuras. Os atributos sao exatamente os que o verificador
-- final exige; os demais tambem sao verificados pela 00007 (bloco em
-- 00007_tool_grants_and_preferences.sql:345-356).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_audit_writer') THEN
    CREATE ROLE nexus_audit_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'nexus_audit_writer: criado';
  ELSE
    RAISE NOTICE 'nexus_audit_writer: ja existe (atributos preservados; 30_verify.sql exige NOINHERIT)';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- nexus_app — papel de runtime da API. E o papel que o Vercel usa.
-- NOINHERIT + NOSUPERUSER + NOBYPASSRLS: as policies de RLS sao avaliadas
-- contra este papel, sem escapatória.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    CREATE ROLE nexus_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'nexus_app: criado';
  ELSE
    RAISE NOTICE 'nexus_app: ja existe (nada a fazer)';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- nexus_anonymous — NOLOGIN, existe por fidelidade ao modelo de papeis do
-- projeto, mas NAO e referenciado por nenhuma migration nem pelo runtime.
-- Medido: `grep -rn nexus_anonymous packages/database/migrations/` nao retorna
-- nada, e o app nao o usa. Mantido porque o contrato de instalacao o preve.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_anonymous') THEN
    CREATE ROLE nexus_anonymous NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'nexus_anonymous: criado';
  ELSE
    RAISE NOTICE 'nexus_anonymous: ja existe (nada a fazer)';
  END IF;
END
$$;

\echo '== Fase 1: permissoes administrativas =='

-- -----------------------------------------------------------------------------
-- O migrator precisa poder criar o schema `nexus` (00001 abre com
-- `CREATE SCHEMA nexus;`), que exige CREATE no BANCO.
-- Usa current_database(): no Railway o banco NAO se chama `nexus_test`.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format('GRANT CREATE, CONNECT ON DATABASE %I TO nexus_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nexus_app', current_database());
  RAISE NOTICE 'GRANT CREATE/CONNECT em % para nexus_migrator; CONNECT para nexus_app', current_database();
END
$$;

-- -----------------------------------------------------------------------------
-- O migrator precisa poder ASSUMIR `nexus_audit_writer` para executar
-- `ALTER FUNCTION ... OWNER TO nexus_audit_writer` (00007).
--
-- Sem isto a 00007 falha com:
--     ERROR: must be able to SET ROLE "nexus_audit_writer"
--
-- INHERIT FALSE e essencial: sem ele o migrator HERDA os privilegios do
-- escritor, o que e privilegio a mais. SET TRUE e o unico poder necessario.
-- -----------------------------------------------------------------------------
GRANT nexus_audit_writer TO nexus_migrator WITH SET TRUE, INHERIT FALSE;

-- -----------------------------------------------------------------------------
-- Relatorio de atributos. Nada e alterado: `ALTER ROLE ... NOSUPERUSER` exige
-- SUPERUSER e quebraria a idempotencia. Somente leitura para conferencia.
-- -----------------------------------------------------------------------------
\echo ''
\echo '== Atributos dos papeis (esperado: todos f/t) =='
SELECT rolname,
       rolsuper     AS superuser,
       rolbypassrls AS bypassrls,
       rolcanlogin  AS login,
       rolcreatedb  AS createdb,
       rolcreaterole AS createrole,
       rolinherit AS inherit
  FROM pg_roles
 WHERE rolname IN ('nexus_migrator','nexus_app','nexus_anonymous','nexus_audit_writer')
 ORDER BY rolname;

\echo ''
\echo '== Fase 1 concluida. Proximo passo: definir as senhas (abaixo) e rodar as migrations. =='
\echo ''
\echo 'SENHAS — use o meta-comando de senha do psql (barra + password). Ele pede a senha sem eco,'
\echo 'nao mostra o valor e nao deixa rastro no historico do shell:'
\echo ''
\echo '    \password nexus_migrator     (digite exatamente assim, com a barra)'
\echo '    \password nexus_app'
\echo ''
\echo 'ANOTAR APENAS EM GERENCIADOR DE SEGREDOS. Nao colar no chat, no Git nem no shell.'

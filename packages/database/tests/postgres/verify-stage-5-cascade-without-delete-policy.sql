\set ON_ERROR_STOP on
-- Fase 5 (G13): prova de que a cascata `ON DELETE CASCADE` de `owner_identity` NAO depende da
-- policy de DELETE de `tool_grants`.
--
-- =============================================================================================
-- O QUE ESTE ARQUIVO PROVA
-- =============================================================================================
-- O comentario de `00007_tool_grants_and_preferences.sql` (secao 4) afirma:
--
--     "a policy de DELETE NAO e o que permite o `ON DELETE CASCADE` de `owner_identity`
--      funcionar. Acoes de integridade referencial sao executadas como o dono da constraint e
--      NAO passam pelo RLS como um DELETE da aplicacao."
--
-- Aqui a policy e removida de verdade, a exclusao do owner e executada, e a cascata e observada.
-- A remocao acontece DENTRO de uma transacao que termina em ROLLBACK: a policy de producao nunca
-- fica ausente. Nada de `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, nada de privilégio extra,
-- nada de alteracao permanente.
--
-- Nao confundir os dois efeitos:
--   * SEGURANCA: sem a policy, o DELETE da APLICACAO (`nexus_app`) afeta 0 linhas em silencio;
--   * INTEGRIDADE: sem a policy, a cascata por integridade referencial continua funcionando.
-- Este arquivo prova o segundo e comprova o primeiro na mesma transacao.
--
-- =============================================================================================
-- PRE-CONDICAO: banco recem-criado
-- =============================================================================================
-- Contexto de owner/ator na SESSAO: sob FORCE RLS um runner NAO-superuser so enxerga as linhas
-- pessoais com o contexto definido. Sem isso, as pre-condicoes de "tabela vazia" e a checagem
-- pos-ROLLBACK do bloco §4 enxergam 0 linhas sempre — e a de §4 passaria/acusaria por engano.
-- (Um runner SUPERUSER ve tudo de qualquer forma; definir o contexto nao atrapalha.)
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', false);
SELECT set_config('nexus.actor_type', 'owner', false);

DO $$
BEGIN
  IF current_database() <> 'nexus_test' THEN
    RAISE EXCEPTION 'Expected isolated nexus_test database, got %', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM nexus.tool_grants) OR EXISTS (SELECT 1 FROM nexus.tool_grant_audit) THEN
    RAISE EXCEPTION
      'Cascade-without-policy verification requires a fresh database: Phase 5 tables are not empty.'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'nexus' AND tablename = 'tool_grants'
                   AND policyname = 'tool_grants_owner_delete') THEN
    RAISE EXCEPTION 'Precondition failed: tool_grants_owner_delete is missing before the experiment';
  END IF;
END
$$;

BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

-- ---------------------------------------------------------------------------------------------
-- 1. Prepara um owner e seus registros relacionados (grants, auditoria, preferencias).
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES
    ('d0000000-0000-4000-8000-000000000001', nexus.current_owner_id(),
     '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
     nexus.current_owner_id(), now()),
    ('d0000000-0000-4000-8000-000000000002', nexus.current_owner_id(),
     '00000000-0000-4000-8000-000000000003', 'technical.code_analysis', 'granted',
     nexus.current_owner_id(), now());

  UPDATE nexus.tool_grants
  SET status = 'revoked', revoked_by_owner_id = nexus.current_owner_id(), revoked_at = now()
  WHERE id = 'd0000000-0000-4000-8000-000000000002';

  INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, is_default)
  VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000001', true);
END
$$;

DO $$
DECLARE
  grants integer;
  audit integer;
  prefs integer;
BEGIN
  SELECT count(*) INTO grants FROM nexus.tool_grants;
  SELECT count(*) INTO audit FROM nexus.tool_grant_audit;
  SELECT count(*) INTO prefs FROM nexus.user_assistant_preferences;
  IF grants <> 2 OR audit <> 3 OR prefs <> 1 THEN
    RAISE EXCEPTION 'Seed failed: grants=% audit=% prefs=% (expected 2/3/1)', grants, audit, prefs;
  END IF;
END
$$;

-- As tres tabelas com trigger de tombstone sao esvaziadas pelo mesmo motivo do verificador de
-- exclusao do owner: `tombstones_owner_id_fkey` impede a exclusao com dados presentes (defeito
-- pre-existente de 00001, alheio a esta fase). A cascata das tabelas da Fase 5 e o objeto aqui.
DELETE FROM nexus.messages;
DELETE FROM nexus.conversations;
DELETE FROM nexus.assistant_memories;

-- ---------------------------------------------------------------------------------------------
-- 2. Remove TEMPORARIAMENTE a policy de DELETE de `tool_grants` (dentro da transacao).
-- ---------------------------------------------------------------------------------------------
DROP POLICY tool_grants_owner_delete ON nexus.tool_grants;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'nexus' AND tablename = 'tool_grants'
               AND policyname = 'tool_grants_owner_delete') THEN
    RAISE EXCEPTION 'Experiment setup failed: policy still present after DROP';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'nexus' AND c.relname = 'tool_grants'
                   AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION 'Experiment setup failed: RLS must remain ENABLED and FORCED';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. A exclusao do owner sob o contexto de teste apropriado.
--    Roda como o dono do banco (quem executaria uma remocao definitiva), exatamente como o
--    verificador de exclusao. O ponto NAO e o privilegio do invocador: e que a cascata nao
--    consulta policies.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  grants integer;
  audit integer;
  prefs integer;
  owners integer;
BEGIN
  DELETE FROM nexus.owner_identity WHERE id = '00000000-0000-4000-8000-000000000004';

  SELECT count(*) INTO owners FROM nexus.owner_identity;
  SELECT count(*) INTO grants FROM nexus.tool_grants;
  SELECT count(*) INTO audit FROM nexus.tool_grant_audit;
  SELECT count(*) INTO prefs FROM nexus.user_assistant_preferences;

  IF owners <> 0 THEN
    RAISE EXCEPTION 'Owner row was not removed (found %)', owners;
  END IF;
  -- A cascata referencial tem de ter funcionado SEM a policy de DELETE.
  IF grants <> 0 THEN
    RAISE EXCEPTION 'Cascade depended on the DELETE policy: % tool grant(s) survived', grants;
  END IF;
  IF audit <> 0 THEN
    RAISE EXCEPTION 'Cascade depended on the DELETE policy: % audit row(s) survived', audit;
  END IF;
  IF prefs <> 0 THEN
    RAISE EXCEPTION 'Cascade depended on the DELETE policy: % preference(s) survived', prefs;
  END IF;

  RAISE NOTICE 'Cascade works with the DELETE policy removed: grants/audit/prefs all 0';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. E o efeito de SEGURANCA da policy ausente: a aplicacao apaga 0 linhas em silencio.
--    Precisa de outra transacao porque a anterior ja removeu o owner. Aqui so se verifica o
--    comportamento do DELETE da aplicacao, sem owner para cascatear.
-- ---------------------------------------------------------------------------------------------
ROLLBACK;

-- O ROLLBACK tem de ter devolvido owner, policy e dados.
DO $$
BEGIN
  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK failed: owner row was not restored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'nexus' AND tablename = 'tool_grants'
                   AND policyname = 'tool_grants_owner_delete') THEN
    RAISE EXCEPTION 'ROLLBACK failed: the DELETE policy was NOT restored';
  END IF;
  IF EXISTS (SELECT 1 FROM nexus.tool_grants)
     OR EXISTS (SELECT 1 FROM nexus.tool_grant_audit)
     OR EXISTS (SELECT 1 FROM nexus.user_assistant_preferences) THEN
    RAISE EXCEPTION 'ROLLBACK failed: Phase 5 rows survived the rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM nexus.messages)
     OR NOT EXISTS (SELECT 1 FROM nexus.conversations)
     OR NOT EXISTS (SELECT 1 FROM nexus.assistant_memories) THEN
    RAISE EXCEPTION 'ROLLBACK failed: the tombstone-triggered tables were not restored';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Seguranca: sem a policy, o DELETE de `nexus_app` afeta 0 linhas e NAO levanta erro.
--    Recriamos a linha como `postgres`, removemos a policy de novo (na transacao), e apagamos
--    como `nexus_app`. Espera-se `DELETE 0`.
-- ---------------------------------------------------------------------------------------------
BEGIN;

-- Contexto de owner: o trigger de auditoria le `nexus.current_owner_id()` e a policy de INSERT
-- da trilha (nova) exige que owner/actor coincidam com esse contexto. Sem os GUCs o INSERT nao
-- grava auditoria e falha em `new row violates row-level security policy`.
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
VALUES ('d0000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
        '00000000-0000-4000-8000-000000000004', now());

DROP POLICY tool_grants_owner_delete ON nexus.tool_grants;

-- A premissa correta NAO e "ser o superusuario postgres" — e "ser DONO da tabela", que e quem
-- pode `DROP POLICY` e cuja escrita nao e barrada pela policy de INSERT. Exigir `postgres` por
-- nome obrigava a um provisionamento com superusuario, que e exatamente o que o R36 elimina.
DO $$
DECLARE
  tbl_owner text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO tbl_owner
  FROM pg_class WHERE oid = 'nexus.tool_grants'::regclass;
  IF tbl_owner <> current_user THEN
    RAISE EXCEPTION 'This block must run as the owner of nexus.tool_grants (%), got %',
      tbl_owner, current_user;
  END IF;
END
$$;

-- Muda para `nexus_app` e tenta apagar. Quem executa este arquivo precisa poder SET ROLE em
-- `nexus_app`. O provisionador normalmente e o CRIADOR de `nexus_app` e, no PG 16+, o criador
-- recebe membership automatica com `admin_option` mas `set_option = false` (config
-- `createrole_self_grant` vazia). `admin_option` sozinho NAO permite `SET ROLE`; e preciso
-- conceder SET explicitamente (`GRANT nexus_app TO <provisioner> WITH SET TRUE`).
-- Ver `docs/` do R38 e o script de provisionamento.
SET LOCAL ROLE nexus_app;
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);
DO $$
DECLARE
  affected integer;
BEGIN
  DELETE FROM nexus.tool_grants WHERE id = 'd0000000-0000-4000-8000-0000000000ff';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'Without the DELETE policy the application deleted % row(s); expected 0', affected;
  END IF;
  -- O esperado: sem policy de DELETE, o comando nao encontra linha alguma. ROW_COUNT = 0 E a
  -- linha continua la. Se ela tivesse sumido, seria um DELETE que ignorou a policy.
  IF NOT EXISTS (SELECT 1 FROM nexus.tool_grants WHERE id = 'd0000000-0000-4000-8000-0000000000ff') THEN
    RAISE EXCEPTION 'Row disappeared even though ROW_COUNT was 0';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;

DO $$
BEGIN
  RAISE NOTICE 'Phase 5 (G13) cascade-without-DELETE-policy verification passed';
END
$$;

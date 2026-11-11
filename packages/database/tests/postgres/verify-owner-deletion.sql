\set ON_ERROR_STOP on
-- Fase 5 (G13) / correcao do DEFEITO DO OWNER: exclusao definitiva da instalacao.
--
-- =============================================================================================
-- O QUE ESTE ARQUIVO PROVA
-- =============================================================================================
-- Que `DELETE FROM nexus.owner_identity` FUNCIONA, e que o estado final do banco corresponde a
-- uma politica de exclusao explicitamente definida — nao apenas que o comando retornou sucesso.
--
-- Roda como `nexus_migrator`: o DONO do schema, com `rolsuper = f` e `rolbypassrls = f`. E o
-- papel que a instalacao real usa para DDL e para operacoes administrativas. Nenhum superusuario.
--
-- Seccoes:
--   §1  PRE-CONDICOES do ambiente (banco isolado, papeis sem privilegios amplos, dados presentes)
--   §2  Contexto INVALIDO nao exclui nada            (bloqueio por contexto)
--   §3  `nexus_app` nao consegue excluir o owner     (bloqueio por privilegio)
--   §4  Exclusao SEM dados associados                (caminho vazio)
--   §5  Exclusao COM todas as entidades populadas    (caminho real)
--   §6  Atomicidade: falha intermediaria nao deixa estado parcial
--   §7  Retencao: catalogo global sobrevive, dados pessoais nao
--   §8  Nenhum papel recebeu SUPERUSER ou BYPASSRLS
--
-- Cada secao que altera dados roda dentro de uma transacao revertida com ROLLBACK, exceto §5,
-- que precisa COMMITAR para que o estado pos-exclusao possa ser verificado fora da transacao —
-- e cujo banco e descartavel por construcao (o runner recria `nexus_test` a cada execucao).
--
-- =============================================================================================
-- A POLITICA DE EXCLUSAO (definida aqui, nao inferida do codigo)
-- =============================================================================================
-- EXCLUIR (dados pessoais do owner — nada disso sobrevive):
--   conversations, conversation_assistants, messages, core_runs, run_steps, run_results,
--   tool_events, assistant_memories, memory_permissions, memory_permission_audit,
--   conversation_provider_preferences, assistant_provider_preferences,
--   global_provider_preferences, provider_authorizations, sync_cursors, tombstones,
--   tool_grants, tool_grant_audit, user_assistant_preferences
--
-- PRESERVAR (catalogo GLOBAL — nao pertence a nenhum owner):
--   assistants, assistant_config_versions, providers, models
--
-- RETENCAO PENDENTE DE DECISAO DE PRODUTO:
--   `tool_grant_audit` e uma trilha append-only. Hoje ela e apagada junto com o owner, porque a
--   FK e `ON DELETE CASCADE`. Manter a trilha exigiria definir por quanto tempo e para quem ela
--   sobrevive a destruicao da instalacao — decisao que esta fase NAO toma. Este verificador
--   asserta o comportamento ATUAL (apagada) e falha se ele mudar sem que este arquivo mude:
--   a mudanca precisa ser deliberada, nunca acidental.
--
-- =============================================================================================
-- PRE-CONDICAO: banco recem-criado com as seeds de 00001-00007
-- =============================================================================================

DO $$
DECLARE
  funcao_src text;
BEGIN
  IF current_database() <> 'nexus_test' THEN
    RAISE EXCEPTION 'Expected isolated nexus_test database, got %', current_database();
  END IF;
  -- A prova so tem valor se o runner NAO tiver privilegio amplo. Um superusuario contorna RLS
  -- e o teste passaria por um motivo que nao existe em producao.
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'This file must run as a non-superuser role; % is SUPERUSER', current_user;
  END IF;
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'This file must run as a role WITHOUT BYPASSRLS; % has it', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
    RAISE EXCEPTION 'nexus_app role is missing; run bootstrap.sql first';
  END IF;
  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one seeded owner; found %', (SELECT count(*) FROM nexus.owner_identity);
  END IF;
  -- A funcao corrigida tem de estar instalada. Sem esta checagem o arquivo passaria a testar a
  -- versao anterior, e o defeito voltaria sem que o teste percebesse.
  SELECT prosrc INTO funcao_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'nexus' AND p.proname = 'record_deleted_entity';
  IF strpos(funcao_src, 'owner_identity WHERE id = OLD.owner_id') = 0 THEN
    RAISE EXCEPTION 'nexus.record_deleted_entity() does not carry the owner-existence guard; is 00008 applied?';
  END IF;
END
$$;

-- Contexto de owner/actor na SESSAO: sob FORCE RLS um runner nao-superuser so enxerga as linhas
-- pessoais com o contexto definido. Sem isso, "tabela vazia" seria verdade por invisibilidade.
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', false);
SELECT set_config('nexus.actor_type', 'owner', false);

DROP TABLE IF EXISTS pg_temp.verify_baseline;
CREATE TEMP TABLE verify_baseline AS
SELECT
  (SELECT count(*) FROM nexus.owner_identity) AS owners_count,
  (SELECT count(*) FROM nexus.assistants) AS assistants_count,
  (SELECT count(*) FROM nexus.assistant_config_versions) AS config_versions_count,
  -- O provider/model de prova e criado pelo proprio seed deste arquivo; o baseline do catalogo
  -- GLOBAL e medido ANTES do seed, por isso nao entra na conta.
  (SELECT count(*) FROM nexus.providers) AS providers_count,
  (SELECT count(*) FROM nexus.models) AS models_count;

CREATE TEMP TABLE verify_owner_tables (tabela text PRIMARY KEY);
INSERT INTO verify_owner_tables (tabela) VALUES
  ('conversations'), ('conversation_assistants'), ('messages'), ('core_runs'), ('run_steps'),
  ('run_results'), ('tool_events'), ('assistant_memories'), ('memory_permissions'),
  ('memory_permission_audit'), ('conversation_provider_preferences'),
  ('assistant_provider_preferences'), ('global_provider_preferences'),
  ('provider_authorizations'), ('sync_cursors'), ('tombstones'), ('tool_grants'),
  ('tool_grant_audit'), ('user_assistant_preferences');

-- =============================================================================================
-- POPULACAO: uma linha em CADA tabela que possui `owner_id`
-- =============================================================================================
-- Semear tudo e o que torna a prova significativa. Uma exclusao que funciona com o banco vazio
-- nao demonstra nada — era exatamente o contorno que o verificador anterior precisava fazer.
--
-- As linhas sao criadas com o contexto de owner ativo (as policies exigem isso) e cada bloco
-- confirma a contagem DEPOIS do INSERT, para que uma tabela nao populada por engano nao passe
-- silenciosamente como "excluida com sucesso".
DO $$
DECLARE
  o uuid := nexus.current_owner_id();
  a uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  -- --- catalogo global: provider/model (necessarios para as FKs RESTRICT) --------------------
  INSERT INTO nexus.providers (id, provider_key, display_name, availability, cost_status)
  VALUES ('d0000000-0000-4000-8000-000000000001', 'probe-provider', 'Probe Provider', 'available', 'free_confirmed');
  INSERT INTO nexus.models (id, provider_id, model_key, display_name, availability)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
          'probe-model', 'Probe Model', 'available');

  -- --- conversa e mensagem ------------------------------------------------------------------
  INSERT INTO nexus.conversations (id, owner_id, title)
  VALUES ('e0000000-0000-4000-8000-000000000001', o, 'conversa de prova');
  INSERT INTO nexus.conversation_assistants (owner_id, conversation_id, assistant_id)
  VALUES (o, 'e0000000-0000-4000-8000-000000000001', a);

  INSERT INTO nexus.messages (id, owner_id, conversation_id, sequence, role, status, content,
                              format_version, request_id, idempotency_key)
  VALUES ('e0000000-0000-4000-8000-000000000002', o, 'e0000000-0000-4000-8000-000000000001',
          1, 'user', 'complete', '[{"type":"text","text":"prova"}]'::jsonb, 1,
          'e0000000-0000-4000-8000-0000000000a2', 'prova-k1');

  -- --- execucao: run, step, tool_event, result ----------------------------------------------
  INSERT INTO nexus.core_runs (id, owner_id, conversation_id, request_id, idempotency_key,
                               status, input_message_id, format_version)
  VALUES ('e0000000-0000-4000-8000-000000000003', o, 'e0000000-0000-4000-8000-000000000001',
          'e0000000-0000-4000-8000-0000000000a3', 'prova-run',
          'queued', 'e0000000-0000-4000-8000-000000000002', 1);

  INSERT INTO nexus.run_steps (id, owner_id, run_id, step_order, assistant_id,
                               assistant_config_version, status, objective)
  VALUES ('e0000000-0000-4000-8000-000000000004', o, 'e0000000-0000-4000-8000-000000000003',
          0, a, (SELECT config_version FROM nexus.assistant_config_versions WHERE assistant_id = a
                 ORDER BY config_version LIMIT 1), 'pending', 'objetivo');

  INSERT INTO nexus.tool_events (id, owner_id, run_id, step_id, tool_id, tool_version,
                                 event_type, status, origin, format_version)
  VALUES ('e0000000-0000-4000-8000-000000000005', o, 'e0000000-0000-4000-8000-000000000003',
          'e0000000-0000-4000-8000-000000000004', 'personal.tasks', '1', 'invoked', 'succeeded',
          'assistant', 1);

  INSERT INTO nexus.run_results (id, owner_id, run_id, step_id, status, content, format_version)
  VALUES ('e0000000-0000-4000-8000-000000000006', o, 'e0000000-0000-4000-8000-000000000003',
          'e0000000-0000-4000-8000-000000000004', 'succeeded',
          '[{"type":"text","text":"resultado"}]'::jsonb, 1);

  -- --- memoria, permissao e trilha de permissao ---------------------------------------------
  INSERT INTO nexus.assistant_memories (id, owner_id, visibility, origin, source_message_id,
                                        origin_assistant_id, content, format_version)
  VALUES ('e0000000-0000-4000-8000-000000000007', o, 'shared', 'conversation',
          'e0000000-0000-4000-8000-000000000002', a, 'memoria de prova', 1);

  INSERT INTO nexus.memory_permissions (id, owner_id, memory_id, assistant_id, status,
                                        granted_by_owner_id, granted_at)
  VALUES ('e0000000-0000-4000-8000-000000000008', o,
          'e0000000-0000-4000-8000-000000000007',
          '00000000-0000-4000-8000-000000000002', 'granted', o, now());

  -- A trilha `memory_permission_audit` NAO aceita INSERT direto: a policy de INSERT e escopada ao
  -- papel dono do trigger SECURITY DEFINER (mesmo desenho da `tool_grant_audit`). O evento nasce
  -- do INSERT acima, que ja disparou o trigger. Asserir que ele foi criado e o que importa.
  IF NOT EXISTS (SELECT 1 FROM nexus.memory_permission_audit
                  WHERE permission_id = 'e0000000-0000-4000-8000-000000000008') THEN
    RAISE EXCEPTION 'The memory-permission audit trigger did not record the grant';
  END IF;

  -- --- autorizacao do provider ANTES das preferencias ---------------------------------------
  -- `enforce_provider_preference_authorization()` recusa preferencia `manual` sem autorizacao
  -- explicita e disponibilidade confirmada (SQLSTATE 42501). A ordem aqui nao e arbitraria.
  INSERT INTO nexus.provider_authorizations
    (owner_id, provider_id, authorized, paid_use_authorized, authorized_at)
  VALUES (o, 'd0000000-0000-4000-8000-000000000001', true, false, now());

  -- 00003 ja semeia uma linha (`automatic`) para o owner; aqui ela e promovida para `manual`.
  UPDATE nexus.global_provider_preferences
     SET selection_mode = 'manual',
         provider_id = 'd0000000-0000-4000-8000-000000000001',
         model_id = 'd0000000-0000-4000-8000-000000000002'
   WHERE owner_id = o;

  INSERT INTO nexus.assistant_provider_preferences
    (owner_id, assistant_id, provider_id, model_id, selection_mode)
  VALUES (o, a, 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'manual');

  INSERT INTO nexus.conversation_provider_preferences
    (owner_id, conversation_id, provider_id, model_id, selection_mode)
  VALUES (o, 'e0000000-0000-4000-8000-000000000001',
          'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'manual');

  INSERT INTO nexus.sync_cursors (owner_id, device_id, cursor)
  VALUES (o, 'e0000000-0000-4000-8000-0000000000d1', 'cursor-1');

  -- --- tombstone: prova de que o guard NAO impede tombstones legitimos ----------------------
  INSERT INTO nexus.conversations (id, owner_id, title)
  VALUES ('e0000000-0000-4000-8000-000000000009', o, 'conversa que sera apagada');
  DELETE FROM nexus.conversations WHERE id = 'e0000000-0000-4000-8000-000000000009';

  -- --- Fase 5: grants, auditoria e preferencias ---------------------------------------------
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status,
                                 granted_by_owner_id, granted_at)
  VALUES ('e0000000-0000-4000-8000-00000000000a', o, a, 'personal.tasks', 'granted', o, now());
  -- A trilha e escrita pela funcao SECURITY DEFINER; inserir direto exigiria `nexus_audit_writer`.
  -- Aplicar um UPDATE no grant dispara o trigger de auditoria e produz evento real.
  UPDATE nexus.tool_grants SET status = 'revoked', revoked_by_owner_id = o, revoked_at = now()
  WHERE id = 'e0000000-0000-4000-8000-00000000000a';

  -- Ja existe preferencia para outra assistente, com `is_default = true` (o indice unico
  -- `user_assistant_preferences_single_default_idx` permite UM default por owner). Inserir outro
  -- default violaria o indice; a linha de prova e entao NAO-default. O objetivo aqui e ter uma
  -- linha em `user_assistant_preferences` que a cascata precise apagar, nao exercitar o indice.
  INSERT INTO nexus.user_assistant_preferences
    (owner_id, assistant_id, is_default, sort_order, response_verbosity)
  VALUES (o, a, false, 1, 'detailed');
END
$$;

-- =============================================================================================
-- §1. TODAS as 19 tabelas de owner (fora owner_identity) tem linha — ou o teste nao vale
-- =============================================================================================
DO $$
DECLARE
  r record;
  n bigint;
  faltando text := '';
BEGIN
  FOR r IN SELECT tabela FROM verify_owner_tables ORDER BY tabela LOOP
    EXECUTE format('SELECT count(*) FROM nexus.%I', r.tabela) INTO n;
    IF n = 0 THEN faltando := faltando || ' ' || r.tabela; END IF;
  END LOOP;
  IF faltando <> '' THEN
    RAISE EXCEPTION 'Owner tables were not populated (the deletion proof would be vacuous):%', faltando;
  END IF;

  IF (SELECT count(*) FROM nexus.tombstones) < 1 THEN
    RAISE EXCEPTION 'Expected at least one tombstone from the legitimate conversation deletion';
  END IF;
  RAISE NOTICE '§1 OK: all owner tables populated and tombstones present';
END
$$;


-- =============================================================================================
-- §2. CONTEXTO INVALIDO NAO EXCLUI NADA
-- =============================================================================================
-- Duas formas de contexto invalido, e as duas precisam ser RECUSADAS:
--   (a) sem `nexus.owner_id` definido;
--   (b) `nexus.owner_id` de um owner DIFERENTE do configurado.
--
-- O que se prova aqui NAO e que "o DELETE falha": e que ele afeta ZERO linhas. A tabela
-- `owner_identity` nao tem RLS (o singleton precisa ser legivel de dentro das policies), entao
-- quem tem o privilegio de DELETE consegue emitir o comando. O contexto invalido nao pode
-- transformar esse comando em destruicao de dados.
BEGIN;
  DO $sec2$
  DECLARE
    afetadas bigint;
  BEGIN
    -- (a) contexto ausente
    PERFORM set_config('nexus.owner_id', '', true);
    BEGIN
      DELETE FROM nexus.conversations;
      GET DIAGNOSTICS afetadas = ROW_COUNT;
      IF afetadas <> 0 THEN
        RAISE EXCEPTION 'DELETE with EMPTY owner context removed % conversation(s)', afetadas;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL; -- recusa por RLS tambem prova o ponto: nada foi apagado
    END;

    -- (b) contexto de outro owner
    PERFORM set_config('nexus.owner_id', '99999999-9999-4999-8999-999999999999', true);
    BEGIN
      DELETE FROM nexus.conversations;
      GET DIAGNOSTICS afetadas = ROW_COUNT;
      IF afetadas <> 0 THEN
        RAISE EXCEPTION 'DELETE with FOREIGN owner context removed % conversation(s)', afetadas;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;

    -- Restaurar o contexto ANTES de contar. Sem isto, o proprio `count(*)` ficaria sujeito ao
    -- FORCE RLS e enxergaria zero linhas por INVISIBILIDADE, nao por exclusao — o teste acusaria
    -- perda de dados que nunca houve. (Que o contexto errado torne as linhas invisiveis e,
    -- aliás, a demonstracao de que o isolamento por owner funciona.)
    PERFORM set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
    PERFORM set_config('nexus.actor_type', 'owner', true);

    -- O mais importante: a linha do owner continua la, e os dados tambem.
    IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
      RAISE EXCEPTION 'Owner row disappeared during invalid-context attempts';
    END IF;
    IF (SELECT count(*) FROM nexus.conversations) < 1 THEN
      RAISE EXCEPTION 'Conversations were removed during invalid-context attempts';
    END IF;
  END
  $sec2$;
ROLLBACK;

DO $sec2ok$ BEGIN
  RAISE NOTICE '§2 OK: invalid context removes nothing and preserves the owner';
END $sec2ok$;

-- =============================================================================================
-- §3. `nexus_app` NAO CONSEGUE EXCLUIR O OWNER
-- =============================================================================================
-- A credencial da aplicacao recebe apenas SELECT em `owner_identity` (bootstrap.sql). A prova
-- exige SQLSTATE 42501 (insufficient_privilege) — nao um erro generico — e a sobrevivencia da
-- linha. Roda em transacao revertida.
BEGIN;
  DO $sec3$
  DECLARE
    estado text;
    mensagem text;
    sobrou bigint;
  BEGIN
    SET LOCAL ROLE nexus_app;
    BEGIN
      DELETE FROM nexus.owner_identity;
      RAISE EXCEPTION 'nexus_app was able to issue DELETE on owner_identity';
    EXCEPTION
      WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS estado = RETURNED_SQLSTATE, mensagem = MESSAGE_TEXT;
        IF estado <> '42501' THEN
          RAISE EXCEPTION 'nexus_app deletion failed with % instead of 42501', estado;
        END IF;
    END;
    RESET ROLE;
    SELECT count(*) INTO sobrou FROM nexus.owner_identity;
    IF sobrou <> 1 THEN
      RAISE EXCEPTION 'Owner row is not present after nexus_app attempt (found %)', sobrou;
    END IF;
    RAISE NOTICE '§3 OK: nexus_app denied with SQLSTATE 42501 (%), owner survives', mensagem;
  END
  $sec3$;
ROLLBACK;

-- =============================================================================================
-- §4. EXCLUSAO SEM DADOS ASSOCIADOS
-- =============================================================================================
-- Caminho vazio: nenhuma linha em nenhuma tabela de owner. Precisa remover a linha e nada mais.
-- Roda em transacao revertida: o §5 usa o banco populado.
BEGIN;
  DO $sec4$
  DECLARE
    r record;
    n bigint;
  BEGIN
    FOR r IN SELECT tabela FROM verify_owner_tables ORDER BY tabela LOOP
      EXECUTE format('DELETE FROM nexus.%I', r.tabela);
    END LOOP;
    IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
      RAISE EXCEPTION 'Precondition failed: owner must still exist before §4';
    END IF;

    DELETE FROM nexus.owner_identity;

    IF (SELECT count(*) FROM nexus.owner_identity) <> 0 THEN
      RAISE EXCEPTION 'Empty-owner deletion left the owner row behind';
    END IF;
    FOR r IN SELECT tabela FROM verify_owner_tables ORDER BY tabela LOOP
      EXECUTE format('SELECT count(*) FROM nexus.%I', r.tabela) INTO n;
      IF n <> 0 THEN
        RAISE EXCEPTION 'Empty-owner deletion left % row(s) in %', n, r.tabela;
      END IF;
    END LOOP;
    RAISE NOTICE '§4 OK: owner without data deleted cleanly';
  END
  $sec4$;
ROLLBACK;

-- =============================================================================================
-- §5 / §7. EXCLUSAO COM TODAS AS ENTIDADES POPULADAS — o caminho real
-- =============================================================================================
-- ESTA SECAO COMITA, e §7 verifica o estado resultante FORA da transacao. Um ROLLBACK esconderia
-- justamente o que se quer medir. O banco e descartavel: o runner recria `nexus_test` a cada
-- execucao, e §1 ja confirmou que o ambiente e o esperado.
DROP TABLE IF EXISTS pg_temp.pre_delete_snapshot;
CREATE TEMP TABLE pre_delete_snapshot AS
SELECT
  (SELECT count(*) FROM nexus.conversations) AS conversations,
  (SELECT count(*) FROM nexus.conversation_assistants) AS conversation_assistants,
  (SELECT count(*) FROM nexus.messages) AS messages,
  (SELECT count(*) FROM nexus.core_runs) AS core_runs,
  (SELECT count(*) FROM nexus.run_steps) AS run_steps,
  (SELECT count(*) FROM nexus.run_results) AS run_results,
  (SELECT count(*) FROM nexus.tool_events) AS tool_events,
  (SELECT count(*) FROM nexus.assistant_memories) AS assistant_memories,
  (SELECT count(*) FROM nexus.memory_permissions) AS memory_permissions,
  (SELECT count(*) FROM nexus.memory_permission_audit) AS memory_permission_audit,
  (SELECT count(*) FROM nexus.global_provider_preferences) AS global_provider_preferences,
  (SELECT count(*) FROM nexus.assistant_provider_preferences) AS assistant_provider_preferences,
  (SELECT count(*) FROM nexus.conversation_provider_preferences) AS conversation_provider_preferences,
  (SELECT count(*) FROM nexus.provider_authorizations) AS provider_authorizations,
  (SELECT count(*) FROM nexus.sync_cursors) AS sync_cursors,
  (SELECT count(*) FROM nexus.tombstones) AS tombstones,
  (SELECT count(*) FROM nexus.tool_grants) AS tool_grants,
  (SELECT count(*) FROM nexus.tool_grant_audit) AS tool_grant_audit,
  (SELECT count(*) FROM nexus.user_assistant_preferences) AS user_assistant_preferences;

-- =============================================================================================
-- §6. ATOMICIDADE: falha intermediaria nao deixa estado parcial
-- =============================================================================================
-- Duas falhas induzidas DENTRO da cascata, cada uma revertida:
--   (a) excecao lancada por um trigger BEFORE DELETE em `messages` — a cascata ja apagou parte
--       das linhas quando ela dispara;
--   (b) violacao de FK RESTRICT temporaria — a cascata tenta apagar a conversa e a FK barra.
--
-- Em ambos os casos o estado inteiro precisa voltar, e a verificacao e por CONTEUDO, nao por
-- contagem: contagem igual com conteudo diferente esconderia corrupcao silenciosa.
CREATE TEMP TABLE atomicity_baseline AS
SELECT
  (SELECT count(*) FROM nexus.owner_identity) AS owners,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) FROM nexus.conversations c) AS convs,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM nexus.messages m) AS msgs,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM nexus.assistant_memories m) AS mems;

-- (a) falha no meio da cascata, via trigger temporario
BEGIN;
  CREATE FUNCTION pg_temp.fail_on_message_delete() RETURNS trigger
  LANGUAGE plpgsql AS $failfn$
  BEGIN
    RAISE EXCEPTION 'falha induzida no meio da cascata' USING ERRCODE = 'P0001';
  END
  $failfn$;
  CREATE TRIGGER probe_fail_before_delete BEFORE DELETE ON nexus.messages
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_on_message_delete();

  DO $sec6a$
  DECLARE
    b record;
    v_owners bigint;
    v_convs jsonb;
    v_msgs jsonb;
    v_mems jsonb;
    disparou boolean := false;
  BEGIN
    SELECT * INTO b FROM pg_temp.atomicity_baseline;
    IF b.convs IS NULL OR b.msgs IS NULL THEN
      RAISE EXCEPTION 'Atomicity (a) precondition: conversations/messages must be populated';
    END IF;

    BEGIN
      DELETE FROM nexus.owner_identity;
    EXCEPTION
      WHEN raise_exception THEN
        disparou := true;
    END;

    IF NOT disparou THEN
      RAISE EXCEPTION 'Atomicity (a): the induced failure did not happen — owner deletion succeeded';
    END IF;

    SELECT (SELECT count(*) FROM nexus.owner_identity),
           (SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) FROM nexus.conversations c),
           (SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM nexus.messages m),
           (SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM nexus.assistant_memories m)
      INTO v_owners, v_convs, v_msgs, v_mems;

    IF v_owners <> b.owners THEN
      RAISE EXCEPTION 'Atomicity (a): owner row not restored (found %)', v_owners;
    END IF;
    IF v_convs IS DISTINCT FROM b.convs OR v_msgs IS DISTINCT FROM b.msgs
       OR v_mems IS DISTINCT FROM b.mems THEN
      RAISE EXCEPTION 'Atomicity (a): data was not restored to its previous content';
    END IF;
  END
  $sec6a$;
ROLLBACK;

-- (b) falha por FK RESTRICT temporaria.
BEGIN;
  DO $sec6b$
  DECLARE
    b record;
    v_convs jsonb;
    v_msgs jsonb;
    estado text;
    disparou boolean := false;
  BEGIN
    SELECT * INTO b FROM pg_temp.atomicity_baseline;

    -- FK RESTRICT realista: uma tabela de referencia que aponta para o owner e NAO possui
    -- ON DELETE CASCADE. A cascata tenta apagar `owner_identity` e para aqui. E o caso de
    -- qualquer tabela futura que guarde dado retido e se recuse a ser apagada em silencio.
    CREATE SCHEMA IF NOT EXISTS probe;
    CREATE TABLE probe.retained (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE RESTRICT
    );
    INSERT INTO probe.retained (id, owner_id)
    VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000000004');

    BEGIN
      DELETE FROM nexus.owner_identity;
    EXCEPTION
      WHEN foreign_key_violation THEN
        GET STACKED DIAGNOSTICS estado = RETURNED_SQLSTATE;
        IF estado <> '23503' THEN
          RAISE EXCEPTION 'Expected 23503 from the induced RESTRICT, got %', estado;
        END IF;
        disparou := true;
    END;

    IF NOT disparou THEN
      RAISE EXCEPTION 'Atomicity (b): the induced RESTRICT failure did not happen';
    END IF;

    SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) FROM nexus.conversations c),
           (SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM nexus.messages m)
      INTO v_convs, v_msgs;

    IF (SELECT count(*) FROM nexus.owner_identity) <> b.owners THEN
      RAISE EXCEPTION 'Atomicity (b): owner row not restored (found %)',
        (SELECT count(*) FROM nexus.owner_identity);
    END IF;
    IF v_convs IS DISTINCT FROM b.convs THEN
      RAISE EXCEPTION 'Atomicity (b): conversations not restored to their previous content';
    END IF;
    IF v_msgs IS DISTINCT FROM b.msgs THEN
      RAISE EXCEPTION 'Atomicity (b): messages not restored to their previous content';
    END IF;
  END
  $sec6b$;
ROLLBACK;

DO $sec6ok$ BEGIN
  RAISE NOTICE '§6 OK: induced failures rolled back completely (content, not just counts)';
END $sec6ok$;

-- --- A EXCLUSAO REAL (commit) ----------------------------------------------------------------
DO $sec5$
DECLARE
  removidas bigint;
BEGIN
  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: owner must exist before the real deletion';
  END IF;
  DELETE FROM nexus.owner_identity;
  GET DIAGNOSTICS removidas = ROW_COUNT;
  IF removidas <> 1 THEN
    RAISE EXCEPTION 'Owner deletion removed % row(s) instead of exactly 1', removidas;
  END IF;
  RAISE NOTICE '§5 OK: owner deleted with all 19 owner tables populated';
END
$sec5$;

-- =============================================================================================
-- §7. ESTADO FINAL: a politica de exclusao foi cumprida?
-- =============================================================================================
DO $sec7$
DECLARE
  r record;
  n bigint;
  sobrou text := '';
  b record;
BEGIN
  SELECT * INTO b FROM pg_temp.pre_delete_snapshot;

  -- (1) Nenhuma linha de owner pode sobrar. Percorre as 19 tabelas de forma declarativa.
  FOR r IN SELECT tabela FROM verify_owner_tables ORDER BY tabela LOOP
    EXECUTE format('SELECT count(*) FROM nexus.%I', r.tabela) INTO n;
    IF n <> 0 THEN sobrou := sobrou || format(' %s=%s', r.tabela, n); END IF;
  END LOOP;
  IF sobrou <> '' THEN
    RAISE EXCEPTION 'Owner deletion left personal data behind:%', sobrou;
  END IF;

  -- (2) As tabelas que TINHAM linhas estavam realmente populadas antes. Sem isso, "zero depois"
  --     poderia significar "nunca populado" e o teste passaria sem provar nada.
  IF b.conversations < 1 OR b.messages < 1 OR b.core_runs < 1 OR b.run_steps < 1
     OR b.run_results < 1 OR b.tool_events < 1 OR b.assistant_memories < 1
     OR b.memory_permissions < 1 OR b.memory_permission_audit < 1
     OR b.tool_grants < 1 OR b.tool_grant_audit < 1 OR b.user_assistant_preferences < 1
     OR b.tombstones < 1 OR b.sync_cursors < 1 OR b.provider_authorizations < 1 THEN
    RAISE EXCEPTION 'Precondition failed: some owner table had no row before deletion, so "zero after" proves nothing: %', to_jsonb(b);
  END IF;

  -- (3) O CATALOGO GLOBAL SOBREVIVE intacto. Retencao deliberada: assistentes, configuracoes,
  --     providers e models nao pertencem ao owner.
  SELECT count(*) INTO n FROM nexus.assistants;
  IF n <> (SELECT assistants_count FROM verify_baseline) THEN
    RAISE EXCEPTION 'Owner deletion changed the GLOBAL assistant catalog: % -> %',
      (SELECT assistants_count FROM verify_baseline), n;
  END IF;
  SELECT count(*) INTO n FROM nexus.assistant_config_versions;
  IF n <> (SELECT config_versions_count FROM verify_baseline) THEN
    RAISE EXCEPTION 'Owner deletion changed the GLOBAL assistant config versions';
  END IF;
  -- O provider/model de prova (`d0000000-…`) foi criado por este arquivo e nao faz parte do
  -- catalogo global pre-existente: ele e descontado da contagem.
  SELECT count(*) INTO n FROM nexus.providers WHERE provider_key <> 'probe-provider';
  IF n <> (SELECT providers_count FROM verify_baseline) THEN
    RAISE EXCEPTION 'Owner deletion changed the GLOBAL provider catalog: % -> %',
      (SELECT providers_count FROM verify_baseline), n;
  END IF;
  SELECT count(*) INTO n FROM nexus.models WHERE model_key <> 'probe-model';
  IF n <> (SELECT models_count FROM verify_baseline) THEN
    RAISE EXCEPTION 'Owner deletion changed the GLOBAL model catalog: % -> %',
      (SELECT models_count FROM verify_baseline), n;
  END IF;
  -- E o provider de prova SOBREVIVE: ele nao pertence ao owner, e a cascata nao o alcanca.
  IF NOT EXISTS (SELECT 1 FROM nexus.providers WHERE provider_key = 'probe-provider') THEN
    RAISE EXCEPTION 'Owner deletion removed a GLOBAL provider that does not belong to the owner';
  END IF;

  -- (4) RETENCAO DECLARADA: `tool_grant_audit` e apagada hoje. Se esta assercao falhar, alguem
  --     mudou a acao da FK sem atualizar a politica de exclusao documentada no topo do arquivo.
  IF (SELECT count(*) FROM nexus.tool_grant_audit) <> 0 THEN
    RAISE EXCEPTION 'tool_grant_audit retention changed: expected 0 rows after owner deletion (see the retention note at the top)';
  END IF;

  RAISE NOTICE '§7 OK: personal data erased, global catalog preserved, retention policy matched';
END
$sec7$;

-- =============================================================================================
-- §8. NENHUM PAPEL RECEBEU SUPERUSER OU BYPASSRLS
-- =============================================================================================
-- A correcao NAO podia ser obtida ampliando privilegios.
DO $sec8$
DECLARE
  r record;
  amplos text := '';
BEGIN
  FOR r IN
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname IN ('nexus_app', 'nexus_migrator', 'nexus_anonymous', 'nexus_audit_writer')
    ORDER BY rolname
  LOOP
    IF r.rolsuper THEN amplos := amplos || ' ' || r.rolname || '=SUPERUSER'; END IF;
    IF r.rolbypassrls THEN amplos := amplos || ' ' || r.rolname || '=BYPASSRLS'; END IF;
  END LOOP;

  IF amplos <> '' THEN
    RAISE EXCEPTION 'Installation roles must not hold SUPERUSER or BYPASSRLS:%', amplos;
  END IF;

  -- `nexus_app` continua sem privilegio de escrita em `owner_identity`, e sem escrita destrutiva
  -- em `tombstones`.
  IF has_table_privilege('nexus_app', 'nexus.owner_identity', 'DELETE') THEN
    RAISE EXCEPTION 'nexus_app gained DELETE on owner_identity';
  END IF;
  IF has_table_privilege('nexus_app', 'nexus.owner_identity', 'INSERT')
     OR has_table_privilege('nexus_app', 'nexus.owner_identity', 'UPDATE') THEN
    RAISE EXCEPTION 'nexus_app gained write privilege on owner_identity';
  END IF;
  IF has_table_privilege('nexus_app', 'nexus.tombstones', 'DELETE')
     OR has_table_privilege('nexus_app', 'nexus.tombstones', 'UPDATE') THEN
    RAISE EXCEPTION 'nexus_app gained destructive privilege on tombstones';
  END IF;

  RAISE NOTICE '§8 OK: no role holds SUPERUSER/BYPASSRLS; nexus_app still read-only on the singleton';
END
$sec8$;

DROP TABLE IF EXISTS pg_temp.verify_owner_tables;
DROP TABLE IF EXISTS pg_temp.verify_baseline;
DROP TABLE IF EXISTS pg_temp.pre_delete_snapshot;
DROP TABLE IF EXISTS pg_temp.atomicity_baseline;

DO $final$ BEGIN
  RAISE NOTICE 'Owner deletion verification passed: the installation is definitively deletable';
END $final$;

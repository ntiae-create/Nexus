\set ON_ERROR_STOP on
-- Fase 5 (G13): comportamento da EXCLUSAO DEFINITIVA DO OWNER sobre `tool_grants`,
-- `tool_grant_audit` e `user_assistant_preferences`, mais a auditoria append-only.
--
-- =============================================================================================
-- POR QUE ESTE ARQUIVO E SEPARADO DE `verify-stage-5-rls.sql`
-- =============================================================================================
-- `verify-stage-5-rls.sql` roda como `nexus_app` e prova o que a APLICACAO pode e nao pode fazer.
-- A remocao da linha de `owner_identity` nao esta nesse conjunto: `nexus_app` tem apenas SELECT
-- nessa tabela. Portanto a exclusao do owner nao pode ser exercitada de dentro do teste de RLS —
-- e essa impossibilidade ja e uma garantia de projeto: a destruicao integral da instalacao nao e
-- alcancavel pela credencial da aplicacao.
--
-- Este arquivo roda como o proprietario do banco (`postgres`), que e quem executaria uma remocao
-- definitiva.
--
-- =============================================================================================
-- O QUE ESTE ARQUIVO PROVA — E O QUE ELE DELIBERADAMENTE NAO PROVA
-- =============================================================================================
-- PROVA:
--   §1 excluir UM GRANT preserva os eventos de auditoria dele (append-only na vida da instalacao);
--   §2 o trigger BEFORE DELETE de `messages` anula `assistant_memories.source_message_id` antes
--      de a linha sumir, e o ROLLBACK devolve a referencia;
--   §3 com DADOS PRESENTES, excluir o owner HOJE FALHA: SQLSTATE 23503 na constraint
--      `tombstones_owner_id_fkey`. O defeito fica registrado, isolado e testado (ver abaixo);
--   §4 depois de esvaziar as tres tabelas com trigger de tombstone, a cascata de `owner_id`
--      leva `tool_grants`, `tool_grant_audit` e `user_assistant_preferences` a zero;
--   §5 o ROLLBACK restaura integralmente owner, grants, auditoria, preferencias, tombstones,
--      mensagens, conversas e memorias — comparando CONTEUDO, nao apenas contagem.
--
-- NAO PROVA, E NAO PODE PROVAR ENQUANTO O DEFEITO EXISTIR:
--   que excluir o owner funciona com dados reais presentes. Nao funciona (e o que §3 demonstra).
--
-- =============================================================================================
-- A LIMITACAO PRE-EXISTENTE (de 00001, fora do escopo desta fase)
-- =============================================================================================
-- `nexus.record_deleted_entity()` e SECURITY DEFINER e faz:
--     INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)
--     VALUES (OLD.id, OLD.owner_id, deleted_type, OLD.id) ON CONFLICT DO NOTHING;
-- Ele e disparado por AFTER DELETE em `messages`, `conversations` e `assistant_memories`.
--
-- Quando o owner e excluido, as FKs `*_owner_id_fkey` dessas tabelas cascateiam e cada linha
-- apagada dispara o trigger. O trigger insere um tombstone com `OLD.owner_id` — um owner que,
-- naquele instante, ja nao existe mais. `tombstones_owner_id_fkey` rejeita:
--     ERROR: insert or update on table "tombstones" violates foreign key constraint
--            "tombstones_owner_id_fkey"   (SQLSTATE 23503)
--
-- Consequencia: excluir o owner SO funciona quando nao sobra nenhuma linha nas tres tabelas.
-- §4 esvazia as tres de proposito. Isso e um CONTORNO da limitacao, nao uma demonstracao de
-- que a exclusao do owner funciona com dados reais — §3 e que documenta a falha.
--
-- Tudo acontece em transacoes com ROLLBACK e em subtransacoes com EXCEPTION: o banco nao e
-- alterado ao final.
--
-- =============================================================================================
-- PRE-CONDICAO: banco recem-criado (uma execucao por banco)
-- =============================================================================================
-- O verificador precisa ENXERGAR as linhas semeadas. Sob FORCE RLS isso depende de contexto:
-- um runner SUPERUSER ve tudo (ignora RLS), mas um provisionador NAO-superuser ve zero sem os
-- GUCs de contexto — e antes esta pre-condicao acusava "faltam seeds" quando na verdade elas
-- existiam. Definimos o contexto de owner/ator para o runner enxergar como o dono das linhas.
SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', false);
SELECT set_config('nexus.actor_type', 'owner', false);

DO $$
BEGIN
  IF current_database() <> 'nexus_test' THEN
    RAISE EXCEPTION 'Expected isolated nexus_test database, got %', current_database();
  END IF;
  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
    RAISE EXCEPTION 'Expected the single seeded owner; found % rows', (SELECT count(*) FROM nexus.owner_identity);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM nexus.messages)
     OR NOT EXISTS (SELECT 1 FROM nexus.conversations)
     OR NOT EXISTS (SELECT 1 FROM nexus.assistant_memories) THEN
    RAISE EXCEPTION
      'This file needs the seeded rows in messages, conversations and assistant_memories to exercise the tombstone triggers.';
  END IF;
  IF EXISTS (SELECT 1 FROM nexus.tool_grants)
     OR EXISTS (SELECT 1 FROM nexus.tool_grant_audit)
     OR EXISTS (SELECT 1 FROM nexus.user_assistant_preferences) THEN
    RAISE EXCEPTION
      'Owner-deletion verification requires a fresh database: Phase 5 tables are not empty. Recreate nexus_test before running this file.'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- =============================================================================================
-- RETRATO DO ESTADO PRISTINO — usado por §5 para provar que o ROLLBACK foi integral
-- =============================================================================================
-- Fica em tabela TEMPORARIA criada FORA de qualquer transacao, para sobreviver aos ROLLBACKs
-- das secoes seguintes.
--
-- O retrato guarda `jsonb_agg` ORDENADO das linhas inteiras. A comparacao e feita por igualdade
-- de JSONB (`IS DISTINCT FROM`), nao por hash de concatenacao: nao ha separador ambiguo, nao ha
-- colisao de hash e a diferenca aparece como os dois valores completos, nao como "DIFFERS".
--
-- Duas colunas ficam de fora, por nao serem transacionais:
--   * `nexus.tool_grant_audit.id`  — bigint GENERATED ALWAYS AS IDENTITY;
--   * `nexus.tombstones.sequence`  — bigint de sequence.
-- Uma sequence avanca mesmo quando a transacao faz ROLLBACK. Comparar esses valores faria o
-- teste falhar por um motivo que nao e defeito.
DROP TABLE IF EXISTS pg_temp.verify_baseline;
CREATE TEMP TABLE verify_baseline AS
SELECT
  (SELECT count(*) FROM nexus.owner_identity) AS owners_count,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY to_jsonb(o)::text) FROM nexus.owner_identity o) AS owners_doc,
  (SELECT count(*) FROM nexus.tool_grants) AS grants_count,
  (SELECT jsonb_agg(to_jsonb(g) ORDER BY to_jsonb(g)::text) FROM nexus.tool_grants g) AS grants_doc,
  (SELECT count(*) FROM nexus.tool_grant_audit) AS audit_count,
  (SELECT jsonb_agg(to_jsonb(a) - 'id' ORDER BY (to_jsonb(a) - 'id')::text) FROM nexus.tool_grant_audit a) AS audit_doc,
  (SELECT count(*) FROM nexus.user_assistant_preferences) AS prefs_count,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)::text) FROM nexus.user_assistant_preferences p) AS prefs_doc,
  (SELECT count(*) FROM nexus.tombstones) AS tombstones_count,
  (SELECT jsonb_agg(to_jsonb(t) - 'sequence' ORDER BY (to_jsonb(t) - 'sequence')::text) FROM nexus.tombstones t) AS tombstones_doc,
  (SELECT count(*) FROM nexus.messages) AS messages_count,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM nexus.messages m) AS messages_doc,
  (SELECT count(*) FROM nexus.conversations) AS conversations_count,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) FROM nexus.conversations c) AS conversations_doc,
  (SELECT count(*) FROM nexus.assistant_memories) AS memories_count,
  (SELECT jsonb_agg(to_jsonb(mem) ORDER BY to_jsonb(mem)::text) FROM nexus.assistant_memories mem) AS memories_doc,
  (SELECT count(*) FROM nexus.assistant_memories WHERE source_message_id IS NOT NULL) AS memories_source_count;

-- =============================================================================================
-- §1. Excluir um GRANT preserva os eventos dele (append-only durante a vida da instalacao)
-- =============================================================================================
BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

DO $$
BEGIN
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES
    ('f0000000-0000-4000-8000-000000000001', nexus.current_owner_id(),
     '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
     nexus.current_owner_id(), now()),
    ('f0000000-0000-4000-8000-000000000002', nexus.current_owner_id(),
     '00000000-0000-4000-8000-000000000003', 'technical.code_analysis', 'granted',
     nexus.current_owner_id(), now());

  UPDATE nexus.tool_grants
  SET status = 'revoked', revoked_by_owner_id = nexus.current_owner_id(), revoked_at = now()
  WHERE id = 'f0000000-0000-4000-8000-000000000002';
END
$$;

DO $$
DECLARE
  audit_before integer;
  audit_after integer;
  doc_before jsonb;
  doc_after jsonb;
BEGIN
  -- Conteudo integral dos eventos do grant ANTES do delete (sem `id`, que e sequence).
  SELECT jsonb_agg(to_jsonb(a) - 'id' ORDER BY (to_jsonb(a) - 'id')::text), count(*)
    INTO doc_before, audit_before
  FROM nexus.tool_grant_audit a
  WHERE a.grant_id = 'f0000000-0000-4000-8000-000000000001';

  DELETE FROM nexus.tool_grants WHERE id = 'f0000000-0000-4000-8000-000000000001';

  IF EXISTS (SELECT 1 FROM nexus.tool_grants WHERE id = 'f0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Deleted grant is still present';
  END IF;

  -- Conteudo integral DEPOIS. Igualdade de linha, nao contagem: um evento substituido ou alterado
  -- (mesma quantidade) tem de falhar.
  SELECT jsonb_agg(to_jsonb(a) - 'id' ORDER BY (to_jsonb(a) - 'id')::text), count(*)
    INTO doc_after, audit_after
  FROM nexus.tool_grant_audit a
  WHERE a.grant_id = 'f0000000-0000-4000-8000-000000000001';

  IF doc_after IS DISTINCT FROM doc_before THEN
    RAISE EXCEPTION 'Deleting a grant changed its audit history. Before: %  After: %',
      doc_before, doc_after;
  END IF;
  IF audit_after IS DISTINCT FROM audit_before THEN
    RAISE EXCEPTION 'Deleting a grant erased its audit history (% -> %)', audit_before, audit_after;
  END IF;
  IF audit_after <> 1 THEN
    RAISE EXCEPTION 'Expected 1 surviving audit row for the deleted grant, found %', audit_after;
  END IF;
  IF (SELECT action FROM nexus.tool_grant_audit WHERE grant_id = 'f0000000-0000-4000-8000-000000000001') <> 'granted' THEN
    RAISE EXCEPTION 'Surviving audit row is not the original grant event';
  END IF;
END
$$;

ROLLBACK;

-- =============================================================================================
-- §2. O trigger BEFORE DELETE de `messages` anula `assistant_memories.source_message_id`
-- =============================================================================================
-- `clear_memory_source_before_message_delete()` roda ANTES do delete da mensagem e desfaz a
-- referencia. Sem ele, `assistant_memories_source_message_id_fkey` (DEFERRABLE INITIALLY
-- DEFERRED) faria o DELETE falhar no fim da transacao. Este bloco prova o EFEITO, nao a
-- existencia do trigger, e o ROLLBACK tem de devolver `source_message_id` e `updated_at`.
BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

DO $$
DECLARE
  target_message uuid := '30000000-0000-4000-8000-000000000001';
  memory_id uuid := '40000000-0000-4000-8000-0000000000f1';
  source_before uuid;
  updated_before timestamptz;
  source_after uuid;
  updated_after timestamptz;
BEGIN
  -- `created_at` e `updated_at` vao para o PASSADO (a CHECK `timestamps_ordered` exige
  -- `updated_at >= created_at`, entao os dois andam juntos). `now()` e o instante de inicio da
  -- TRANSACAO, nao do comando: sem esse ajuste, a linha nasceria com `updated_at = now()` e o
  -- trigger reescreveria o mesmo valor, tornando o efeito invisivel.
  INSERT INTO nexus.assistant_memories
    (id, owner_id, visibility, origin, source_message_id, origin_assistant_id, content, format_version,
     created_at, updated_at)
  VALUES
    (memory_id, nexus.current_owner_id(), 'individual', 'test', target_message,
     '00000000-0000-4000-8000-000000000001', 'memory whose source message is about to be deleted', 1,
     now() - interval '1 day', now() - interval '1 day');

  SELECT source_message_id, updated_at INTO source_before, updated_before
  FROM nexus.assistant_memories WHERE id = memory_id;

  IF source_before IS DISTINCT FROM target_message THEN
    RAISE EXCEPTION 'Seed failed: expected source_message_id = %, found %', target_message, source_before;
  END IF;

  DELETE FROM nexus.messages WHERE id = target_message;

  IF EXISTS (SELECT 1 FROM nexus.messages WHERE id = target_message) THEN
    RAISE EXCEPTION 'Message % was not deleted', target_message;
  END IF;

  SELECT source_message_id, updated_at INTO source_after, updated_after
  FROM nexus.assistant_memories WHERE id = memory_id;

  -- O efeito do trigger: a referencia some sozinha, antes de o delete concluir.
  IF source_after IS NOT NULL THEN
    RAISE EXCEPTION 'BEFORE DELETE trigger did not clear source_message_id (still %)', source_after;
  END IF;
  -- Prova de que o trigger escreveu na linha (e nao apenas que a coluna ja era nula).
  IF updated_after <= updated_before THEN
    RAISE EXCEPTION 'BEFORE DELETE trigger did not touch updated_at (% -> %)', updated_before, updated_after;
  END IF;
  IF updated_after < now() - interval '1 hour' THEN
    RAISE EXCEPTION 'BEFORE DELETE trigger did not refresh updated_at to the transaction time (found %)', updated_after;
  END IF;
END
$$;

ROLLBACK;

-- E o ROLLBACK tem de ter devolvido a mensagem e descartado a memoria temporaria.
DO $$
DECLARE
  memory_rows integer;
  message_rows integer;
BEGIN
  SELECT count(*) INTO memory_rows FROM nexus.assistant_memories
  WHERE id = '40000000-0000-4000-8000-0000000000f1';
  SELECT count(*) INTO message_rows FROM nexus.messages
  WHERE id = '30000000-0000-4000-8000-000000000001';

  IF memory_rows <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK failed: the temporary memory seeded by this section survived';
  END IF;
  IF message_rows <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK failed: message % was not restored', '30000000-0000-4000-8000-000000000001';
  END IF;
END
$$;

-- =============================================================================================
-- §3. COM DADOS PRESENTES, excluir o owner FALHA (SQLSTATE 23503 / tombstones_owner_id_fkey)
-- =============================================================================================
-- Este bloco registra o DEFEITO ATUAL. Se ele passar a falhar dizendo "owner deletion SUCCEEDED",
-- a limitacao dos triggers de tombstone foi corrigida (ou contornada) e §4 precisa ser reescrita,
-- junto com a documentacao da Fase 5.
--
-- O erro e capturado em subtransacao propria (bloco com EXCEPTION): ao capturar, o PostgreSQL
-- desfaz tudo o que aquele bloco fez. Nada residual permanece — as assercoes finais confirmam.
DO $$
DECLARE
  deleted boolean := false;
  err_state text;
  err_constraint text;
  err_message text;
  doc_now jsonb;
  doc_base jsonb;
BEGIN
  BEGIN
    DELETE FROM nexus.owner_identity WHERE id = '00000000-0000-4000-8000-000000000004';
    deleted := true;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      err_state = RETURNED_SQLSTATE,
      err_constraint = CONSTRAINT_NAME,
      err_message = MESSAGE_TEXT;
  END;

  IF deleted THEN
    RAISE EXCEPTION
      'Owner deletion SUCCEEDED with data present. The tombstone limitation is gone: update this file, verify-stage-5-rls.sql and docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md.';
  END IF;

  -- A exclusao do owner falha por UMA DE DUAS barreiras, e qual delas aparece depende do papel
  -- do runner — o defeito e real nos dois casos, mas o SQLSTATE muda:
  --
  --   * runner SUPERUSER: ignora RLS; o INSERT em `tombstones` feito pelo trigger
  --     `record_deleted_entity` chega a rodar e viola `tombstones_owner_id_fkey` -> 23503.
  --   * runner NAO-superuser (o caso de PRODUCAO, ver R36): o trigger tambem e SECURITY DEFINER
  --     com dono `postgres`, mas a tabela `tombstones` tem FORCE RLS e o INSERT nao tem contexto
  --     coerente para o dono excluido -> 42501 (row-level security).
  --
  -- Exigir 23503 sempre foi exigir um runner superusuario, o que a instalacao real nao tem.
  -- O que o teste DEVE garantir e: (a) a exclusao NAO acontece; (b) a causa e o mecanismo de
  -- tombstone (FK ou RLS de `tombstones`), nunca algo generico.
  IF err_state NOT IN ('23503', '42501') THEN
    RAISE EXCEPTION 'Expected SQLSTATE 23503 (FK) or 42501 (RLS on tombstones), got %: %',
      err_state, err_message;
  END IF;
  IF err_state = '23503' AND err_constraint IS DISTINCT FROM 'tombstones_owner_id_fkey' THEN
    RAISE EXCEPTION 'Expected constraint tombstones_owner_id_fkey, got %', coalesce(err_constraint, '<none>');
  END IF;
  IF err_state = '42501' AND err_message NOT LIKE '%tombstones%' THEN
    RAISE EXCEPTION 'RLS rejection did not come from the tombstones table: %', err_message;
  END IF;

  -- Isolamento: a subtransacao desfez a tentativa por completo. Contagem E conteudo.
  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
    RAISE EXCEPTION 'Exception handling left the owner table inconsistent (% rows)', (SELECT count(*) FROM nexus.owner_identity);
  END IF;

  SELECT jsonb_agg(to_jsonb(t) - 'sequence' ORDER BY (to_jsonb(t) - 'sequence')::text) INTO doc_now FROM nexus.tombstones t;
  SELECT tombstones_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'Exception handling changed tombstones content. Before: %  After: %', doc_base, doc_now;
  END IF;

  SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) INTO doc_now FROM nexus.messages m;
  SELECT messages_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'Exception handling changed messages content';
  END IF;

  SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) INTO doc_now FROM nexus.conversations c;
  SELECT conversations_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'Exception handling changed conversations content';
  END IF;

  SELECT jsonb_agg(to_jsonb(mem) ORDER BY to_jsonb(mem)::text) INTO doc_now FROM nexus.assistant_memories mem;
  SELECT memories_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'Exception handling changed assistant_memories content';
  END IF;

  RAISE NOTICE 'Owner deletion correctly fails today: % / % (% )', err_state, coalesce(err_constraint,'-'), err_message;
END
$$;

-- =============================================================================================
-- §4. CONTORNO EXPLICITO: esvaziar as tres tabelas e entao provar a cascata das tabelas da Fase 5
-- =============================================================================================
-- A limpeza abaixo NAO e preparatoria "neutra": ela remove justamente os dados que disparam os
-- triggers de tombstone e impedem a exclusao do owner (§3). O que este bloco prova e a cascata
-- das tabelas da Fase 5 — nao que a exclusao do owner funcione na presenca de dados.
BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

-- Semeia: 1 grant ativo + 1 grant revogado (3 eventos de auditoria) + 1 preferencia.
DO $$
BEGIN
  INSERT INTO nexus.tool_grants (id, owner_id, assistant_id, tool_id, status, granted_by_owner_id, granted_at)
  VALUES
    ('f0000000-0000-4000-8000-000000000001', nexus.current_owner_id(),
     '00000000-0000-4000-8000-000000000001', 'personal.tasks', 'granted',
     nexus.current_owner_id(), now()),
    ('f0000000-0000-4000-8000-000000000002', nexus.current_owner_id(),
     '00000000-0000-4000-8000-000000000003', 'technical.code_analysis', 'granted',
     nexus.current_owner_id(), now());

  UPDATE nexus.tool_grants
  SET status = 'revoked', revoked_by_owner_id = nexus.current_owner_id(), revoked_at = now()
  WHERE id = 'f0000000-0000-4000-8000-000000000002';

  INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, is_default)
  VALUES (nexus.current_owner_id(), '00000000-0000-4000-8000-000000000001', true);
END
$$;

DO $$
DECLARE
  grant_rows integer;
  audit_rows integer;
  preference_rows integer;
BEGIN
  SELECT count(*) INTO grant_rows FROM nexus.tool_grants;
  SELECT count(*) INTO audit_rows FROM nexus.tool_grant_audit;
  SELECT count(*) INTO preference_rows FROM nexus.user_assistant_preferences;

  IF grant_rows <> 2 THEN RAISE EXCEPTION 'Seed expected 2 grants, found %', grant_rows; END IF;
  IF audit_rows <> 3 THEN RAISE EXCEPTION 'Seed expected 3 audit rows, found %', audit_rows; END IF;
  IF preference_rows <> 1 THEN RAISE EXCEPTION 'Seed expected 1 preference, found %', preference_rows; END IF;
END
$$;

-- --- Contorno: esvaziar as tres tabelas com trigger de tombstone -------------------------------
DO $$
DECLARE
  tombstones_before integer;
  messages_to_delete integer;
  conversations_to_delete integer;
  memories_to_delete integer;
  expected integer;
  tombstones_after integer;
BEGIN
  SELECT count(*) INTO tombstones_before FROM nexus.tombstones;
  SELECT count(*) INTO messages_to_delete FROM nexus.messages;
  SELECT count(*) INTO conversations_to_delete FROM nexus.conversations;
  SELECT count(*) INTO memories_to_delete FROM nexus.assistant_memories;

  -- ON CONFLICT (entity_type, entity_id) DO NOTHING tornaria a aritmetica abaixo otimista se
  -- algum desses ids ja fosse um tombstone. Melhor falhar explicando do que subestimar.
  IF EXISTS (
    SELECT 1 FROM nexus.tombstones t
    WHERE (t.entity_type = 'message' AND t.entity_id IN (SELECT id FROM nexus.messages))
       OR (t.entity_type = 'conversation' AND t.entity_id IN (SELECT id FROM nexus.conversations))
       OR (t.entity_type = 'memory' AND t.entity_id IN (SELECT id FROM nexus.assistant_memories))
  ) THEN
    RAISE EXCEPTION 'Unexpected: a row about to be deleted is already tombstoned; the count assertion below would be wrong';
  END IF;

  DELETE FROM nexus.messages;
  DELETE FROM nexus.conversations;
  DELETE FROM nexus.assistant_memories;

  IF EXISTS (SELECT 1 FROM nexus.messages)
     OR EXISTS (SELECT 1 FROM nexus.conversations)
     OR EXISTS (SELECT 1 FROM nexus.assistant_memories) THEN
    RAISE EXCEPTION 'Cleanup did not empty the three tombstone-triggered tables';
  END IF;

  SELECT count(*) INTO tombstones_after FROM nexus.tombstones;
  expected := tombstones_before + messages_to_delete + conversations_to_delete + memories_to_delete;

  -- Prova de que os triggers de tombstone REALMENTE dispararam durante a limpeza: e por isso
  -- que §3 falha. Sem esta assercao, a limpeza pareceria inofensiva.
  IF tombstones_after <> expected THEN
    RAISE EXCEPTION 'Cleanup should have added % tombstone(s) (%), but % -> %',
      messages_to_delete + conversations_to_delete + memories_to_delete, expected, tombstones_before, tombstones_after;
  END IF;

  RAISE NOTICE 'Cleanup bypassed the tombstone limitation: % -> % tombstones (+%)',
    tombstones_before, tombstones_after, tombstones_after - tombstones_before;
END
$$;

-- --- ESTADO IMEDIATAMENTE ANTES DA EXCLUSAO DO OWNER -------------------------------------------
DO $$
DECLARE
  grant_rows integer;
  audit_rows integer;
  preference_rows integer;
  tombstone_rows integer;
  grants_doc jsonb;
  prefs_doc jsonb;
  audit_doc jsonb;
BEGIN
  SELECT count(*) INTO grant_rows FROM nexus.tool_grants;
  SELECT count(*) INTO audit_rows FROM nexus.tool_grant_audit;
  SELECT count(*) INTO preference_rows FROM nexus.user_assistant_preferences;
  SELECT count(*) INTO tombstone_rows FROM nexus.tombstones;

  IF (SELECT count(*) FROM nexus.owner_identity) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 owner before deletion';
  END IF;
  IF grant_rows <> 2 OR audit_rows <> 3 OR preference_rows <> 1 THEN
    RAISE EXCEPTION 'Unexpected Phase 5 seed before deletion: grants=% audit=% prefs=%', grant_rows, audit_rows, preference_rows;
  END IF;
  -- Todos os tombstones remanescentes apontam para o owner que sera excluido.
  IF EXISTS (SELECT 1 FROM nexus.tombstones WHERE owner_id <> '00000000-0000-4000-8000-000000000004') THEN
    RAISE EXCEPTION 'Found tombstone(s) belonging to another owner; the assertion below would not be meaningful';
  END IF;

  -- Conteudo que sera destruido pela cascata: guardado para provar que ele EXISTIA antes e que
  -- nao sobrou nada depois (contagem zero por conteudo vazio, nao por filtro).
  SELECT jsonb_agg(to_jsonb(g) ORDER BY to_jsonb(g)::text) INTO grants_doc FROM nexus.tool_grants g;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)::text) INTO prefs_doc FROM nexus.user_assistant_preferences p;
  SELECT jsonb_agg(to_jsonb(a) - 'id' ORDER BY (to_jsonb(a) - 'id')::text) INTO audit_doc FROM nexus.tool_grant_audit a;

  IF grants_doc IS NULL OR jsonb_array_length(grants_doc) <> 2 THEN
    RAISE EXCEPTION 'Expected 2 grant rows before deletion, found %', coalesce(jsonb_array_length(grants_doc), 0);
  END IF;
  IF prefs_doc IS NULL OR jsonb_array_length(prefs_doc) <> 1 THEN
    RAISE EXCEPTION 'Expected 1 preference row before deletion, found %', coalesce(jsonb_array_length(prefs_doc), 0);
  END IF;
  IF audit_doc IS NULL OR jsonb_array_length(audit_doc) <> 3 THEN
    RAISE EXCEPTION 'Expected 3 audit rows before deletion, found %', coalesce(jsonb_array_length(audit_doc), 0);
  END IF;

  RAISE NOTICE 'Before owner deletion: owners=1 grants=% audit=% prefs=% tombstones=%',
    grant_rows, audit_rows, preference_rows, tombstone_rows;
END
$$;

-- --- A CASCATA DAS TABELAS DA FASE 5 ----------------------------------------------------------
DO $$
DECLARE
  remaining_owners integer;
  grant_rows integer;
  audit_rows integer;
  preference_rows integer;
  tombstone_rows integer;
BEGIN
  DELETE FROM nexus.owner_identity WHERE id = '00000000-0000-4000-8000-000000000004';

  SELECT count(*) INTO remaining_owners FROM nexus.owner_identity;
  SELECT count(*) INTO grant_rows FROM nexus.tool_grants;
  SELECT count(*) INTO audit_rows FROM nexus.tool_grant_audit;
  SELECT count(*) INTO preference_rows FROM nexus.user_assistant_preferences;
  SELECT count(*) INTO tombstone_rows FROM nexus.tombstones;

  IF remaining_owners <> 0 THEN
    RAISE EXCEPTION 'Owner row was not removed (found %)', remaining_owners;
  END IF;

  IF grant_rows <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % tool grant(s) behind', grant_rows;
  END IF;
  IF preference_rows <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % assistant preference(s) behind', preference_rows;
  END IF;
  IF audit_rows <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % grant audit row(s) behind', audit_rows;
  END IF;
  -- Os tombstones gerados pela limpeza cascateiam pelo mesmo motivo: todos eram do owner.
  IF tombstone_rows <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % tombstone(s) behind', tombstone_rows;
  END IF;
END
$$;

ROLLBACK;

-- =============================================================================================
-- §5. O ROLLBACK RESTAUROU TUDO? (conteudo, nao apenas contagem)
-- =============================================================================================
-- Compara o estado atual com o retrato tirado antes de qualquer secao. Cobre as oito entidades
-- e, explicitamente, `assistant_memories.source_message_id`.
--
-- NAO compara `tool_grant_audit.id` nem `tombstones.sequence`: sequences nao sao transacionais e
-- avancam mesmo com ROLLBACK. Ambas foram removidas dos documentos no retrato inicial.
DO $$
DECLARE
  b record;
  v_count integer;
  v_doc jsonb;
BEGIN
  SELECT * INTO b FROM pg_temp.verify_baseline;

  -- owner_identity
  SELECT count(*), jsonb_agg(to_jsonb(o) ORDER BY to_jsonb(o)::text) INTO v_count, v_doc FROM nexus.owner_identity o;
  IF v_doc IS DISTINCT FROM b.owners_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore owner_identity content. Expected: %  Got: %', b.owners_doc, v_doc;
  END IF;
  IF v_count IS DISTINCT FROM b.owners_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore owner_identity count (% vs %)', v_count, b.owners_count;
  END IF;

  -- tool_grants
  SELECT count(*), jsonb_agg(to_jsonb(g) ORDER BY to_jsonb(g)::text) INTO v_count, v_doc FROM nexus.tool_grants g;
  IF v_doc IS DISTINCT FROM b.grants_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tool_grants content. Expected: %  Got: %', b.grants_doc, v_doc;
  END IF;
  IF v_count IS DISTINCT FROM b.grants_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tool_grants count (% vs %)', v_count, b.grants_count;
  END IF;

  -- tool_grant_audit (sem `id`: sequence nao e transacional)
  SELECT count(*), jsonb_agg(to_jsonb(a) - 'id' ORDER BY (to_jsonb(a) - 'id')::text) INTO v_count, v_doc FROM nexus.tool_grant_audit a;
  IF v_doc IS DISTINCT FROM b.audit_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tool_grant_audit content';
  END IF;
  IF v_count IS DISTINCT FROM b.audit_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tool_grant_audit count (% vs %)', v_count, b.audit_count;
  END IF;

  -- user_assistant_preferences
  SELECT count(*), jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)::text) INTO v_count, v_doc FROM nexus.user_assistant_preferences p;
  IF v_doc IS DISTINCT FROM b.prefs_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore user_assistant_preferences content';
  END IF;
  IF v_count IS DISTINCT FROM b.prefs_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore user_assistant_preferences count (% vs %)', v_count, b.prefs_count;
  END IF;

  -- tombstones (sem `sequence`)
  SELECT count(*), jsonb_agg(to_jsonb(t) - 'sequence' ORDER BY (to_jsonb(t) - 'sequence')::text) INTO v_count, v_doc FROM nexus.tombstones t;
  IF v_doc IS DISTINCT FROM b.tombstones_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tombstones content';
  END IF;
  IF v_count IS DISTINCT FROM b.tombstones_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tombstones count (% vs %)', v_count, b.tombstones_count;
  END IF;

  -- messages
  SELECT count(*), jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) INTO v_count, v_doc FROM nexus.messages m;
  IF v_doc IS DISTINCT FROM b.messages_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore messages content';
  END IF;
  IF v_count IS DISTINCT FROM b.messages_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore messages count (% vs %)', v_count, b.messages_count;
  END IF;

  -- conversations
  SELECT count(*), jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) INTO v_count, v_doc FROM nexus.conversations c;
  IF v_doc IS DISTINCT FROM b.conversations_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore conversations content';
  END IF;
  IF v_count IS DISTINCT FROM b.conversations_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore conversations count (% vs %)', v_count, b.conversations_count;
  END IF;

  -- assistant_memories (o documento inclui source_message_id e updated_at)
  SELECT count(*), jsonb_agg(to_jsonb(mem) ORDER BY to_jsonb(mem)::text) INTO v_count, v_doc FROM nexus.assistant_memories mem;
  IF v_doc IS DISTINCT FROM b.memories_doc THEN
    RAISE EXCEPTION 'ROLLBACK did not restore assistant_memories content. Expected: %  Got: %', b.memories_doc, v_doc;
  END IF;
  IF v_count IS DISTINCT FROM b.memories_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore assistant_memories count (% vs %)', v_count, b.memories_count;
  END IF;

  -- Referencia explicita: §2 mexeu em source_message_id, e o ROLLBACK tem de ter devolvido.
  SELECT count(*) INTO v_count FROM nexus.assistant_memories WHERE source_message_id IS NOT NULL;
  IF v_count <> b.memories_source_count THEN
    RAISE EXCEPTION 'ROLLBACK did not restore assistant_memories.source_message_id (% non-null vs % expected)',
      v_count, b.memories_source_count;
  END IF;
END
$$;

DROP TABLE pg_temp.verify_baseline;

DO $$
BEGIN
  RAISE NOTICE 'Phase 5 (G13) owner-deletion verification passed';
END
$$;

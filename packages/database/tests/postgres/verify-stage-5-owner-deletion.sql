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
--   §3 com DADOS PRESENTES, excluir o owner FUNCIONA (migration 00008): a cascata leva os dados
--      pessoais a zero, os tombstones tambem, o catalogo global fica, e o ROLLBACK restaura tudo;
--   §4 depois de esvaziar as tres tabelas com trigger de tombstone, a cascata de `owner_id`
--      leva `tool_grants`, `tool_grant_audit` e `user_assistant_preferences` a zero;
--   §5 o ROLLBACK restaura integralmente owner, grants, auditoria, preferencias, tombstones,
--      mensagens, conversas e memorias — comparando CONTEUDO, nao apenas contagem.
--
-- NAO PROVA:
--   que a exclusao persiste fora da transacao — §3 roda em subtransacao com EXCEPTION e desfaz.
--   Essa prova (COMMIT de verdade, estado final medido depois) vive em `verify-owner-deletion.sql`,
--   que e o unico verificador que comita a exclusao e por isso roda por ultimo no runner.
--
-- =============================================================================================
-- O DEFEITO PRE-EXISTENTE (de 00001) E SUA CORRECAO (00008)
-- =============================================================================================
-- `nexus.record_deleted_entity()` e SECURITY DEFINER e faz:
--     INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)
--     VALUES (OLD.id, OLD.owner_id, deleted_type, OLD.id) ON CONFLICT DO NOTHING;
-- Ele e disparado por AFTER DELETE em `messages`, `conversations` e `assistant_memories`.
--
-- Quando o owner e excluido, as FKs `*_owner_id_fkey` dessas tabelas cascateiam e cada linha
-- apagada dispara o trigger. O trigger insere um tombstone com `OLD.owner_id` — um owner que,
-- naquele instante, ja nao existe mais.
--
-- A recusa NAO vem da FK. `SECURITY DEFINER` nao contorna `FORCE ROW LEVEL SECURITY`; como o dono
-- da funcao e `nexus_migrator` (rolbypassrls = f), a policy de INSERT de `tombstones` e aplicada.
-- Ela exige `owner_id = nexus.configured_owner_id()`, e essa funcao consulta `owner_identity` — ja
-- vazia. A policy avalia NULL e recusa ANTES de a FK ser verificada:
--     ERROR: new row violates row-level security policy for table "tombstones"   (SQLSTATE 42501)
-- O 23503 so aparece com um runner SUPERUSER, que contorna a policy e chega a FK.
--
-- A migration 00008 fecha o buraco com um guard de existencia do owner dentro da funcao: sem
-- owner nao ha dispositivo a reconciliar nem destino valido para a FK, e o tombstone nao e
-- gravado. Nenhum privilegio e ampliado, nenhuma policy e alterada.
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
-- §3. COM DADOS PRESENTES, excluir o owner FUNCIONA (corrigido pela migration 00008)
-- =============================================================================================
-- HISTORICO DESTE BLOCO. Ele foi escrito quando a exclusao do owner falhava com dados presentes:
-- o trigger `record_deleted_entity()` (00001) tentava gravar em `tombstones` um `owner_id` que a
-- cascata acabara de apagar, e a policy de FORMA RLS de `tombstones` recusava com SQLSTATE 42501
-- (a FK `tombstones_owner_id_fkey` nunca chegava a ser avaliada, de modo que o 23503 registrado
-- nas rodadas anteriores so aparecia com um runner SUPERUSER, que contorna RLS).
--
-- A migration 00008 corrige isso com um guard de existencia do owner antes do INSERT. Este bloco
-- passa a verificar o comportamento CORRIGIDO, e continua sendo uma assercao — nao um comentario.
--
-- O que ele NAO faz: excluir de verdade. Tudo roda em subtransacao com EXCEPTION, portanto o
-- PostgreSQL desfaz o DELETE ao final do bloco. A exclusao real e verificada, fora deste arquivo,
-- em `verify-owner-deletion.sql` (§5 e §7), que e o unico verificador que comita a exclusao.
--
-- Cada assercao abaixo falha se a regressao voltar:
--   (a) o DELETE precisa concluir e remover exatamente 1 linha;
--   (b) os dados pessoais precisam sumir junto (cascata), e o catalogo global precisa ficar;
--   (c) os tombstones do owner precisam sumir (nao ha a quem reconciliar apos a destruicao);
--   (d) a transacao precisa desfazer TUDO: contagem e conteudo.
--
-- Por que BEGIN/ROLLBACK alem do bloco com EXCEPTION: o handler do PL/pgSQL cria um savepoint
-- implicitamente, mas esse savepoint SO desfaz o que foi feito dentro do bloco `BEGIN ... EXCEPTION
-- ... END` que o contem — e o DELETE exitoso nao passa por ele. Sem a transacao externa, a exclusao
-- COMITARIA e o banco ficaria sem owner, quebrando §4.
BEGIN;
DO $$
DECLARE
  removidas bigint := 0;
  err_state text;
  err_message text;
  doc_now jsonb;
  doc_base jsonb;
  restantes bigint;
BEGIN
  BEGIN
    DELETE FROM nexus.owner_identity WHERE id = '00000000-0000-4000-8000-000000000004';
    GET DIAGNOSTICS removidas = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err_state = RETURNED_SQLSTATE, err_message = MESSAGE_TEXT;
  END;

  -- (a) O DELETE precisa ter sido executado, e nao meramente nao ter dado erro.
  IF err_state IS NOT NULL THEN
    RAISE EXCEPTION
      'Owner deletion FAILED with data present (SQLSTATE %: %). Migration 00008 is missing or was reverted: the owner-existence guard in nexus.record_deleted_entity() is what makes this work.',
      err_state, err_message;
  END IF;
  IF removidas <> 1 THEN
    RAISE EXCEPTION 'Owner deletion affected % row(s) instead of exactly 1', removidas;
  END IF;

  -- (b) e (c) Estado imediatamente apos a exclusao, dentro da mesma subtransacao.
  SELECT count(*) INTO restantes FROM nexus.owner_identity;
  IF restantes <> 0 THEN
    RAISE EXCEPTION 'Owner row survived the deletion (% rows)', restantes;
  END IF;

  SELECT count(*) INTO restantes FROM nexus.messages;
  IF restantes <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % message(s) behind', restantes;
  END IF;
  SELECT count(*) INTO restantes FROM nexus.conversations;
  IF restantes <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % conversation(s) behind', restantes;
  END IF;
  SELECT count(*) INTO restantes FROM nexus.assistant_memories;
  IF restantes <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % assistant memory(ies) behind', restantes;
  END IF;
  SELECT count(*) INTO restantes FROM nexus.tombstones;
  IF restantes <> 0 THEN
    RAISE EXCEPTION 'Owner deletion left % tombstone(s) behind', restantes;
  END IF;

  -- O catalogo GLOBAL nao pertence ao owner e nao pode ser tocado pela cascata. O baseline deste
  -- arquivo nao guarda a contagem de assistentes, entao ela e conferida contra a seed das
  -- migrations (00005/00006 inserem 4 assistentes e nao existe caminho que as remova).
  SELECT count(*) INTO restantes FROM nexus.assistants;
  IF restantes <> 4 THEN
    RAISE EXCEPTION 'Owner deletion changed the GLOBAL assistant catalog (found % assistants, expected 4)', restantes;
  END IF;

  RAISE NOTICE 'Owner deletion succeeded inside the transaction: % row removed, no owner data left', removidas;
END
$$;
ROLLBACK;

-- --- (d) A transacao desfez a tentativa?  CONTAGEM e CONTEUDO -------------------------------
-- Esta verificacao PRECISA ficar fora da transacao: dentro dela o estado reflete a exclusao, nao o
-- estado restaurado. Verificar "o owner voltou" antes do ROLLBACK mediria a coisa errada.
DO $pos3$
DECLARE
  doc_now jsonb;
  doc_base jsonb;
  restantes bigint;
BEGIN
  SELECT count(*) INTO restantes FROM nexus.owner_identity;
  IF restantes <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK failed: expected 1 owner after the reverted deletion, found %', restantes;
  END IF;

  SELECT jsonb_agg(to_jsonb(t) - 'sequence' ORDER BY (to_jsonb(t) - 'sequence')::text) INTO doc_now FROM nexus.tombstones t;
  SELECT tombstones_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'ROLLBACK did not restore tombstones content. Before: %  After: %', doc_base, doc_now;
  END IF;

  SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) INTO doc_now FROM nexus.messages m;
  SELECT messages_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'ROLLBACK did not restore messages content';
  END IF;

  SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) INTO doc_now FROM nexus.conversations c;
  SELECT conversations_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'ROLLBACK did not restore conversations content';
  END IF;

  SELECT jsonb_agg(to_jsonb(mem) ORDER BY to_jsonb(mem)::text) INTO doc_now FROM nexus.assistant_memories mem;
  SELECT memories_doc INTO doc_base FROM pg_temp.verify_baseline;
  IF doc_now IS DISTINCT FROM doc_base THEN
    RAISE EXCEPTION 'ROLLBACK did not restore assistant_memories content';
  END IF;

  RAISE NOTICE '§3 OK: deletion works with data present (00008) and ROLLBACK restored everything';
END
$pos3$;


-- =============================================================================================
-- §4. A CASCATA DAS TABELAS DA FASE 5, com as tres tabelas de tombstone VAZIAS
-- =============================================================================================
-- A limpeza abaixo esvazia as tres tabelas com trigger de tombstone. Ela deixou de ser um
-- "contorno" necessario: desde a 00008 a exclusao do owner funciona com dados presentes, e §3
-- prova isso. O que §4 isola e o efeito da cascata sobre `tool_grants`, `tool_grant_audit` e
-- `user_assistant_preferences` quando NENHUM trigger de tombstone entra em jogo — assim, se §4
-- falhar, a causa e a cascata da Fase 5, e nao o mecanismo de tombstone.
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

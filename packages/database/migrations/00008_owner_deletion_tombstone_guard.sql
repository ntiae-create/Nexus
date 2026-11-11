-- Etapa 3C.4, Fase 5 (G13): correcao do DEFEITO DO OWNER — exclusao definitiva da instalacao.
--
-- =============================================================================
-- O DEFEITO
-- =============================================================================
-- `DELETE FROM nexus.owner_identity` falhava com SQLSTATE 42501:
--
--     ERROR:  new row violates row-level security policy for table "tombstones"
--     CONTEXT: SQL statement "INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)
--                VALUES (OLD.id, OLD.owner_id, deleted_type, OLD.id) ON CONFLICT DO NOTHING"
--              PL/pgSQL function nexus.record_deleted_entity() line 6 at SQL statement
--
-- A instalacao ficava permanentemente nao-excluivel. Nenhum dado pessoal podia ser apagado:
-- a operacao falhava por inteiro e a linha de `owner_identity` sobrevivia.
--
-- =============================================================================
-- A CAUSA (medida, nao suposta)
-- =============================================================================
-- `nexus.record_deleted_entity()` e SECURITY DEFINER, mas o dono da funcao e `nexus_migrator`,
-- que tem `rolbypassrls = false`. SECURITY DEFINER NAO contorna FORCE ROW LEVEL SECURITY: a
-- policy de INSERT de `tombstones` e avaliada contra o papel da funcao, e o bypass nao existe.
--
-- A policy exige tres condicoes:
--
--     owner_id = nexus.current_owner_id()          -- verdadeira: o GUC continua no contexto
--     AND owner_id = nexus.configured_owner_id()  -- FALSA
--     AND nexus.current_actor_type() = 'owner'
--     AND pg_trigger_depth() > 0
--
-- `configured_owner_id()` faz `SELECT owner.id FROM nexus.owner_identity WHERE singleton`. As
-- FKs com ON DELETE CASCADE das tabelas com trigger de tombstone sao acionadas DEPOIS que a
-- linha de `owner_identity` ja foi removida. Naquele instante a funcao retorna NULL, a policy
-- avalia NULL, e o INSERT e recusado.
--
-- O 23503 (violacao de FK) que a documentacao descrevia e INALCANCAVEL: a RLS barra antes de a
-- constraint `tombstones_owner_id_fkey` ser verificada. O SQLSTATE observado e sempre 42501.
--
-- =============================================================================
-- POR QUE A CORRECAO E UM GUARD NO TRIGGER, E NAO UMA POLICY OU UM PAPEL NOVO
-- =============================================================================
-- As tres alternativas foram descartadas por motivo concreto:
--
--   1. CRIAR UM PAPEL EXECUTOR COM BYPASSRLS.
--      Proibido pelas regras da fase e innecesario. `BYPASSRLS` desliga RLS em TODAS as tabelas
--      para aquele papel — privilegio amplo demais para resolver um INSERT condicional.
--
--   2. AMPLIAR A POLICY DE INSERT DE `tombstones` (por exemplo, aceitar `configured_owner_id()
--      IS NULL`).
--      Transformaria "o owner configurado nao existe" em autorizacao. Qualquer sessao em que a
--      linha de `owner_identity` estivesse ausente poderia gravar tombstones de qualquer
--      `owner_id`. E uma excecao generica, exatamente o que a fase proibe.
--
--   3. DESLIGAR O TRIGGER DE TOMBSTONE DURANTE A EXCLUSAO.
--      Exigiria `ALTER TABLE ... DISABLE TRIGGER`, que e DDL e nao se aplica de dentro de uma
--      funcao sem que o chamador tenha o privilegio de dono da tabela. Alem disso tratar a
--      exclusao como caso especial esconderia a incoerencia em vez de corrigi-la.
--
-- O guard ARQUITETURAL e outro: um tombstone registra a exclusao de uma entidade PARA QUE a
-- ausencia dela seja reconciliada em outro dispositivo do MESMO owner. Se o owner deixou de
-- existir, nao ha dispositivo algum a reconciliar e nao ha a quem atribuir o tombstone. O FK
-- `tombstones_owner_id_fkey` ja declara essa invariante; o trigger e que a violava, tentando
-- gravar um tombstone de um owner que a propria transacao acabou de apagar.
--
-- Portanto o guard nao e uma excecao de seguranca: e a mesma condicao de existencia do
-- `INSERT`. A policy permanece exatamente como estava, e continua exigindo contexto coerente,
-- actor `owner` e profundidade de trigger > 0.
--
-- =============================================================================
-- O QUE MUDA
-- =============================================================================
-- `nexus.record_deleted_entity()` ganha uma unica condicao antes do INSERT:
--
--     IF NOT EXISTS (SELECT 1 FROM nexus.owner_identity WHERE id = OLD.owner_id) THEN
--       RETURN OLD;
--     END IF;
--
-- Consequencias, todas deliberadas:
--
--   * A funcao continua SECURITY DEFINER e continua pertencendo a `nexus_migrator`. Nenhum
--     `GRANT`, nenhum papel novo, nenhum atributo de papel alterado.
--   * Nenhuma policy e criada, removida ou alterada. Nenhum RLS e desligado.
--   * Exclusao de UMA conversa/mensagem/memoria de um owner que existe continua gerando
--     tombstone normalmente: o guard so dispara quando o owner ja nao existe.
--   * `ON DELETE CASCADE`, `RESTRICT` e `NO ACTION` permanecem intactos. A exclusao do owner
--     continua sendo recusada se qualquer referencia `RESTRICT` sobrar — o guard nao enfraquece
--     integridade referencial.
--   * A operacao e atomica por construcao: e um unico DELETE. Se qualquer etapa falhar, a
--     transacao inteira e revertida e o owner continua presente.
--
-- =============================================================================
-- SEMANTICA DA EXCLUSAO DEFINITIVA (o que este arquivo NAO decide)
-- =============================================================================
-- Depois desta migration, `DELETE FROM nexus.owner_identity` apaga, por cascata:
--
--   conversas, mensagens, core_runs, run_steps, run_results, tool_events,
--   assistant_memories, memory_permissions, memory_permission_audit,
--   conversation_assistants, provider_authorizations, sync_cursors,
--   global_provider_preferences, assistant_provider_preferences,
--   conversation_provider_preferences, tombstones, tool_grants,
--   tool_grant_audit, user_assistant_preferences
--
-- e preserva o catalogo GLOBAL (assistentes, versoes de configuracao, providers, models), que
-- nao pertence ao owner.
--
-- A retencao de `tool_grant_audit` e uma DECISAO DE PRODUTO ainda nao tomada: hoje a cascata a
-- apaga junto (ver docs/FASE_5_G13_CATALOGO_GLOBAL_CONFIGURACOES_PESSOAIS.md e o diagnostico
-- documental). Esta migration nao a altera — mudar a acao da FK seria escopo diferente e
-- exigiria definir antes POR QUANTO TEMPO e PARA QUEM uma trilha de auditoria sobrevive a
-- destruicao da instalacao.
--
-- Aplicar como dono do schema (`nexus_migrator`), dentro da transacao da migration.
BEGIN;

CREATE OR REPLACE FUNCTION nexus.record_deleted_entity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deleted_type nexus.tombstone_entity_type;
BEGIN
  deleted_type := TG_ARGV[0]::nexus.tombstone_entity_type;

  -- Guard de existencia do owner. Um tombstone so tem sentido enquanto existir um owner a
  -- quem a exclusao pertence e um dispositivo a reconciliar. Quando a exclusao em curso e a
  -- DA PROPRIA INSTALACAO, a linha de `owner_identity` ja foi removida pelas FKs em cascata e
  -- nao existe destino valido para `tombstones_owner_id_fkey`.
  --
  -- A consulta roda com os privilegios do dono da funcao (SECURITY DEFINER) mas NAO contorna
  -- RLS: `owner_identity` e a unica tabela de `nexus` sem RLS (o singleton precisa ser legivel
  -- por `configured_owner_id()`, que e chamada de dentro de policies). A leitura aqui e
  -- portanto sempre permitida e sempre avalia a existencia real da linha.
  IF NOT EXISTS (SELECT 1 FROM nexus.owner_identity WHERE id = OLD.owner_id) THEN
    RETURN OLD;
  END IF;

  INSERT INTO nexus.tombstones (id, owner_id, entity_type, entity_id)
  VALUES (OLD.id, OLD.owner_id, deleted_type, OLD.id)
  ON CONFLICT (entity_type, entity_id) DO NOTHING;
  RETURN OLD;
END
$function$;

COMMIT;

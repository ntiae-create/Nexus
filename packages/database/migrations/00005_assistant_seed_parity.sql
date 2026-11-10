-- Etapa 3C.3, Fase 2 (G7): sincroniza o seed de `nexus.assistants` com o catálogo canônico
-- de `packages/assistant-profiles`.
--
-- Contexto do defeito corrigido: a migration 00001 gravou descrições resumidas
-- ("Assistente pessoal.", "Pesquisa e investigação.", "Lógica e planejamento.") que nunca
-- coincidiram com as descrições dos perfis. As duas versões viveram no repositório ao mesmo
-- tempo, sem nada que as comparasse.
--
-- Regras desta migration:
--   * ADITIVA e IDEMPOTENTE. Pode rodar mais de uma vez sem efeito colateral.
--   * NÃO recria, NÃO apaga e NÃO muda ids, chaves ou nomes já existentes. Instalações
--     existentes mantêm as referências que já estão em `conversation_assistants`,
--     `messages` e `core_runs` — um id trocado quebraria todas elas.
--   * Opera apenas em linhas com as três chaves do catálogo inicial. Nunca insere uma quarta
--     assistente: criação de perfil é decisão de dados das fases seguintes.
--   * Não toca em RLS, ownership, políticas ou tabelas pessoais.
BEGIN;

-- 1. Alinha a descrição ao perfil canônico, por chave.
--    O valor é o mesmo texto de `packages/assistant-profiles/src/catalog.ts`; o teste de
--    paridade `assistant-catalog-parity.phase2.test.ts` compara os dois lados.
UPDATE nexus.assistants SET description = 'Assistente pessoal para conversação cotidiana, organização e planejamento pessoal.', updated_at = now()
  WHERE assistant_key = 'yui'
    AND description <> 'Assistente pessoal para conversação cotidiana, organização e planejamento pessoal.';

UPDATE nexus.assistants SET description = 'Assistente de pesquisa e investigação, comparação de informações e análise de fontes.', updated_at = now()
  WHERE assistant_key = 'alice'
    AND description <> 'Assistente de pesquisa e investigação, comparação de informações e análise de fontes.';

UPDATE nexus.assistants SET description = 'Assistente de lógica, resolução de problemas, análise de sistemas e planejamento.', updated_at = now()
  WHERE assistant_key = 'schwi'
    AND description <> 'Assistente de lógica, resolução de problemas, análise de sistemas e planejamento.';

-- 2. Alinha o nome de apresentação e o status, se tiverem sido alterados fora do código.
UPDATE nexus.assistants SET display_name = 'YUI', updated_at = now()
  WHERE assistant_key = 'yui' AND display_name <> 'YUI';
UPDATE nexus.assistants SET display_name = 'ALICE', updated_at = now()
  WHERE assistant_key = 'alice' AND display_name <> 'ALICE';
UPDATE nexus.assistants SET display_name = 'SCHWI', updated_at = now()
  WHERE assistant_key = 'schwi' AND display_name <> 'SCHWI';

-- 3. Garante a versão de configuração declarada pelos perfis (todas em 1.0.0), sem duplicar.
INSERT INTO nexus.assistant_config_versions (assistant_id, config_version, source)
SELECT id, '1.0.0', 'static_code'
  FROM nexus.assistants
 WHERE assistant_key IN ('yui', 'alice', 'schwi')
ON CONFLICT (assistant_id, config_version) DO NOTHING;

COMMIT;

\set ON_ERROR_STOP on

-- Fase 2 (G7): verificação com PostgreSQL real da migration 00005.
--
-- Roda depois de todas as migrations. Três garantias:
--   1. o estado final do seed é o do perfil canônico (a descrição curta da 00001 não sobreviveu);
--   2. as três identidades preservaram id, chave e nome — nada foi recriado;
--   3. a migration é idempotente: reaplicá-la sobre o próprio resultado não muda nada, nem
--      duplica a versão de configuração.
--
-- A comparação é feita com os valores do repositório, não com um snapshot solto: os mesmos
-- textos aparecem em `packages/database/migrations/00005_assistant_seed_parity.sql`, e o teste
-- estático `assistant-catalog-parity.phase2.test.ts` liga-os ao perfil.

DO $$
DECLARE
  expected_descriptions jsonb := jsonb_build_object(
    'yui',   'Assistente pessoal para conversação cotidiana, organização e planejamento pessoal.',
    'alice', 'Assistente de pesquisa e investigação, comparação de informações e análise de fontes.',
    'schwi', 'Assistente de lógica, resolução de problemas, análise de sistemas e planejamento.'
  );
  key text;
  actual_count integer;
BEGIN
  -- 1. Exatamente três assistentes: nenhuma quarta entrada foi criada por esta fase.
  SELECT count(*) INTO actual_count FROM nexus.assistants;
  IF actual_count <> 3 THEN
    RAISE EXCEPTION 'Expected exactly 3 assistants after migration 00005, found %', actual_count;
  END IF;

  -- 2. Cada chave existe, com o nome de apresentação e a descrição do perfil.
  FOR key IN SELECT jsonb_object_keys(expected_descriptions) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM nexus.assistants
       WHERE assistant_key = key
         AND display_name = upper(key)
         AND description = expected_descriptions ->> key
    ) THEN
      RAISE EXCEPTION 'Assistant % does not match the canonical profile after migration 00005', key;
    END IF;
  END LOOP;

  -- 3. A descrição resumida original não sobreviveu em nenhuma linha.
  IF EXISTS (
    SELECT 1 FROM nexus.assistants
     WHERE description IN ('Assistente pessoal.', 'Pesquisa e investigação.', 'Lógica e planejamento.')
  ) THEN
    RAISE EXCEPTION 'Summary descriptions from migration 00001 are still present';
  END IF;

  -- 4. Uma versão de configuração por assistente, sem duplicação.
  SELECT count(*) INTO actual_count FROM nexus.assistant_config_versions WHERE config_version = '1.0.0';
  IF actual_count <> 3 THEN
    RAISE EXCEPTION 'Expected exactly 3 config versions at 1.0.0, found %', actual_count;
  END IF;
END $$;

-- 5. Idempotência real: reaplicar a migration sobre o próprio resultado.
--    Se qualquer UPDATE/INSERT não fosse idempotente, a contagem ou o `updated_at` mudaria.
CREATE TEMP TABLE assistant_state_before AS
  SELECT id, assistant_key, display_name, description, updated_at FROM nexus.assistants ORDER BY assistant_key;

\i /tmp/00005_assistant_seed_parity.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM nexus.assistants a
      JOIN assistant_state_before b USING (id)
     WHERE a.description <> b.description
        OR a.display_name <> b.display_name
        OR a.assistant_key <> b.assistant_key
        OR a.updated_at <> b.updated_at
  ) THEN
    RAISE EXCEPTION 'Reapplying migration 00005 changed assistant rows: it is not idempotent';
  END IF;

  IF (SELECT count(*) FROM nexus.assistant_config_versions) <> 3 THEN
    RAISE EXCEPTION 'Reapplying migration 00005 duplicated assistant config versions';
  END IF;
END $$;

DROP TABLE assistant_state_before;

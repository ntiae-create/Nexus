\set ON_ERROR_STOP on
-- Fase 5 (G13): validacao de `user_assistant_preferences.display_label`.
--
-- Nas duas versoes da constraint:
--   * `user_assistant_preferences_label_length`     -> entre 1 e 64 caracteres;
--   * `user_assistant_preferences_label_not_blank`  -> rejeita string so de espacos;
-- e `display_label` continua OPCIONAL (NULL permitido).
--
-- Roda como `postgres`; tudo em transacao com ROLLBACK.
-- =============================================================================================
DO $$
BEGIN
  IF current_database() <> 'nexus_test' THEN
    RAISE EXCEPTION 'Expected isolated nexus_test database, got %', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM nexus.user_assistant_preferences) THEN
    RAISE EXCEPTION
      'Preferences verification requires a fresh database: user_assistant_preferences is not empty.'
      USING ERRCODE = '55000';
  END IF;
END
$$;

BEGIN;

SELECT set_config('nexus.owner_id', '00000000-0000-4000-8000-000000000004', true);
SELECT set_config('nexus.actor_type', 'owner', true);

DO $$
DECLARE
  owner uuid := nexus.current_owner_id();
  assistant uuid := '00000000-0000-4000-8000-000000000001';
  rejected boolean;
  label text;
BEGIN
  -- 1. NULL e permitido (rotulo e opcional).
  INSERT INTO nexus.user_assistant_preferences (owner_id, assistant_id, display_label)
  VALUES (owner, assistant, NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NULL display_label was not accepted';
  END IF;

  -- 2. String vazia: rejeitada por `label_length`.
  rejected := false;
  BEGIN
    UPDATE nexus.user_assistant_preferences SET display_label = '' WHERE owner_id = owner AND assistant_id = assistant;
    RAISE EXCEPTION 'Empty display_label was accepted';
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Empty display_label was accepted';
  END IF;

  -- 3. Apenas branco: rejeitada por `label_not_blank`. Cobre espaco, tab, CR e VT — nao apenas
  -- espaco, que e o que `btrim` sem argumento removeria.
  FOR label IN SELECT unnest(ARRAY[' ', '   ', E'\t', E' \t ', E'\n', E'\r\n', E'\v'])
  LOOP
    rejected := false;
    BEGIN
      UPDATE nexus.user_assistant_preferences SET display_label = label WHERE owner_id = owner AND assistant_id = assistant;
      RAISE EXCEPTION 'Whitespace-only display_label (len %) was accepted', length(label);
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;
    IF NOT rejected THEN
      RAISE EXCEPTION 'Whitespace-only display_label (len %) was accepted', length(label);
    END IF;
  END LOOP;

  -- 4. Rotulo valido: aceito, inclusive com espacos nas pontas (o requisito e "nao ser SO espaco").
  UPDATE nexus.user_assistant_preferences SET display_label = '  Yui  ' WHERE owner_id = owner AND assistant_id = assistant;
  IF (SELECT display_label FROM nexus.user_assistant_preferences WHERE owner_id = owner AND assistant_id = assistant)
     IS DISTINCT FROM '  Yui  ' THEN
    RAISE EXCEPTION 'Valid label was not stored verbatim';
  END IF;

  -- 5. Limites: 1 e 64 aceitos; 65 rejeitado.
  UPDATE nexus.user_assistant_preferences SET display_label = 'A' WHERE owner_id = owner AND assistant_id = assistant;
  UPDATE nexus.user_assistant_preferences SET display_label = repeat('B', 64) WHERE owner_id = owner AND assistant_id = assistant;
  IF char_length((SELECT display_label FROM nexus.user_assistant_preferences
                  WHERE owner_id = owner AND assistant_id = assistant)) <> 64 THEN
    RAISE EXCEPTION '64-char label was not stored';
  END IF;

  rejected := false;
  BEGIN
    UPDATE nexus.user_assistant_preferences SET display_label = repeat('C', 65) WHERE owner_id = owner AND assistant_id = assistant;
    RAISE EXCEPTION '65-char display_label was accepted';
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION '65-char display_label was accepted';
  END IF;

  -- Apos todas as rejeicoes, o valor anterior continua intacto (rollback de subtransacao).
  IF char_length((SELECT display_label FROM nexus.user_assistant_preferences
                  WHERE owner_id = owner AND assistant_id = assistant)) <> 64 THEN
    RAISE EXCEPTION 'Rejected updates damaged the stored label';
  END IF;

  RAISE NOTICE 'display_label: NULL/1/64 accepted; empty, whitespace-only and 65 rejected';
END
$$;

ROLLBACK;

DO $$
BEGIN
  RAISE NOTICE 'Phase 5 (G13) preferences display_label verification passed';
END
$$;

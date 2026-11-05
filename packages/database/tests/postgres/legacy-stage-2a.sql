\set ON_ERROR_STOP on

-- Fixtures written against the 00001 + 00002 schema, before 00003 is applied.
INSERT INTO nexus.conversations (id, owner_id, title, metadata)
VALUES
  (
    '21000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000004',
    'Legacy metadata preference',
    '{"keep":{"legacy":true},"providerPreference":{"mode":"automatic"}}'
  ),
  (
    '21000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000004',
    'Legacy canonical preference wins',
    '{"keep":"second","providerPreference":{"mode":"automatic"}}'
  );

INSERT INTO nexus.messages (
  id, owner_id, conversation_id, sequence, role, status, content, format_version
) VALUES (
  '31000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004',
  '21000000-0000-4000-8000-000000000001',
  0,
  'user',
  'complete',
  '[{"type":"text","text":"Legacy message"}]',
  1
);

INSERT INTO nexus.core_runs (
  id, owner_id, conversation_id, request_id, idempotency_key, status,
  input_message_id, trace, format_version, started_at
) VALUES (
  '90100000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004',
  '21000000-0000-4000-8000-000000000001',
  '91100000-0000-4000-8000-000000000001',
  'legacy-run',
  'running',
  '31000000-0000-4000-8000-000000000001',
  '[{"assistantId":"00000000-0000-4000-8000-000000000001","assistantKey":"yui","configVersion":"1.0.0"}]',
  1,
  now()
);

INSERT INTO nexus.run_steps (
  id, owner_id, run_id, step_order, assistant_id, assistant_config_version, status, objective
) VALUES (
  '92100000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004',
  '90100000-0000-4000-8000-000000000001',
  0,
  '00000000-0000-4000-8000-000000000002',
  '1.0.0',
  'succeeded',
  'Legacy step'
);

INSERT INTO nexus.run_results (
  id, owner_id, run_id, step_id, status, content, format_version
) VALUES (
  '93100000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000004',
  '90100000-0000-4000-8000-000000000001',
  '92100000-0000-4000-8000-000000000001',
  'succeeded',
  '[]',
  1
);

INSERT INTO nexus.providers (
  id, provider_key, display_name, availability, cost_status
) VALUES (
  '50100000-0000-4000-8000-000000000001',
  'legacy-free',
  'Legacy Free',
  'available',
  'free_confirmed'
);
INSERT INTO nexus.models (id, provider_id, model_key, display_name, availability)
VALUES (
  '60100000-0000-4000-8000-000000000001',
  '50100000-0000-4000-8000-000000000001',
  'legacy-model',
  'Legacy Model',
  'available'
);
INSERT INTO nexus.provider_authorizations (
  owner_id, provider_id, authorized, authorized_at
) VALUES (
  '00000000-0000-4000-8000-000000000004',
  '50100000-0000-4000-8000-000000000001',
  true,
  now()
);
INSERT INTO nexus.conversation_provider_preferences (
  owner_id, conversation_id, selection_mode, provider_id, model_id
) VALUES (
  '00000000-0000-4000-8000-000000000004',
  '21000000-0000-4000-8000-000000000002',
  'manual',
  '50100000-0000-4000-8000-000000000001',
  '60100000-0000-4000-8000-000000000001'
);

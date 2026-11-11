-- Etapa 3C.3, Fase 4: registra a quarta assistente oficial, VIVY, no seed de `nexus.assistants`.
--
-- Por que uma migration nova em vez de editar a 00001:
--   * 00001–00005 já foram aplicadas em instalações existentes. Reescrever uma delas não muda o
--     banco que já rodou; só faz os dois lados divergirem. Aqui a regra é a mesma da 00005: nova
--     versão, nunca reescrita de uma já publicada.
--   * A verificação de paridade (`assistant-catalog-parity.phase2.test.ts`) lê todas as migrations
--     em ordem e compara o estado resultante com o catálogo canônico. Sem esta migration, o
--     catálogo com quatro perfis e o seed com três divergiriam — e o teste falharia, que é o
--     comportamento desejado.
--
-- Regras desta migration:
--   * ADITIVA e IDEMPOTENTE. `ON CONFLICT DO NOTHING` nas duas inserções: reaplicar não tem efeito.
--   * NÃO altera registros existentes. YUI, ALICE e SCHWI mantêm id, chave, nome, descrição e
--     status exatamente como estão — qualquer instalação que tenha referências a elas em
--     `conversation_assistants`, `messages` ou `core_runs` continua válida.
--   * NÃO toca em RLS, ownership ou tabelas pessoais.
--   * Não cria nenhuma capability de ferramenta: a Fase 4 é explicitamente "somente chat".
BEGIN;

-- `ON CONFLICT DO NOTHING` sem alvo, de propósito: a forma com coluna entre parênteses introduz um
-- grupo de parênteses em seguida ao VALUES, e o leitor de seed da paridade da Fase 2 interpreta
-- grupos de parênteses nessa região como linhas de valores. Sem alvo é equivalente aqui, porque a
-- única violação possível é a da chave única de `assistant_key`.
INSERT INTO nexus.assistants (id, assistant_key, display_name, description, status)
VALUES (
  '00000000-0000-4000-8000-000000000004',
  'vivy',
  'VIVY',
  'Assistente de engenharia de software e criação visual: desenvolvimento, arquitetura, depuração, design de interfaces e sistemas visuais.',
  'active'
)
ON CONFLICT DO NOTHING;

-- A versão de configuração acompanha o perfil canônico (`configVersion: "1.0.0"`). A chave
-- composta (assistant_id, config_version) já é a garantia de idempotência.
INSERT INTO nexus.assistant_config_versions (assistant_id, config_version, source)
VALUES ('00000000-0000-4000-8000-000000000004', '1.0.0', 'static_code')
ON CONFLICT (assistant_id, config_version) DO NOTHING;

COMMIT;

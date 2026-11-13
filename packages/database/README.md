# Persistência do NEXUS

Este pacote contém o esquema SQL oficial do PostgreSQL, contratos TypeScript, a implementação concreta com `pg`, repositórios tipados e testes.

## Modelo de proprietário único

O NEXUS é SINGLE-USER: uma única identidade proprietária, sem cadastro público ou criação de outras contas. `owner_identity` é uma tabela singleton sem email ou credenciais. As tabelas de dados conservam `owner_id` como âncora de integridade à identidade e para políticas RLS, não como particionamento multiusuário.

Nos contratos de `@nexus/shared`, o nome `userId` continua sendo o UUID do proprietário para preservar o formato compartilhado. Ele não permite selecionar outra conta; os contratos deste pacote expõem esse valor como `ownerId` e a coluna SQL usa `owner_id`.

A presença de `owner_identity` e de contexto RLS **não implementa autenticação**. O backend deve autenticar o proprietário, validar e autorizar cada operação. Aplicativos não recebem credenciais PostgreSQL e não acessam o banco diretamente. Não existe fluxo de cadastro público. Chaves e credenciais de provedores ficam exclusivamente no servidor, fora deste esquema.

## Camada concreta PostgreSQL

A implementação vive em `src/postgres/`:

- `createPostgresDatabase(options)` — factory do handle de banco.
- `createTrustedOwnerContext(ownerId, actor)` — **somente** para código confiável do backend. Não construir contexto a partir de input de cliente; Zod/TypeScript não são autenticação.
- `withOwnerTransaction(context, operation)` — abre transação, define RLS com `set_config(..., true)` e entrega **apenas** `NexusRepositories` tipados ao callback.

### Fronteira de confiança

- Callbacks de negócio **não** recebem `Pool`, `PoolClient` nem método `query`.
- SQL arbitrário a partir da aplicação é estruturalmente impossível: só a camada interna de repositórios executa SQL fixo e parametrizado.
- O contexto RLS (`nexus.owner_id`, `nexus.actor_type`, `nexus.assistant_id`) é definido **exclusivamente** pelo runner de transação. Nenhum callback pode alterá-lo.
- `Pool` não é exposto na API pública do handle; só `withOwnerTransaction` e `close()`.

### Repositórios implementados

| Repositório | Status |
|---|---|
| `owner` | completo |
| `conversations` | completo — assistentes e preferência de conversa recuperados da tabela canônica |
| `messages` | completo — autoria explícita, idempotência por conversa, sequência serializada e histórico ordenado |
| `executions` | completo — criar, atualizar, concluir, falhar e recuperar participantes, trace, passos, eventos e resultados |
| `memories` | completo (listOwned, listForCurrentAssistant, delete, grant, revoke, listPermissionAudit) |
| `providerPreferences` | completo — escopos global/assistente/conversa, precedência e escritas atômicas por escopo |
| `sync` | **não implementado** — protocolo de cursor/tombstone não finalizado; `pullIncremental` lança erro explícito |

Quando uma funcionalidade depende de decisão de produto ou nova migração, o método documenta e falha de forma explícita em vez de retornar dados vazios silenciosos.

### Invariantes da Etapa 2B

- `messages.append` grava somente autoria de usuário; `appendAssistant` é a operação confiável separada para respostas de assistentes. Um `assistantId` enviado à operação de usuário é rejeitado.
- Toda escrita de mensagem bloqueia a conversa antes de calcular a próxima sequência. `(conversation_id, idempotency_key)` é único; reenvios idênticos retornam a mensagem original e reutilização da chave com payload diferente falha.
- `core_run_assistants` preserva a ordem de `assistantIds`; `trace`, timestamps, mensagem final e vínculos de resultados são persistidos e lidos de volta. Execuções terminais são imutáveis.
- Preferências de conversa ficam exclusivamente em `conversation_provider_preferences`, nunca em `conversations.metadata`. Setters por escopo usam upsert e lock transacional comum; `resolve` aplica conversa → assistente → global, inclusive quando a escolha mais específica é `automatic`.

## Migrações

As migrações SQL sequenciais ficam em `migrations/`. Migrações versionadas são imutáveis, inclusive `00001_initial_schema.sql` e `00002_auth_security.sql`; mudanças futuras devem ser novas migrações. A `00003_persistence_integrity.sql` é aditiva e migra os dados legados disponíveis.

**Recomendação para a futura ferramenta:** `postgres-migrations`. Não rodar migrações automaticamente no boot do backend.

## RLS e modelo de confiança

As políticas usam contexto PostgreSQL local à transação: `nexus.owner_id`, `nexus.actor_type` (`owner` ou `assistant`) e `nexus.assistant_id` quando o ator for um assistente. O terceiro argumento `true` de `set_config` torna o valor local à transação; nunca configurar variáveis em escopo de sessão num pool compartilhado.

RLS é defesa em profundidade, não substitui autenticação, autorização ou validação no backend. O backend deve executar com role sem `SUPERUSER`, `BYPASSRLS` ou propriedade das tabelas. A role que pode executar SQL pode definir as variáveis de contexto; portanto esta configuração **não protege contra SQL arbitrário usando a própria credencial confiável do backend**. Proteja a credencial, restrinja rede e privilégios, e nunca permita acesso direto do APK ou navegador ao banco.

O ator `assistant` só pode ler sua memória individual e itens compartilhados com permissão ativa concedida pelo proprietário. Conceder ou revogar atualiza `memory_permissions` em transação; gatilhos registram a alteração em `memory_permission_audit`.

## Testes

- **Unitários (mocks):** `src/postgres/transaction.test.ts` — impossibilidade de SQL arbitrário no callback, impossibilidade de alterar ator RLS, rollback, destroy on rollback failure.
- **Integração (PostgreSQL real):** `src/postgres/pool.integration.test.ts` e `src/postgres/repositories.integration.test.ts` — exigem `NEXUS_DATABASE_URL`; cobrem pool, rollback, RLS, mensagens concorrentes/idempotentes, execuções completas e preferências. Pulados automaticamente sem a variável somente em execuções locais comuns.
- **Workflow obrigatório:** `.github/workflows/database-postgres.yml` aplica todas as migrations em PostgreSQL 17 e executa os testes SQL, dos repositórios e do auth store com a variável de conexão configurada; portanto esses testes não são pulados no CI.
- **SQL de integração e upgrade:** `tests/postgres/` + `scripts/test-postgres-integration.sh` (CI com PostgreSQL 17). O script insere dados no schema 2A antes da `00003` e comprova o backfill de mensagens, execuções e preferências após a migração.
- Testes estáticos de migração em `src/migrations.test.ts` **não** substituem execução real no PostgreSQL.

## TLS com CA privada

Os pools de dados e autenticação aceitam configuração TLS privada por ambiente:

- `NEXUS_DATABASE_SSL_CA`: certificado ou bundle de CAs em PEM.
- `NEXUS_DATABASE_SSL_SERVERNAME`: hostname esperado no certificado.

As variáveis devem estar definidas juntas e não podem estar vazias. O CA precisa
ser um PEM estruturalmente válido contendo certificados de CA; configuração
incompleta ou inválida falha ao criar o pool. Com o par configurado, o driver usa
`ca`, o `servername` informado e `rejectUnauthorized: true`. Sem o par, mantém-se
o comportamento atual: URLs remotas exigem TLS e validação de hostname por
`sslmode=verify-full`.

Para uma URL Railway via TCP público, mantenha `crossover.proxy.rlwy.net:20087`
como destino da conexão e configure `NEXUS_DATABASE_SSL_SERVERNAME` com
`postgres.railway.internal`. O proxy público é o destino TCP; não o use como
hostname de SNI/verificação do certificado. O conteúdo da CA deve ser fornecido
pelo operador no ambiente runtime; não o grave neste repositório.

## Integração no servidor

`apps/server` usa `createServerDatabase()` quando `NEXUS_DATABASE_URL` está definida, registra `onClose` para drenar o pool e **não** cria rotas públicas artificiais nem autenticação inventada.

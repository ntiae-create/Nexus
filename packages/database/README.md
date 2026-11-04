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
| `conversations` | completo |
| `messages` | completo |
| `executions` | parcial — mapeamento de `assistantIds`/`trace` documentado como limitado pelo schema atual |
| `memories` | completo (listOwned, listForCurrentAssistant, delete, grant, revoke, listPermissionAudit) |
| `providerPreferences` | **não implementado** — tabelas ausentes na migração; métodos lançam erro explícito |
| `sync` | **não implementado** — protocolo de cursor/tombstone não finalizado; `pullIncremental` lança erro explícito |

Quando uma funcionalidade depende de decisão de produto ou nova migração, o método documenta e falha de forma explícita em vez de retornar dados vazios silenciosos.

## Migrações

As migrações SQL sequenciais ficam em `migrations/`. A estrutura ainda não aplicada pode ser ajustada diretamente em `00001_initial_schema.sql`; depois de aplicada, a migração é imutável e mudanças futuras devem ser novas migrações.

**Recomendação para a futura ferramenta:** `postgres-migrations`. Não rodar migrações automaticamente no boot do backend.

## RLS e modelo de confiança

As políticas usam contexto PostgreSQL local à transação: `nexus.owner_id`, `nexus.actor_type` (`owner` ou `assistant`) e `nexus.assistant_id` quando o ator for um assistente. O terceiro argumento `true` de `set_config` torna o valor local à transação; nunca configurar variáveis em escopo de sessão num pool compartilhado.

RLS é defesa em profundidade, não substitui autenticação, autorização ou validação no backend. O backend deve executar com role sem `SUPERUSER`, `BYPASSRLS` ou propriedade das tabelas. A role que pode executar SQL pode definir as variáveis de contexto; portanto esta configuração **não protege contra SQL arbitrário usando a própria credencial confiável do backend**. Proteja a credencial, restrinja rede e privilégios, e nunca permita acesso direto do APK ou navegador ao banco.

O ator `assistant` só pode ler sua memória individual e itens compartilhados com permissão ativa concedida pelo proprietário. Conceder ou revogar atualiza `memory_permissions` em transação; gatilhos registram a alteração em `memory_permission_audit`.

## Testes

- **Unitários (mocks):** `src/postgres/transaction.test.ts` — impossibilidade de SQL arbitrário no callback, impossibilidade de alterar ator RLS, rollback, destroy on rollback failure.
- **Integração (PostgreSQL real):** `src/postgres/pool.integration.test.ts` — exige `NEXUS_DATABASE_URL`; cobre pool max=1, rollback, leitura sob RLS. Pulados automaticamente sem a variável.
- **SQL de integração:** `tests/postgres/` + `scripts/test-postgres-integration.sh` (CI com PostgreSQL 17).
- Testes estáticos de migração em `src/migrations.test.ts` **não** substituem execução real no PostgreSQL.

## Integração no servidor

`apps/server` usa `createServerDatabase()` quando `NEXUS_DATABASE_URL` está definida, registra `onClose` para drenar o pool e **não** cria rotas públicas artificiais nem autenticação inventada.

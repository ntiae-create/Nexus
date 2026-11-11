# Fase 5 — Catálogo Global × Configurações Pessoais (G13)

Especificação técnica. Documento de **auditoria e projeto** — nenhuma linha de código de produção,
migração ou rota foi alterada por este trabalho.

- **Data:** 2026-11-05
- **Base:** `main` @ `1f84f1c` ("Fase 4 — VIVY como quarta assistente oficial (#12)")
- **Referência de escopo:** `docs/PLANO_3C3_ASSISTENTES_EXPANSIVEIS.md` — G13 (l.419), §5.9
  (l.926-960), §6.2 (l.1020-1038), §6.4 (l.1060-1096), Fase 5 (l.1383-1390)
- **Estado:** proposta para aprovação. Nada implementado.

**Convenção de evidência usada em todo o documento**

| Marcador | Significado |
| --- | --- |
| **FATO** | Verificado no código/migração desta árvore, com arquivo e linha. |
| **PROPOSTA** | Desenho recomendado por este documento; sujeito a aprovação. |
| **PENDENTE** | Decisão que depende do usuário ou de uma fase posterior; bloqueia implementação. |

---

## 1. Arquitetura atual (fatos verificados)

### 1.1 Camadas relevantes para G13

```
apps/server (Fastify)                    packages/*
  routes/assistants.ts  ── leitura ──►   assistant-profiles (4 perfis, congelados)
  routes/providers.ts   ── leitura ──►   shared (schemas Zod)
  routes/core.ts        ── chat ─────►   core/engine.ts
        │                                      │
        │  req.session!.ownerId                │ database.withOwnerTransaction
        ▼                                      ▼
  auth/plugin.ts ── token assinado ──►   packages/database (PostgreSQL 17, RLS FORCE)
                                               ▲
  packages/tools (catálogo + policy) ──────────┘   ← NÃO é dependência de ninguém
```

**FATO — `@nexus/tools` não tem consumidor.** `grep -rn "@nexus/tools" --include=package.json`
retorna apenas a própria declaração do pacote (`packages/tools/package.json:2`) e a linha de
`build:packages` na raiz (`package.json:15`). `grep -rn "evaluateToolPolicy"` fora de
`packages/tools` não retorna **nenhum** resultado: `evaluateToolPolicy` nunca é chamado em
produção. O pacote é hoje um componente **isolado e testado apenas por seus próprios testes**
(`packages/tools/src/tools.test.ts`, 9 casos).

**Consequência para a Fase 5:** a "evolução de `evaluateToolPolicy`" não é uma alteração em código
vivo com regressão de comportamento — é a **primeira integração real** desse pacote ao servidor.
Isso reduz o risco de regressão no CORE e concentra o risco em (a) semântica da política e (b) na
fronteira de dados.

### 1.2 Catálogo global de ferramentas — hoje só em memória

**FATO.** O catálogo é um singleton em memória:

- `packages/tools/src/catalog.ts:34` — `export class ToolCatalog` com um `Map<string, AnyToolDefinition>`
  privado; `register` (`:53`) rejeita id duplicado; `list`/`getById`/`requireById`.
- `packages/tools/src/catalog.ts:117` — `export const toolCatalog = new ToolCatalog();`
- `packages/tools/src/examples.ts:123` — `for (const example of examples) toolCatalog.register(...)`,
  ou seja, o catálogo é populado **por efeito de import** do módulo `examples.ts`.
- Definições são congeladas em profundidade: `defineTool` (`catalog.ts:39`) valida por
  `toolDefinitionMetadataSchema` e aplica `freezeDeep` (`:28`).

Há **5** ferramentas registradas (`examples.ts`), todas `availability: "demonstration_only"`,
`demonstrationOnly: true`, `enabledByDefault: false`:

| `tool.id` | categoria | risco | custo | rede | confirmação | assistentes autorizadas |
| --- | --- | --- | --- | --- | --- | --- |
| `research.search` | external_research | medium | unknown | internet | não | `alice` |
| `research.fetch_source` | information_lookup | medium | unknown | internet | não | `alice` |
| `personal.tasks` | task_organization | low | free_confirmed | none | não | `alice` |
| `personal.organize` | personal | low | free_confirmed | none | não | `alice` |
| `technical.code_analysis` | technical_analysis | medium | free_confirmed | none | não | `schwi` |

**FATO — não existe tabela de catálogo no banco.** `grep -n "CREATE TABLE"` sobre as seis
migrações retorna 24 tabelas e **nenhuma** delas é `tool_definitions` ou
`assistant_capabilities`. As duas constam do plano (§6.2, l.1025-1026) como **propostas**.

### 1.3 Perfis de assistente (a "camada de perfil" da interseção)

**FATO.** `packages/assistant-profiles/src/catalog.ts` declara permissões de ferramenta por perfil
via o helper `toolPermission` (`:17`), cujo schema é `toolPermissionSchema`
(`profile.schema.ts:81`):

```ts
toolId, category, description, allowed: boolean,
requiresUserAuthorization: literal(true),
enabledByDefault: literal(false),
paidUseRequiresExplicitAuthorization: literal(true)
```

Os perfis declaram **7** `toolId` distintos, mas o catálogo tem apenas 5:

| `toolId` declarado em perfil | Existe no catálogo? | Perfil(is) |
| --- | --- | --- |
| `personal.tasks` | **sim** | YUI (l.60) |
| `personal.organize` | **sim** | YUI (l.59) |
| `research.search` | **sim** | ALICE |
| `research.fetch_source` | **sim** | ALICE |
| `technical.code_analysis` | **sim** | SCHWI |
| `nexus.help` | **NÃO** | YUI (l.61) |
| `technical.system_inspection` | **NÃO** | SCHWI (l.168) |

**FATO — a divergência é invisível para a suíte.** O teste de alinhamento
(`packages/tools/src/tools.test.ts:70`) é **unidirecional**: percorre
`tool.authorizedAssistantKeys` e exige que o perfil declare aquele `tool.id`. Nunca percorre o
sentido inverso (perfil → catálogo). Um `toolId` declarado no perfil e ausente do catálogo, ou uma
ferramenta cujo `authorizedAssistantKeys` lista um assistente que não a declara, passam
despercebidos.

**Por que isso importa para G13 (PENDENTE 1).** A Fase 5 vai gravar `tool_id` em
`nexus.tool_grants`. Se o catálogo não é a fonte única de verdade, um grant pode referenciar
`nexus.help` — ferramenta que **nenhum executor jamais conhecerá**. A interseção proposta
(`Catálogo ∩ Perfil ∩ Grant`) já bloquearia a seleção por `assistant_not_authorized` (o toolId nem
está no catálogo), mas o registro ficaria órfão e o diagnóstico do usuário seria confuso. É preciso
decidir o que fazer com os 2 órfãos **antes** de criar FKs.

### 1.4 Autorização de ferramenta — hoje um objeto em memória, sem persistência

**FATO.** `evaluateToolPolicy(tool, context, policy)` (`packages/tools/src/policy.ts:6`) recebe a
autorização como **argumento já resolvido**:

```ts
toolExecutionPolicySchema = {
  toolEnabledByBackend: boolean,
  userAuthorization: { status: "not_authorized"|"authorized"|"revoked",
                       userId, toolId?, authority:"backend", paidUseExplicitlyAuthorized },
  externalPermission: { userId, toolId, granted, authority:"backend" },
  confirmation: { status, userId, toolId, authority:"backend" },
}
```

Não há leitura de banco. `userId` é comparado por igualdade com `context.userId` — a "autorização"
é uma afirmação de quem chama, não um fato verificado. É exatamente a lacuna que G13 fecha.

Ordem de avaliação hoje (`policy.ts:18-38`) e motivos, na sequência em que são testados:

1. `demonstration_only` / `unavailable` / `disabled_by_default` (disponibilidade da definição)
2. `not_enabled_by_backend`
3. `assistant_not_authorized` (união de `tool.authorizedAssistantKeys` **e** declaração no perfil)
4. `authorization_scope_mismatch` / `user_not_authorized` (escopo e status)
5. `paid_use_not_explicitly_authorized`
6. `connection_required`
7. `external_permission_required`
8. `user_confirmation_rejected` / `user_confirmation_required`

### 1.5 Configurações pessoais já existentes

**FATO.** Três tabelas por owner, mais a autorização de provedor, já implementam o padrão que G13
precisa replicar (`migrations/00001_initial_schema.sql`):

| Tabela | Linha | PK | Papel |
| --- | --- | --- | --- |
| `provider_authorizations` | `:481` | `(provider_id)` | **autorização pessoal** com `authorized`/`revoked_at` + CHECK de coerência |
| `global_provider_preferences` | `:536` | `(owner_id)` | preferência de modelo global |
| `assistant_provider_preferences` | `:549` | `(assistant_id)` | preferência por assistente |
| `conversation_provider_preferences` | `:564` | `(conversation_id)` | preferência por conversa |

**FATO — `provider_authorizations` é o precedente direto de `tool_grants`.** Ela já separa
"definição global" (`providers`/`models`) de "permissão pessoal", com:

```sql
PRIMARY KEY (provider_id),
CHECK (NOT paid_use_authorized OR authorized),
CHECK ((authorized AND authorized_at IS NOT NULL AND revoked_at IS NULL)
    OR (NOT authorized AND (authorized_at IS NULL OR revoked_at IS NOT NULL)))
```

e um trigger de enforcement (`enforce_provider_preference_authorization`, `:495`) que **impede
gravar uma preferência manual** apontando para provedor não autorizado, usando `ERRCODE = '42501'`.
Este é o molde de defesa em profundidade a ser copiado: constraint + trigger + RLS + `requireOwnerId`
no repositório.

**FATO — `memory_permissions` é o precedente direto de grant/revogação auditada** (`:379`):

```sql
UNIQUE (memory_id, assistant_id),
CHECK (granted_by_owner_id = owner_id),
CHECK (revoked_by_owner_id IS NULL OR revoked_by_owner_id = owner_id),
CHECK ((status='granted' AND revoked_by_owner_id IS NULL AND revoked_at IS NULL)
    OR (status='revoked' AND revoked_by_owner_id IS NOT NULL AND revoked_at IS NOT NULL
        AND revoked_at >= granted_at))
CREATE INDEX ... ON (owner_id, memory_id, assistant_id) WHERE status = 'granted';
```

mais `memory_permission_audit` (`:429`) com trigger `SECURITY DEFINER`
(`audit_memory_permission_change`, `:451`) que registra `granted`/`revoked` e é `REVOKE ALL ... FROM
PUBLIC` (`:480`).

**Conclusão de arquitetura:** G13 **não precisa inventar** um modelo de autorização pessoal. Precisa
**transportar** um padrão já validado em produção (provider_authorizations + memory_permissions)
para o domínio de ferramentas.

### 1.6 RLS: o mecanismo e suas duas variantes

**FATO — funções de contexto** (`00001_initial_schema.sql:21-48`), todas `STABLE`,
`SET search_path = pg_catalog`, lendo `current_setting(..., true)`:

- `nexus.current_owner_id()` — `nexus.owner_id`
- `nexus.current_actor_type()` — `nexus.actor_type`
- `nexus.current_assistant_id()` — `nexus.assistant_id`
- `nexus.configured_owner_id()` (`:92`) — **singleton** de `owner_identity`

**FATO — `owner_identity` é singleton por construção** (`:82`):
`singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)` e um único `INSERT` (`:89`) com
`'00000000-0000-4000-8000-000000000004'`. Não existe hoje multi-owner real.

**FATO — duas variantes de política coexistem:**

| Variante | USING / WITH CHECK | Onde |
| --- | --- | --- |
| **A — leitura ampla, escrita do owner** | SELECT: `owner_id = current_owner_id() AND owner_id = configured_owner_id()` (sem `actor_type`); INSERT/UPDATE/DELETE: as mesmas duas igualdades **`AND actor_type = 'owner'`** | `*_provider_preferences` (`:758-789`) |
| **B — tudo exige owner** | USING e WITH CHECK: `owner_id = current_owner_id() AND owner_id = configured_owner_id() AND actor_type = 'owner'` | `tool_events` (`:679`), `conversations`, `messages`, `memories`, etc. |

A variante **A** permite que um actor `assistant` **leia** as preferências (necessário: o CORE lê a
preferência de modelo dentro de uma transação com actor `assistant`), mas nunca escreva. A variante
**B** é usada onde nem leitura de assistente é aceitável.

**FATO — `FORCE ROW LEVEL SECURITY` está em 17 tabelas** e `migrations.test.ts:58` fixa essa lista;
`owner_identity` é explicitamente **excluída** (`migrations.test.ts:52`).

### 1.7 Fronteira de confiança: como o `ownerId` chega à transação

**FATO.** O único caminho legítimo é o token de sessão:

- `apps/server/src/auth/session.ts:3` — `SessionPayload.ownerId` é do tipo `typeof OWNER_ID`
  (constante). `verifySessionToken` (`:21`) exige `p.ownerId === OWNER_ID` e valida assinatura,
  `jti`, janela temporal.
- Rotas passam `req.session!.ownerId` para o serviço (ex.: `routes/core.ts:165`,
  `options.core.createConversation(req.session!.ownerId, parsed.data)`). **Nunca** leem `ownerId`
  do corpo, query ou path.
- `apps/server/src/database.ts:18` documenta: "Only trusted backend code may call
  createTrustedOwnerContext / withOwnerTransaction. Never construct OwnerTransactionContext from
  unvalidated client input."
- `createTrustedOwnerContext(ownerId, actor)` (`packages/database/src/postgres/index.ts:95`) é um
  construtor trivial — a garantia está na disciplina de chamada, não no tipo.

**FATO — `withOwnerTransaction`** (`packages/database/src/postgres/transaction.ts:20`) aplica o
contexto **exclusivamente** com `set_config(..., true)` (transaction-local), limpa
`nexus.assistant_id` quando o actor é `owner`, e destrói a conexão (`release(true)`) se o `ROLLBACK`
falhar. Nunca expõe `PoolClient` ao callback: o callback recebe apenas o bag tipado
`NexusRepositories`.

**FATO — defesa em profundidade no repositório.** `preferences.ts:62` (`requireOwnerId`) não confia
no contexto: pergunta ao banco.

```sql
SELECT CASE WHEN nexus.current_owner_id() = nexus.configured_owner_id()
            THEN nexus.current_owner_id() END AS owner_id
```

e lança `new Error("Owner context is missing or not authorized")` se nulo. Todo `WHERE` subsequente
usa esse valor **derivado do RLS**, nunca um parâmetro. É este o padrão que os repositórios de G13
devem seguir — sem exceção.

### 1.8 Padrão de API do servidor

**FATO.** Fastify, `preHandler: requireAuth`, envelope de erro único.

- Envelope: `apiErrorSchema` (`packages/shared/src/schemas/errors.ts:4`) =
  `{ error: { code, message, requestId?, retryable, details? }, timestamp }`.
- Rotas de leitura de assistente: `GET /v1/assistants`, `GET /v1/assistants/:key`
  (`routes/assistants.ts:84,88`), retornando `{ assistants: [...] }` / `{ assistant: {...} }`.
- Erro 404: `{ error: { code: "NOT_FOUND" | "ASSISTANT_NOT_FOUND", ... }, timestamp }`
  (`assistants.ts:93`; `providers.ts:214`).
- Validação por `safeParse` → `reply.code(400).send(buildApiError("INVALID_REQUEST", ...))` com
  `details.issues = [{ path, message }]` (`routes/core.ts:45`, `:150`).
- `buildApiError` está **duplicado** localmente em `routes/core.ts:45` e `routes/providers.ts:158`;
  não há helper compartilhado. (FATO de dívida; ver §13.)

### 1.9 Regime de testes e invariantes que a Fase 5 vai encontrar

**FATO — a infraestrutura de integração é SQL puro contra PostgreSQL 17 real, sem mocks:**

- `packages/database/scripts/test-postgres-integration.sh` sobe container, aplica migrações e
  exige **exatamente 6** migrações (`:12`, `migration_count -ne 6`).
- `packages/database/tests/postgres/bootstrap.sql:23` cria `nexus_app`
  (`LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`) e `nexus_anonymous`, e concede privilégio **tabela a
  tabela** (`:62-70`). Não há `GRANT ... ON ALL TABLES` para `nexus_app` — tabela nova nasce
  **sem** privilégio para a aplicação.
- `bootstrap.sql` verifica contagens fixas: **18** índices nomeados (`:41`), e publica
  `nexus_table_count`, `forced_rls_table_count`, `nexus_policy_count` (`:55-57`).
- `integration.sql:1` roda com `ON_ERROR_STOP on`, exige `current_user = nexus_app`, recusa
  superuser/`BYPASSRLS` (`:12`), e prova que **sem contexto** `SELECT` retorna 0 linhas e `INSERT`
  falha com `insufficient_privilege` (`:23-34`).
- Suíte JS: `repositories.integration.test.ts` usa `describeIfPostgres` e um helper `transact`
  (`:74`) que injeta `OwnerTransactionContext`. O contexto de actor `assistant`
  (`{ type: "assistant", assistantId }`) é **suportado pelo runner mas não usado por nenhum código
  de produção** (`grep -rn 'type: "assistant"'` só encontra `contracts.ts:24`).

**FATO — `tool_events` já é persistido de verdade** por
`packages/database/src/postgres/repositories/executions.ts:665` (INSERT) e lido em `:442`. Ou seja,
o plano afirma "passar a populá-la de verdade" (§6.3, l.1059), mas ela **já é populada** na
persistência de execução. Não é preciso criar estrutura de evento para G13.

### 1.10 Baseline verificável

| Métrica | Valor | Origem |
| --- | --- | --- |
| Suíte total | 790 passed / 28 skipped (818), 61 arquivos | fim da Fase 4 |
| Tabelas em `nexus` | 24 | 21 + 2 + 1 nas migrações 00001-00003 |
| Tabelas com RLS `FORCE` | 17 | `migrations.test.ts:58` |
| Policies | 39 (`00001`: 38, `00003`: 1) | `grep -c "CREATE POLICY"` |
| Índices nomeados verificados | 18 | `bootstrap.sql:41` |
| Migrações | 6 | `test-postgres-integration.sh:12` |

---

## 2. Diagnóstico

### 2.1 O que já existe e deve ser reutilizado (não recriar)

| Necessidade de G13 | Estrutura existente | Reutilizar como |
| --- | --- | --- |
| Isolamento entre owners | RLS `FORCE` + `current_owner_id`/`configured_owner_id`/`actor_type` | exatamente o padrão, variante A ou B (§1.6) |
| Derivação segura do owner | `requireOwnerId()` em `preferences.ts:62` | copiar o padrão nos repositórios novos |
| Contexto transacional | `withOwnerTransaction` + `set_config(..., true)` | inalterado |
| Concessão pessoal com revogação | `memory_permissions` + `memory_permission_audit` | molde de DDL/CHECK/trigger |
| Autorização pessoal com trigger de coerência | `provider_authorizations` + `enforce_provider_preference_authorization` | molde de enforcement por trigger |
| Preferência por conversa | `conversation_provider_preferences` | **não** criar segunda estrutura por conversa |
| Evento de ferramenta | `tool_events` (já populado) | **não** criar tabela de evento concorrente |
| Envelope de erro | `apiErrorSchema` | inalterado |
| Identidade de assistente | `nexus.assistants` (seed) + `packages/assistant-profiles` | FK por `assistant_id` |
| Catálogo de ferramentas | `packages/tools` (memória) | fonte de verdade; espelho opcional |

### 2.2 O que existe parcialmente

| Item | Estado real | O que falta |
| --- | --- | --- |
| Política de ferramenta | `evaluateToolPolicy` completo e testado, **sem persistência e sem chamador** | plugar dados persistidos; integrar ao CORE |
| Perfil → permissão | `toolPermission.allowed` existe e é respeitado pela política | validação **bidirecional** perfil ↔ catálogo |
| Preferência por assistente | existe para **modelo** (`assistant_provider_preferences`) | preferências de produto (ordem, padrão, rótulos) |
| Preferência por conversa | existe para **modelo** (`conversation_provider_preferences`) | configurações de conversa, **se** necessárias |
| Catálogo global | em memória, congelado, sem tabela | espelho opcional (`tool_definitions`) |
| Actor `assistant` | suportado no runner e no contrato | nenhuma rota/código usa; semântica não exercitada |

### 2.3 O que não existe

`tool_grants`, `user_assistant_preferences`, `user_assistant_settings`, `tool_confirmations`,
`tool_definitions`, `assistant_capabilities`, `conversation_settings` — **nenhuma** existe. Também
não existe repositório, rota, schema Zod compartilhado nem teste de integração para qualquer delas.

### 2.4 Defeitos e riscos encontrados na auditoria

| # | Severidade | Achado | Evidência |
| --- | --- | --- | --- |
| **D1** | **Alta** | `evaluateToolPolicy` não é chamado por ninguém; `@nexus/tools` não é dependência de nenhum pacote/app | §1.1 |
| **D2** | **Alta** | Perfis declaram `nexus.help` e `technical.system_inspection`, ausentes do catálogo; teste de alinhamento é unidirecional | §1.3, `tools.test.ts:70` |
| **D3** | **Média** | `provider_authorizations` tem `PRIMARY KEY (provider_id)` **sem `owner_id`**; `assistant_provider_preferences` idem, `conversation_provider_preferences` idem. Só funcionam porque `owner_identity` é singleton. No dia em que houver 2 owners, o segundo não pode autorizar o mesmo provedor | `00001:487,556,571` |
| **D4** | **Média** | `ownerId`/`userId` na política são comparados por igualdade com um objeto fornecido pelo chamador — "autorização" hoje é asserção, não verificação | `policy.ts:22-24` |
| **D5** | **Média** | `tool_grants` inexistente + ausência de grant não tem semântica definida (negar por padrão ou herdar?). O plano sugere `assistant_not_authorized` | §5.9, l.1387 |
| **D6** | **Baixa** | `buildApiError` duplicado em `core.ts` e `providers.ts`; novas rotas tenderiam a uma terceira cópia | §1.8 |
| **D7** | **Baixa** | `tool_events` referenciado pelo plano como "a popular", mas já é populado — risco de trabalho duplicado | §1.9 |
| **D8** | **Baixa** | `bootstrap.sql` fixa contagens exatas com `RAISE EXCEPTION`: 24 tabelas (`:21`), 24 com PK (`:23`), 17 com RLS `FORCE` (`:25`), 39 policies (`:27`), 18 índices (`:41`); e `test-postgres-integration.sh:12` exige 6 migrações. Qualquer tabela nova quebra os cinco até serem atualizados | §6.5 |

**D3 é o achado mais consequente para o desenho.** Se `tool_grants` repetir o padrão de PK sem
`owner_id`, ele herda o mesmo limite estrutural. G13 deve **corrigir o padrão nas tabelas novas**
(PK composta com `owner_id`) sem tocar nas antigas — e registrar o débito das antigas.

---

## 3. Lacunas (o que G13 precisa entregar)

| Lacuna | Descrição | Entregue em |
| --- | --- | --- |
| **L1** | Persistência da autorização pessoal de ferramenta (hoje em memória) | §4.1, §5.1 |
| **L2** | Semântica explícita de "sem grant" | §4.4, §7.3 |
| **L3** | Resolução da autorização efetiva a partir do banco, dentro da transação autorizada | §7, §8, §9 |
| **L4** | Preferências pessoais de assistente sem sobrepor o global | §4.2, §4.3 |
| **L5** | Superfície de API para o owner gerir grants e preferências | §10 |
| **L6** | Prova de isolamento entre owners em PostgreSQL real | §11 |
| **L7** | Validação perfil ↔ catálogo bidirecional (fecha D2) | §5.5, §11 |
| **L8** | Regra testável de que `canCoordinate` não concede ferramenta | §7.4, §11 |

---

## 4. Modelo de dados

### 4.1 `nexus.tool_grants` — autorização pessoal por ferramenta (**PROPOSTA**)

**Decisão de desenho: uma tabela por par `(owner, assistant, tool)`, com histórico por status, não
uma tabela de eventos separada.** Justificativa: `memory_permissions` já provou o padrão (linha
única com `status` + `granted_at`/`revoked_at` + CHECK de coerência + índice parcial em
`status='granted'`), e a auditoria completa vive em tabela de audit separada (§4.5). Criar um log
append-only de grants duplicaria a auditoria.

**Escolha de chave: `id uuid` como PK + `UNIQUE (owner_id, assistant_id, tool_id)`.** Diferente de
`memory_permissions`, que usa `(memory_id, assistant_id)`; aqui `owner_id` entra na unicidade
explícita para não herdar D3.

| Coluna | Tipo | Regra |
| --- | --- | --- |
| `id` | `uuid` | PK, gerado pela aplicação (como todas as tabelas do repositório) |
| `owner_id` | `uuid` | `NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE` |
| `assistant_id` | `uuid` | `NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT` |
| `tool_id` | `text` | `NOT NULL`, `CHECK (tool_id <> '')`; **não** FK para catálogo (ver §4.1.1) |
| `status` | `nexus.tool_grant_status` | `IN ('granted','revoked')` |
| `granted_by_owner_id` | `uuid` | `NOT NULL`, `CHECK (granted_by_owner_id = owner_id)` |
| `granted_at` | `timestamptz` | `NOT NULL` |
| `revoked_by_owner_id` | `uuid` | `NULL`, `CHECK (NULL OR = owner_id)` |
| `revoked_at` | `timestamptz` | `NULL` |
| `created_at` / `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()`, `CHECK (updated_at >= created_at)` |

**Por que `granted_by_owner_id` e não apenas `granted_at`.** É o padrão de `memory_permissions`
(`:383-386`) e serve a dois fins: (a) prova que a concessão partiu do próprio owner da linha —
`CHECK (granted_by_owner_id = owner_id)` torna **impossível** registrar um grant em nome de outro
owner, mesmo por SQL privilegiado; (b) a auditoria copia o snapshot histórico. Sem esse CHECK,
um bug de aplicação que passasse o `ownerId` errado gravaria uma linha internamente inconsistente
que o RLS **não** detectaria (o RLS compara com o contexto, não com a semântica da linha). Este é o
mesmo raciocínio que sustenta `actor_owner_id = owner_id` em `memory_permission_audit:441`.

#### 4.1.1 `tool_id` como `text` e não FK para `nexus.tool_definitions`

**PENDENTE 2.** O catálogo é código congelado em memória (§1.2) e o plano prevê
`nexus.tool_definitions` como espelho **opcional** (§6.2, l.1026: "hoje só em código"). Três opções:

| Opção | Efeito | Custo |
| --- | --- | --- |
| **(a) `text` sem FK** *(recomendada para 5.1)* | Barato; o catálogo continua a única verdade; grant órfão é detectável por consulta | Nenhuma FK garante integridade; exige validação na aplicação |
| **(b) FK para `tool_definitions`** | Integridade referencial real; grant impossível para ferramenta inexistente | Exige criar e manter o espelho e um passo de seed; toda evolução do catálogo vira migração |
| **(c) FK + `ON DELETE RESTRICT`** | Idem (b), e impede remover ferramenta com grants | Migração sempre que uma ferramenta sai do catálogo |

**Recomendação:** (a) em 5.1, com a integridade garantida em **três** pontos: validação Zod da
entrada (`toolId` deve existir em `toolCatalog`), `CHECK` de formato, e rejeição no repositório.
O espelho `tool_definitions` fica como **PENDENTE 2**, a decidir antes da Fase 6 (que terá executor e
precisará consultar metadados sem carregar o pacote inteiro). Criar o espelho agora, sem executor,
seria uma tabela sem leitor e sem escritor — exatamente o tipo de estrutura sobreposta que a tarefa
proíbe.

#### 4.1.2 Ausência de grant: a decisão semântica

**PENDENTE 3 (crítica).** Há duas leituras incompatíveis:

- **Negar por padrão (deny-by-default).** Sem linha em `tool_grants` → `assistant_not_authorized`.
  Consistente com `toolPermission.requiresUserAuthorization: literal(true)` e
  `enabledByDefault: literal(false)` — **o próprio schema do perfil já proíbe habilitar por padrão**.
  É também o que o plano manda testar (§5.9, l.1387: "grant ausente → `assistant_not_authorized`").
- **Herdar do perfil.** Sem linha → vale a permissão declarada no perfil. Seria mais permissivo e
  contradiz `enabledByDefault: false`.

**Recomendação: deny-by-default**, com dois refinamentos que evitam ambiguidade operacional:

1. **Ausência de linha e linha `revoked` produzem o mesmo veredito** (`assistant_not_authorized`,
   ver §7.3 sobre o porquê de não criar motivo novo). A diferença é de diagnóstico/UI, não de
   autorização.
2. **A ausência é distinguível na leitura.** A rota `GET` de autorização (§10.3) devolve
   `state: "not_granted" | "granted" | "revoked"` — derivado da **ausência de linha**, sem criar
   linha fantasma. Não se materializa "grant ausente" como estado persistido (§4.4).

**Por que não usar `INSERT` antecipado de todos os pares possíveis** (owner × assistente ×
ferramenta): 4 assistentes × 5 ferramentas = 20 linhas hoje, mas o produto cresce nos dois eixos, e
todo par novo exigiria backfill. Além disso, uma linha `revoked` pré-existente seria
indistinguível de "nunca concedido" na leitura, o que destrói justamente o diagnóstico do item 2.

#### 4.1.3 Índices

```sql
CREATE INDEX tool_grants_active_lookup_idx
  ON nexus.tool_grants (owner_id, assistant_id, tool_id)
  WHERE status = 'granted';                    -- caminho quente da política
CREATE INDEX tool_grants_by_owner_assistant_idx
  ON nexus.tool_grants (owner_id, assistant_id); -- listagem de UI (inclui revogados)
UNIQUE (owner_id, assistant_id, tool_id)        -- já indexa (owner, assistant, tool)
```

`tool_grants_active_lookup_idx` é parcial porque a política **só** consulta `status='granted'`; é o
mesmo raciocínio de `memory_permissions_active_lookup_idx:403`.

#### 4.1.4 Regras de revogação

| Regra | Mecanismo | Por quê |
| --- | --- | --- |
| Revogar não apaga | `status='revoked'` + `revoked_at`/`revoked_by_owner_id` | trilha histórica; `memory_permissions` é o precedente |
| Escopo imutável | trigger `BEFORE UPDATE`, se `owner_id`/`assistant_id`/`tool_id` mudarem → exceção `42501` | impede "revogar e reaproveitar" a mesma linha para outro escopo |
| Coerência de estado | `CHECK` (§4.1) | estado impossível não entra, nem por SQL direto |
| Re-concessão | `UPDATE ... SET status='granted', granted_at=now(), revoked_* = NULL` | `UNIQUE` mantém uma linha por escopo; não há acúmulo de duplicatas |
| Revogação em massa | operação de repositório, em **uma** transação | atomicidade: não existe estado intermediário parcialmente revogado |

**Concorrência (§7.5 / §11):** duas concessões simultâneas do mesmo par colidem no `UNIQUE` — a
segunda falha com `23505`, mapeada para `409` ou convertida em `ON CONFLICT ... DO UPDATE` idempotente
(**PENDENTE 4**: idempotente vs. conflito explícito). Recomendação: **idempotente** para `PUT`
(o cliente reenvia com segurança) e **conflito explícito** para `POST` de concessão em massa.

### 4.2 `nexus.user_assistant_preferences` — preferências pessoais de apresentação (**PROPOSTA**)

O plano (§5.9, l.947) define: "quem abre por padrão, ordenação, rótulos". Nada disso é autorização.

| Coluna | Tipo | Regra |
| --- | --- | --- |
| `owner_id` | `uuid` | `NOT NULL REFERENCES owner_identity ON DELETE CASCADE` |
| `assistant_id` | `uuid` | `NOT NULL REFERENCES assistants ON DELETE CASCADE` |
| `is_default` | `boolean` | `NOT NULL DEFAULT false` |
| `sort_order` | `integer` | `NOT NULL DEFAULT 0`, `CHECK (sort_order >= 0)` |
| `display_label` | `text` | `NULL`, `CHECK (char_length <= 64)` |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` |
| | | `PRIMARY KEY (owner_id, assistant_id)` |

**PK composta com `owner_id`** — correção explícita de D3.

**`is_default` e o invariante "no máximo um padrão por owner".** Opções:

| Opção | Mecanismo | Veredito |
| --- | --- | --- |
| Índice único parcial | `CREATE UNIQUE INDEX ... ON (owner_id) WHERE is_default` | **recomendado**: barato, correto, sem trigger |
| Trigger | desmarcar os demais | complexidade sem ganho |
| Sem invariante | dois padrões → ordem indefinida | inaceitável |

O índice único parcial **não** cobre o caso "usuário troca o padrão" — a troca precisa ser
`UPDATE` dos dois registros na **mesma transação** (primeiro desmarca, depois marca), senão colide.
Isso é responsabilidade do repositório (§9.2), não do banco. Alternativa mais simples, se o produto
aceitar: guardar `default_assistant_id` em tabela de linha única por owner (§4.3) — **PENDENTE 5**.

**Não** incluir aqui conteúdo de prompt, instruções ou `jsonb` livre. Ver §4.3.

### 4.3 `user_assistant_settings` × `user_assistant_preferences` — **não criar as duas**

**PENDENTE 6 (decisão de modelagem central).** O plano (§5.9, l.948) admite as duas alternativas:
"`nexus.user_assistant_settings` (nova) **ou** colunas em `user_assistant_preferences`".

Análise dos dois usos reais declarados:

| Uso | Natureza | Precisa de tabela própria? |
| --- | --- | --- |
| Ordem, padrão, rótulo | preferência de **apresentação**, 1 linha por (owner, assistente) | não |
| Verbosidade | preferência de **apresentação** | não |
| "Confirmações" | **não é preferência**: é exigência de segurança derivada de `requiresUserConfirmation` | **deve ser derivada**, nunca uma coluna que o cliente possa baixar |
| "Limites pessoais" | **não é preferência**: é política de runtime/custo, decidida pelo servidor | **não** persistir agora (Fase 6/7) |

**Recomendação: uma única tabela `user_assistant_preferences`**, com colunas tipadas e `CHECK`
— sem `user_assistant_settings`. Motivos:

1. **Sem sobreposição:** as duas tabelas teriam chave `(owner_id, assistant_id)` e ciclo de vida
   idêntico. Duas tabelas com a mesma chave é a definição de estrutura sobreposta.
2. **"Confirmações" não pode ser configurável.** `toolPermissionSchema.requiresUserAuthorization` é
   `literal(true)`; se existisse uma coluna `requires_confirmation boolean` por assistente, o
   cliente poderia desligá-la — concedendo permissão, o que viola "personalização só restringe".
   A confirmação permanece **derivada de `tool.requiresUserConfirmation`** (§7.3).
3. **"Limites pessoais" pertencem à fase que os aplica** (Fase 6/7, com `ToolRuntimeLimits`).
   Criar coluna agora é coluna sem leitor.
4. Se no futuro um limite pessoal for necessário, ele entra na **mesma** tabela como coluna tipada
   com `CHECK` — sem nova tabela.

**Verbosidade** entra como `response_verbosity text NOT NULL DEFAULT 'normal' CHECK (IN
('concise','normal','detailed'))`. Se a Fase 5 não precisar exibir o controle na UI, a coluna pode
ser omitida e adicionada depois por `ALTER TABLE` — decisão de escopo (**PENDENTE 6b**).

### 4.4 `nexus.tool_confirmations` — **não criar na Fase 5**

**FATO.** Hoje `confirmationRequirement` é calculado em memória dentro de `evaluateToolPolicy`
(`policy.ts:15-25`) a partir de `tool.requiresUserConfirmation` e do `status` em
`toolExecutionPolicySchema.confirmation` — e `executionImplemented` é `literal(false)`.

**PROPOSTA: adiar para a Fase 6.** Justificativa:

1. **Não há execução.** Uma confirmação existe para autorizar *uma* execução. Sem executor, uma
   linha em `tool_confirmations` não pode ser consumida por ninguém — é estrutura sem leitor.
2. **A chave natural ainda não existe.** O plano (§6.2, l.1028) define a confirmação "por
   execução/ferramenta", o que implica `run_id`/`step_id` ou `invocation_id`. `tool_invocations`
   (l.1029) também é da Fase 6. Criar a tabela antes de decidir a chave arrisca uma migração de
   correção logo em seguida.
3. **Não é requisito de G13.** A tarefa pede *avaliar* `tool_confirmations`. A avaliação conclui:
   não nesta fase.
4. **A política não é bloqueada por isso.** `evaluateToolPolicy` continua devolvendo
   `user_confirmation_required` exatamente como hoje; o dado de confirmação pode ser passado em
   memória ao chamador (como já é) até existir executor.

Risco aceito e registrado: quando a Fase 6 chegar, a confirmação precisará de tabela com FK para a
execução — e o modelo mental já estará pronto.

### 4.5 Auditoria de grants

**PROPOSTA:** `nexus.tool_grant_audit`, espelhando `memory_permission_audit` (`:429`):

| Coluna | Tipo | Nota |
| --- | --- | --- |
| `id` | `bigint GENERATED ALWAYS AS IDENTITY` | PK |
| `owner_id` | `uuid NOT NULL` | FK `owner_identity`, `ON DELETE CASCADE` |
| `grant_id` | `uuid NOT NULL` | **sem FK** — snapshot histórico sobrevive à exclusão |
| `assistant_id` | `uuid NOT NULL` | FK `assistants` `ON DELETE RESTRICT` |
| `tool_id` | `text NOT NULL` | snapshot |
| `action` | `nexus.tool_grant_action` | `IN ('granted','revoked')` |
| `actor_owner_id` | `uuid NOT NULL` | `CHECK (actor_owner_id = owner_id)` |
| `occurred_at` | `timestamptz NOT NULL DEFAULT now()` | |

Gravado por trigger `AFTER INSERT OR UPDATE` `SECURITY DEFINER` com
`REVOKE ALL ON FUNCTION ... FROM PUBLIC` — cópia fiel de `audit_memory_permission_change` (`:451`).

**Por que tabela separada e não colunas em `tool_grants`:** o histórico de N ciclos
grant→revoke→grant não cabe em uma linha. `memory_permissions` já resolveu isso assim.

**Decisão sobre `tool_events`:** **não** usar `tool_events` para auditoria de grant. `tool_events`
exige `run_id NOT NULL` com FK para `core_runs` (`:326`); um grant não tem run. Forçar a FK
obrigaria a inventar uma execução falsa — violação direta de "não criar estruturas sobrepostas/
incompatíveis".

#### 4.5.1 Política de retenção (**APROVADA**)

A trilha é **imutável, não indestrutível**. Três afirmações distintas, cada uma com seu teste:

| Evento | Efeito na trilha | Como é provado |
| --- | --- | --- |
| Vida normal da instalação | **append-only**: `nexus_app` sem `INSERT`/`UPDATE`/`DELETE`; só `SELECT`; escrita exclusivamente pela função `SECURITY DEFINER` | `verify-stage-5-rls.sql` blocos A, G e M |
| Excluir um **grant** | eventos **preservados** — `grant_id` é snapshot, sem FK para `tool_grants` | `verify-stage-5-rls.sql` bloco L; `verify-stage-5-owner-deletion.sql` §1 |
| Excluir **definitivamente o owner**, sem dados nas tabelas com trigger de tombstone | trilha **apagada** junto (`owner_id ON DELETE CASCADE`) | `verify-stage-5-owner-deletion.sql` §4 |
| Excluir **definitivamente o owner**, com dados presentes | ❌ **impossível hoje** — falha com `SQLSTATE 23503` em `tombstones_owner_id_fkey` | `verify-stage-5-owner-deletion.sql` §3 |

A remoção do owner não é alcançável pela aplicação: `nexus_app` tem apenas `SELECT` em
`owner_identity`. Por isso o teste do efeito roda como `postgres`, em transação com `ROLLBACK`, num
arquivo separado — a declaração da FK (`confdeltype = 'c'`) é verificada no bloco M do teste de RLS.

> **A cascata da Fase 5 está correta, mas a exclusão do owner não é executável com dados reais.**
> `record_deleted_entity()` (00001) é `SECURITY DEFINER` e insere em `nexus.tombstones` o
> `OLD.owner_id` de cada linha apagada. Quando o owner é excluído, as FKs `*_owner_id_fkey` de
> `messages`, `conversations` e `assistant_memories` cascateiam e os triggers tentam gravar um
> tombstone apontando para um owner que já não existe; `tombstones_owner_id_fkey` rejeita a
> operação inteira. Consequência: `DELETE FROM nexus.owner_identity` só conclui quando as três
> tabelas estão vazias. Corrigir isso exige tocar em `record_deleted_entity()` ou na FK —
> **fora do escopo da 5.1**, e registrado como limitação conhecida em
> `verify-stage-5-owner-deletion.sql` §3. Quando for corrigido, aquele bloco falha de propósito e
> obriga a atualizar este documento.

### 4.6 Preferências por conversa — **não criar `conversation_settings`**

**FATO.** `conversation_provider_preferences` (§1.5) já cobre a preferência de modelo por conversa e
é lida por `ProviderPreferenceRepository.resolve({ assistantId, conversationId })`
(`contracts.ts:121`). O plano menciona `conversation_settings` "se necessária" (§5.9, l.949).

**PROPOSTA: não criar.** Não há, em G13, nenhum requisito de configuração por conversa que não seja
preferência de modelo. A regra da tarefa é explícita: não criar segunda estrutura por conversa sem
justificativa. Se a Fase 6 precisar (por exemplo, "confirmação automática nesta conversa"), a
justificativa virá acompanhada do consumidor.

**Requisito de teste que decorre disso:** "preferência por conversa e por assistente convivem sem
sobrescrever o global" (§5.9, l.1388) é verificável **hoje** sobre as tabelas existentes e deve ser
parte da matriz (§11, cenário R12).

### 4.7 Resumo do modelo proposto

| Tabela | Nova? | `owner_id`? | RLS | Decisão |
| --- | --- | --- | --- | --- |
| `nexus.tool_grants` | **sim** | sim | FORCE | criar em 5.1 |
| `nexus.tool_grant_audit` | **sim** | sim | FORCE (ou append-only) | criar em 5.1 |
| `nexus.user_assistant_preferences` | **sim** | sim | FORCE | criar em 5.1 |
| `nexus.tool_confirmations` | **sim** | sim | FORCE | **adiar** (Fase 6) |
| `nexus.user_assistant_settings` | sim | sim | — | **não criar** (§4.3) |
| `nexus.conversation_settings` | sim | sim | — | **não criar** (§4.6) |
| `nexus.tool_definitions` | sim | **não** (catálogo) | sem RLS | **adiar** (PENDENTE 2) |
| `nexus.assistant_capabilities` | sim | **não** | sem RLS | **não criar** (derivável do perfil; §3) |
| `*_provider_preferences` | não | sim | FORCE | reutilizar |
| `tool_events` | não | sim | FORCE | reutilizar |

**Total de tabelas novas em 5.1: 3** (grants, audit, preferences). Não 7.

---

## 5. DDL

Migração **`00007_tool_grants_and_preferences.sql`** (a numeração real é 00007 porque existem
00001-00006 — `test-postgres-integration.sh:12` fixa 6 e precisará passar a 7).

```sql
-- Fase 5 (G13): catálogo global x configurações pessoais.
-- Nenhuma tabela existente e nenhuma linha existente é alterada.

CREATE TYPE nexus.tool_grant_status AS ENUM ('granted', 'revoked');
CREATE TYPE nexus.tool_grant_action AS ENUM ('granted', 'revoked');

-- 5.1.1 Autorização pessoal de ferramenta -----------------------------------
CREATE TABLE nexus.tool_grants (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  tool_id text NOT NULL,
  status nexus.tool_grant_status NOT NULL,
  granted_by_owner_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_by_owner_id uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_grants_unique_scope UNIQUE (owner_id, assistant_id, tool_id),
  CONSTRAINT tool_grants_tool_id_not_blank CHECK (tool_id <> ''),
  CONSTRAINT tool_grants_granted_by_owner CHECK (granted_by_owner_id = owner_id),
  CONSTRAINT tool_grants_revoked_by_owner
    CHECK (revoked_by_owner_id IS NULL OR revoked_by_owner_id = owner_id),
  CONSTRAINT tool_grants_state_coherent CHECK (
    (status = 'granted' AND revoked_by_owner_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_by_owner_id IS NOT NULL
        AND revoked_at IS NOT NULL AND revoked_at >= granted_at)
  ),
  CONSTRAINT tool_grants_timestamps_ordered CHECK (updated_at >= created_at)
);

CREATE INDEX tool_grants_active_lookup_idx
  ON nexus.tool_grants (owner_id, assistant_id, tool_id) WHERE status = 'granted';
CREATE INDEX tool_grants_by_owner_assistant_idx
  ON nexus.tool_grants (owner_id, assistant_id);

-- Escopo imutável: uma linha nao pode ser reaproveitada para outro par.
CREATE FUNCTION nexus.protect_tool_grant_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'granted' THEN
    RAISE EXCEPTION 'Tool grant history must begin with an explicit grant'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.owner_id <> OLD.owner_id
          OR NEW.assistant_id <> OLD.assistant_id
          OR NEW.tool_id <> OLD.tool_id) THEN
    RAISE EXCEPTION 'Tool grant scope is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tool_grants_scope_guard
BEFORE INSERT OR UPDATE ON nexus.tool_grants
FOR EACH ROW EXECUTE FUNCTION nexus.protect_tool_grant_scope();

-- 5.1.2 Auditoria append-only ----------------------------------------------
CREATE TABLE nexus.tool_grant_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE RESTRICT,
  tool_id text NOT NULL,
  action nexus.tool_grant_action NOT NULL,
  actor_owner_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_grant_audit_actor_is_owner CHECK (actor_owner_id = owner_id)
);
CREATE INDEX tool_grant_audit_by_grant_idx
  ON nexus.tool_grant_audit (owner_id, grant_id, occurred_at DESC);

CREATE FUNCTION nexus.audit_tool_grant_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  audit_action nexus.tool_grant_action;
BEGIN
  IF TG_OP = 'INSERT' THEN
    audit_action := 'granted';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    audit_action := NEW.status::text::nexus.tool_grant_action;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO nexus.tool_grant_audit (
    owner_id, grant_id, assistant_id, tool_id, action, actor_owner_id
  ) VALUES (
    NEW.owner_id, NEW.id, NEW.assistant_id, NEW.tool_id, audit_action,
    CASE WHEN audit_action = 'granted'
         THEN NEW.granted_by_owner_id ELSE NEW.revoked_by_owner_id END
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER tool_grants_audit_changes
AFTER INSERT OR UPDATE ON nexus.tool_grants
FOR EACH ROW EXECUTE FUNCTION nexus.audit_tool_grant_change();
REVOKE ALL ON FUNCTION nexus.audit_tool_grant_change() FROM PUBLIC;

-- 5.1.3 Preferencias pessoais de apresentacao ------------------------------
CREATE TABLE nexus.user_assistant_preferences (
  owner_id uuid NOT NULL REFERENCES nexus.owner_identity(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES nexus.assistants(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  display_label text,
  response_verbosity text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, assistant_id),
  CONSTRAINT user_assistant_preferences_sort_order CHECK (sort_order >= 0),
  CONSTRAINT user_assistant_preferences_label_length
    CHECK (display_label IS NULL OR char_length(display_label) BETWEEN 1 AND 64),
  CONSTRAINT user_assistant_preferences_label_not_credential
    CHECK (display_label IS NULL
           OR NOT nexus.text_looks_like_credential_material(display_label)),
  CONSTRAINT user_assistant_preferences_verbosity
    CHECK (response_verbosity IN ('concise', 'normal', 'detailed')),
  CONSTRAINT user_assistant_preferences_timestamps_ordered
    CHECK (updated_at >= created_at)
);

-- No maximo um assistente padrao por owner.
CREATE UNIQUE INDEX user_assistant_preferences_single_default_idx
  ON nexus.user_assistant_preferences (owner_id) WHERE is_default;
```

**Nota sobre `display_label` e credenciais.** Uso o helper **já existente**
`nexus.text_looks_like_credential_material` (`00001:42`) em vez de `jsonb_has_credential_key`
(que é para JSONB). O plano exige a verificação em toda coluna JSONB nova (§5.9, l.959); aqui não
há JSONB, mas o risco de o usuário colar um token no rótulo é real e o CHECK é gratuito.

**Nota sobre `ON DELETE CASCADE` em `assistant_id` de preferências vs `RESTRICT` em grants.**
Preferência é descartável (perde-se a ordenação, nada de segurança); grant é histórico de
autorização e não pode desaparecer por causa de um catálogo de assistentes. A assimetria é
intencional e testável.

**Não há coluna JSONB nesta migração.** Se a aprovação pedir `metadata jsonb` em preferências,
o `CHECK (NOT nexus.jsonb_has_credential_key(metadata))` é obrigatório (§6.4 do plano, l.1066).

---

## 6. RLS

### 6.1 Políticas propostas

`tool_grants` e `tool_grant_audit`: variante **B** (tudo exige `actor_type = 'owner'`).
Motivo: um assistente **nunca** lê nem escreve grants — a resolução da autorização é feita pelo
CORE com actor `owner` **antes** de qualquer delegação, ou derivada pelo próprio servidor. Dar
leitura de grants a um actor `assistant` abriria a porta para o modelo "descobrir" o que pode
pedir, o que é a **YUI deixando de ser não onipotente** por via lateral.

`user_assistant_preferences`: variante **A** (leitura para qualquer actor autenticado no owner;
escrita só `owner`). Motivo: o CORE precisa ler `response_verbosity` dentro de transações com actor
`assistant` (é exatamente o caso de `assistant_provider_preferences`, `:770`).

```sql
-- tool_grants
ALTER TABLE nexus.tool_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.tool_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_grants_owner_access ON nexus.tool_grants
  USING (owner_id = nexus.current_owner_id()
         AND owner_id = nexus.configured_owner_id()
         AND nexus.current_actor_type() = 'owner')
  WITH CHECK (owner_id = nexus.current_owner_id()
         AND owner_id = nexus.configured_owner_id()
         AND nexus.current_actor_type() = 'owner');

-- tool_grant_audit (append-only: sem UPDATE/DELETE para a aplicacao)
ALTER TABLE nexus.tool_grant_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.tool_grant_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_grant_audit_owner_select ON nexus.tool_grant_audit
  FOR SELECT USING (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id()
                    AND nexus.current_actor_type() = 'owner');
CREATE POLICY tool_grant_audit_owner_insert ON nexus.tool_grant_audit
  FOR INSERT WITH CHECK (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id()
                    AND nexus.current_actor_type() = 'owner');

-- user_assistant_preferences (variante A)
ALTER TABLE nexus.user_assistant_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus.user_assistant_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_assistant_preferences_select ON nexus.user_assistant_preferences
  FOR SELECT USING (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id());
CREATE POLICY user_assistant_preferences_owner_insert ON nexus.user_assistant_preferences
  FOR INSERT WITH CHECK (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id()
                    AND nexus.current_actor_type() = 'owner');
CREATE POLICY user_assistant_preferences_owner_update ON nexus.user_assistant_preferences
  FOR UPDATE USING (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id()
                    AND nexus.current_actor_type() = 'owner')
  WITH CHECK (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id()
                    AND nexus.current_actor_type() = 'owner');
CREATE POLICY user_assistant_preferences_owner_delete ON nexus.user_assistant_preferences
  FOR DELETE USING (owner_id = nexus.current_owner_id()
                    AND owner_id = nexus.configured_owner_id()
                    AND nexus.current_actor_type() = 'owner');
```

### 6.2 Comportamento sem contexto autorizado

Sem `nexus.owner_id` definido, `nexus.current_owner_id()` é `NULL`; `owner_id = NULL` é `NULL`
(nunca `true`), portanto:

- `SELECT` → **0 linhas** (não erro). É o comportamento atual, provado em `integration.sql:23`.
- `INSERT` → `WITH CHECK` falha → `insufficient_privilege` (`42501`).
- `UPDATE`/`DELETE` → 0 linhas afetadas (nenhuma linha visível para o `USING`).

Esse comportamento assimétrico (leitura silenciosa vazia, escrita com erro) é o já verificado na
suíte. **Teste obrigatório** (§11, R01-R03).

### 6.3 Isolamento entre owners — e o limite honesto do desenho atual

**FATO:** com `owner_identity` singleton, `configured_owner_id()` retorna **sempre** o mesmo UUID.
Isso significa que, hoje, "Owner A não vê grant de Owner B" é garantido por três mecanismos
independentes:

1. `configured_owner_id()` — só existe um owner legítimo (singleton + `INSERT` único).
2. `current_owner_id()` — vem do token, não do cliente.
3. `CHECK (granted_by_owner_id = owner_id)` — impossibilita linha internamente falsificada.

**PROPOSTA de teste para provar o isolamento de verdade, apesar do singleton:** usar um
**segundo UUID de owner sintético** (`nexus.owner_id` = X ≠ `configured_owner_id()`), que é
justamente o caso que o RLS precisa cobrir quando o singleton for revisto na Fase 7
(`configured_owner_id()` é pré-requisito explícito da fila, §7 do plano, l.1398). Cenários:

| Cenário | Contexto setado | Esperado |
| --- | --- | --- |
| R04 | `nexus.owner_id` = A (=configurado), `actor_type='owner'` | vê os grants de A |
| R05 | `nexus.owner_id` = B (≠configurado), `actor_type='owner'` | **0 linhas**; `INSERT` falha |
| R06 | `nexus.owner_id` = A, `actor_type='assistant'` | **0 linhas**; `INSERT`/`UPDATE`/`DELETE` falham |
| R07 | sem `actor_type` | escrita falha; leitura de preferências funciona (variante A) |

**Este é o teste que prova a intenção de multi-owner** — o RLS exige **as duas** igualdades
(`current = configured`), então um contexto de outro owner é inerte mesmo que o cliente forje
`nexus.owner_id`. Registrar em §13 que, ao se remover o singleton, a política continua correta
(a comparação passa a ser `owner_id = current_owner_id()` sem `configured_owner_id()`, ou
`configured_owner_id()` passa a resolver por linha) — decisão da Fase 7, não desta.

### 6.4 Privilégios (`nexus_app`)

`bootstrap.sql` só concede por tabela. A migração **não** deve conceder privilégio (o
`GRANT`/`REVOKE` do schema é `REVOKE ALL ... FROM PUBLIC`, `00001:810-812`; o `nexus_app` recebe
privilégios explicitamente no bootstrap e nos `GRANT`s de cada migração).

**PROPOSTA:** manter a concessão **no bootstrap de teste**, exatamente como hoje (`bootstrap.sql:62-70`),
e **não** em produção — porque em produção o papel é provisionado fora das migrações. Adições
necessárias no bootstrap:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
  ON nexus.tool_grants, nexus.user_assistant_preferences TO nexus_app;
-- Auditoria: a aplicacao LE, nunca escreve. O trigger SECURITY DEFINER escreve.
GRANT SELECT ON nexus.tool_grant_audit TO nexus_app;
```

Ponto delicado: o trigger `audit_tool_grant_change` é `SECURITY DEFINER` (roda como o dono das
tabelas), por isso grava em `tool_grant_audit` **sem** que `nexus_app` precise de `INSERT` nela —
igual a `audit_memory_permission_change` (`:451`, `REVOKE ... FROM PUBLIC` em `:480`). Manter
`GRANT SELECT` apenas: a aplicação **lê** a auditoria, **nunca** escreve. Isso torna a auditoria
infalsificável pela aplicação, que é o requisito real — e é **mais restritivo** que
`memory_permission_audit`, que hoje recebe `INSERT` (`bootstrap.sql:70`). Não alterar
`memory_permission_audit` (fora de escopo); apenas **não repetir** a permissividade.

### 6.5 O que muda nos invariantes existentes

| Invariante | Antes | Depois (5.1) | Onde está fixado |
| --- | --- | --- | --- |
| Tabelas em `nexus` | 24 | **27** | `bootstrap.sql:21` (`table_count <> 24`) |
| Tabelas com PK | 24 | **27** | `bootstrap.sql:23` |
| Tabelas com RLS `FORCE` | 17 | **20** | `bootstrap.sql:25`, `migrations.test.ts:58` (16 nomes + 00003) |
| Policies | 39 | **46** (+7) | `bootstrap.sql:27` (`policy_count <> 39`) |
| Índices nomeados verificados | 18 | **21** | `bootstrap.sql:41` (`custom_index_count <> 18`) |
| Migrações | 6 | **7** | `test-postgres-integration.sh:12` (`-ne 6`) |
| Lista de tabelas em `migrations.test.ts` | 21 nomes | +3 | `:37` |
| Lista de tabelas protegidas | 16 nomes | +3 | `:58` |

**Toda essa tabela precisa ser atualizada na mesma subfase** (§12, 5.1), senão o bootstrap e a suíte
falham — o que é bom: os verificadores são `RAISE EXCEPTION`, não avisos, então o número **tem** de
ser exato.

---

## 7. Contratos TypeScript e schemas Zod

### 7.1 Onde cada contrato vive

| Contrato | Pacote | Justificativa |
| --- | --- | --- |
| Enums/estados de grant e preferências | `packages/shared` (`schemas/tool-grants.ts`) | precisam atravessar API e banco |
| `ToolGrant`, `EffectiveToolAuthorization` | `packages/shared` | fazem parte do contrato de resposta |
| `effectiveToolPolicyInput` (novo) | `packages/tools` | é insumo da política, não da API |
| Repositórios | `packages/database/contracts.ts` | ponto de extensão existente de `NexusRepositories` |
| Rotas | `apps/server` | padrão atual |

**Princípio:** `packages/tools` **não** importa `@nexus/database`. A política recebe **dados
resolvidos** (como hoje), e quem resolve é o servidor. Isso preserva o pacote puro e testável e
evita dependência circular (§1.1).

### 7.2 `packages/shared/src/schemas/tool-grants.ts` (**PROPOSTA**)

```ts
import { z } from "zod";
import { assistantKeySchema, nonEmptyStringSchema, userIdSchema, uuidSchema } from "./…";

export const toolGrantStateSchema = z.enum(["not_granted", "granted", "revoked"]);

export const toolGrantSchema = z.object({
  id: uuidSchema,
  userId: userIdSchema,
  assistantId: uuidSchema,
  toolId: nonEmptyStringSchema,
  state: toolGrantStateSchema,
  grantedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict();

export const toolGrantListSchema = z.object({ grants: z.array(toolGrantSchema) }).strict();

// Ref do assistente nas rotas: mesma semantica de providers.ts (uuid OU key).
export const assistantRefSchema = z.union([uuidSchema, assistantKeySchema]);
```

**Nota de compatibilidade:** `assistantRefSchema` **não** é inventado — `routes/providers.ts:178-205`
já implementa exatamente essa resolução (tenta UUID, depois key, e lança
`ResourceNotFoundRouteError("ASSISTANT_NOT_FOUND", ...)`). A Fase 5 deve **extrair** esse trecho para
um helper reutilizável (`resolveAssistantRef`), não duplicá-lo. Sem isso, terceira cópia (ver D6).

### 7.3 `EffectiveToolAuthorization` — o que a política precisa receber (**PROPOSTA**)

Substitui — **sem remover** — o `userAuthorization` atual, que continua existindo para
compatibilidade dos testes e do contrato:

```ts
export const effectiveToolAuthorizationSchema = z.object({
  /** Linha ativa de nexus.tool_grants; null quando nao ha grant. */
  grant: z.object({
    status: z.enum(["granted", "revoked"]),
    grantedAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  }).strict().nullable(),
  /** Preferencias aplicaveis (nao ampliam nada; apenas restringem/apresentam). */
  preferences: z.object({
    responseVerbosity: z.enum(["concise", "normal", "detailed"]).optional(),
  }).strict().optional(),
  /** Politica global de habilitacao (ja existe como toolEnabledByBackend). */
  toolEnabledByBackend: z.boolean(),
}).strict();
```

**Decisão sobre o motivo de bloqueio.** O plano diz "grant ausente → `assistant_not_authorized`"
(§5.9, l.1387). Isso conflita semanticamente com o significado atual desse motivo (assistente não
autorizada *pela definição/perfil*). Duas opções:

| Opção | Efeito | Veredito |
| --- | --- | --- |
| Reutilizar `assistant_not_authorized` | Zero mudança de contrato; cliente já trata | recomendado, **com `details` distinguindo** |
| Novo motivo `tool_not_granted` | Diagnóstico mais claro | quebra a união de motivos; exige mudança de schema e de todo consumidor |

**PROPOSTA:** manter os 13 motivos atuais e **não** criar motivo novo. A distinção fina vai em
`details.reason: "no_grant" | "grant_revoked"` na resposta HTTP (não no `ToolPolicyDecision`, que é
`.strict()` sem campo de detalhe). Se a aprovação preferir um motivo novo, é uma mudança de uma
linha no enum — mas então **todos** os testes que exaustam motivos precisam ser revistos
(**PENDENTE 7**).

### 7.4 A regra da YUI, verificável

`canCoordinate: true` **não** entra em nenhum ponto da cadeia de autorização. Prova estrutural
proposta (teste, §11 C05):

- `evaluateToolPolicy` **não** recebe o perfil completo: só `assistantKey`. Portanto não **pode** ler
  `canCoordinate`.
- Um teste de fonte verifica que `policy.ts` não contém `canCoordinate` / `delegat`
  (padrão já usado em `assistant-coupling-guard.test.ts`, que lê arquivos por `readFileSync`).

Isso transforma "YUI não é onipotente" de intenção em **guarda executável**.

---

## 8. Evolução de `evaluateToolPolicy`

### 8.1 Ordem de avaliação proposta

A ordem precisa ser **da fonte mais global para a mais específica**, e cada etapa só roda se a
anterior permitiu (curto-circuito). Proposta (passos 1-2 inalterados; 3-5 reordenados/ampliados):

| # | Etapa | Motivo ao falhar | Mudança |
| --- | --- | --- | --- |
| 1 | Disponibilidade da definição | `demonstration_only` / `unavailable` / `disabled_by_default` | **inalterado** |
| 2 | Habilitada no backend | `not_enabled_by_backend` | **inalterado** |
| 3 | **No catálogo** | `assistant_not_authorized` | **novo**: se `toolId` não existe em `toolCatalog`, nem avalia |
| 4 | **Permitida pelo perfil** | `assistant_not_authorized` | hoje unificado com `authorizedAssistantKeys`; **manter unificado** |
| 5 | **Grant pessoal ativo** | `assistant_not_authorized` (+ `details.reason`) | **novo** (substitui `user_not_authorized`?) |
| 6 | `authorization_scope_mismatch` | `authorization_scope_mismatch` | **inalterado** (token/escopo) |
| 7 | Custo explícito | `paid_use_not_explicitly_authorized` | **inalterado** |
| 8 | Rede | `connection_required` | **inalterado** |
| 9 | Permissão externa | `external_permission_required` | **inalterado** |
| 10 | Confirmação | `user_confirmation_*` | **inalterado** |

**Ponto de decisão (PENDENTE 8):** o passo 5 **substitui** ou **complementa**
`userAuthorization`? Complementar é mais seguro: `userAuthorization.userId` continua sendo o teste
de escopo (passo 6), e o grant é a fonte de verdade do *status*. Recomendação:

- `userAuthorization.status` passa a ser **derivado** do grant quando `effectiveToolAuthorization`
  é fornecido; quando **não** é fornecido (testes antigos, 9 casos em `tools.test.ts`), mantém-se o
  comportamento atual. Isso é compatibilidade retroativa real, não simulacro.
- O `ToolExecutionPolicy` atual não é removido; ganha um campo opcional
  `effectiveAuthorization?`. `policy.ts` escolhe: se presente, usa o grant; senão, usa
  `userAuthorization` como antes.

Isso permite que a Fase 5 entregue a política **sem** quebrar os 9 testes existentes de
`packages/tools` — que continuam provando o comportamento antigo — e adiciona casos novos para o
caminho com grant. Regressão e progresso ficam separados.

### 8.2 Por que "catálogo" antes de "perfil"

Se o `toolId` não está no catálogo, ele não tem `riskLevel`, `costStatus` nem
`requiresUserConfirmation`. Avaliar perfil de uma ferramenta inexistente é comparar com `undefined`
— em TS isso exige guardas em cada passo. Colocar o catálogo primeiro **elimina** a classe de erro
D2 do caminho quente e devolve um veredito honesto (`assistant_not_authorized`: este assistente
não pode usar o que não existe).

### 8.3 Onde a política é chamada (integração)

**PROPOSTA para 5.5, não para 5.3.** `evaluateToolPolicy` é puro; a integração exige:

```ts
// dentro de withOwnerTransaction(ownerContext /* actor: owner */)
const authorization = await repositories.toolGrants.resolveAuthorization({
  assistantId, toolId,
});
const preferences = await repositories.assistantPreferences.get(assistantId);
const decision = evaluateToolPolicy(tool, context, {
  toolEnabledByBackend: true,
  userAuthorization: …,              // derivado
  externalPermission: …,             // permanece indefinido nesta fase
  confirmation: …,                   // permanece em memoria
  effectiveAuthorization: authorization,
});
```

**Não** integrar ao `CoreEngine` na Fase 5: o engine não executa ferramentas
(`executionImplemented: false`) e o plano reserva a integração para a Fase 6
("`evaluateToolPolicy` como pré-condição obrigatória", l.1392). Integrar agora criaria um ponto de
chamada sem consumidor — o mesmo erro de D1 ao contrário.

---

## 9. Repositórios

### 9.1 Extensão de `NexusRepositories` (`contracts.ts`, **PROPOSTA**)

```ts
export interface ResolveToolAuthorization {
  readonly assistantId: AssistantReference["assistantId"];
  readonly toolId: string;
}

export interface ToolGrantRepository {
  /** Concessao idempotente (PUT). Reativa uma linha revogada. */
  grant(input: { assistantId: AssistantReference["assistantId"]; toolId: string }): Promise<ToolGrant>;
  /** Revogacao. Idempotente: revogar o ja revogado nao lanca. */
  revoke(input: { assistantId: AssistantReference["assistantId"]; toolId: string }): Promise<ToolGrant>;
  /** Linha ativa/revogada, ou null se nunca concedida. Nunca cria linha. */
  get(input: { assistantId: AssistantReference["assistantId"]; toolId: string }): Promise<ToolGrant | null>;
  list(): Promise<readonly ToolGrant[]>;
  listForAssistant(assistantId: AssistantReference["assistantId"]): Promise<readonly ToolGrant[]>;
  /** Fonte da verdade para a politica. Deriva do RLS, nunca de parametro. */
  resolveAuthorization(input: ResolveToolAuthorization): Promise<EffectiveToolAuthorization>;
}

export interface AssistantPreferenceRepository {
  list(): Promise<readonly UserAssistantPreference[]>;
  get(assistantId: AssistantReference["assistantId"]): Promise<UserAssistantPreference | null>;
  /** Upsert por (owner, assistente). */
  set(input: SetAssistantPreference): Promise<UserAssistantPreference>;
  /** Define o padrao e desmarca o anterior na MESMA transacao. */
  setDefault(assistantId: AssistantReference["assistantId"]): Promise<void>;
  clear(assistantId: AssistantReference["assistantId"]): Promise<void>;
  /** Configuracoes efetivas (preferencia + defaults do perfil). */
  resolveEffective(assistantId: AssistantReference["assistantId"]): Promise<EffectiveAssistantSettings>;
}

export interface NexusRepositories {
  // …existentes…
  readonly toolGrants: ToolGrantRepository;
  readonly assistantPreferences: AssistantPreferenceRepository;
}
```

### 9.2 Regras de implementação (obrigatórias, derivadas do que existe)

| Regra | Origem | Consequência |
| --- | --- | --- |
| Todo `WHERE` usa `ownerId` obtido de `requireOwnerId()` | `preferences.ts:62` | nunca aceitar `ownerId` como parâmetro público |
| Nenhum repositório recebe `PoolClient` exposto | `transaction.ts:11` | inalterado |
| Escrita exige actor `owner` | RLS variante B | o repositório **não** precisa checar; o banco falha |
| `setDefault` desmarca antes de marcar | índice único parcial | 2 `UPDATE`s na mesma transação |
| `grant` em par existente revogado → reativa | `UNIQUE` + CHECK | `UPDATE`, não `INSERT` |
| `list` ordena de forma estável | determinismo de API | `ORDER BY assistant_id, tool_id` |
| Erros de banco mapeados | padrão do servidor | `23505` → conflito; `42501` → autorização |

**Ponto sutil — `resolveAuthorization` e o RLS.** Como o repositório roda na transação do owner,
`SELECT ... WHERE owner_id = $1 AND ...` já é filtrado pelo RLS. O `requireOwnerId()` garante que
`$1` é o owner **do contexto**, e não o owner que o chamador *acha* que é. As duas checagens são
redundantes **de propósito** (defesa em profundidade, §1.10 do README: "não protege contra SQL
arbitrário usando a própria credencial confiável do backend" — o RLS não é a única barreira).

### 9.3 Operações exclusivas de `owner`

| Operação | Actor permitido | Por que |
| --- | --- | --- |
| `grant` / `revoke` | **somente** `owner` | assistente não altera as próprias permissões (§12 da tarefa) |
| `list` / `get` de grants | **somente** `owner` | §6.1 |
| `set` / `setDefault` / `clear` de preferências | **somente** `owner` | preferência é declaração do dono |
| `resolveAuthorization` / `resolveEffective` | `owner` **ou** `assistant` | o CORE lê; a política precisa disso |

A distinção não é imposta pelo TS (o tipo do repositório é o mesmo); é imposta pelo **RLS**. Um
`grant` com actor `assistant` falha com `42501` — e o teste R06 (§11) prova isso. É a mesma
estratégia de `tool_events` (variante B).

---

## 10. Rotas de API

**Padrão obrigatório** (verificado em §1.8): Fastify, `{ preHandler: requireAuth }`, `ownerId` de
`req.session!.ownerId`, validação por `safeParse`, envelope `apiErrorSchema`, corpo de resposta
envelopado (`{ grants }` / `{ preferences }`), nunca `ownerId` no payload.

**Prefixo:** `/v1` (todos os recursos existentes usam `/v1`).

### 10.1 Grants

| Método | Caminho | Objetivo | Entrada | Saída | Erros |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/v1/tool-grants` | listar grants do owner | query `assistantKey?`, `state?` | `200 { grants: ToolGrant[] }` | `400 INVALID_QUERY_PARAMETERS`, `404 ASSISTANT_NOT_FOUND` |
| `GET` | `/v1/tool-grants/:assistantRef/:toolId` | estado de um par | path | `200 { grant: ToolGrant \| null, state }` | `400 INVALID_REQUEST`, `404 TOOL_NOT_FOUND` |
| `PUT` | `/v1/tool-grants/:assistantRef/:toolId` | conceder (idempotente) | — | `200 { grant }` / `201 { grant }` | `400`, `403 TOOL_NOT_IN_CATALOG`, `404 ASSISTANT_NOT_FOUND`, `409 GRANT_CONFLICT` |
| `DELETE` | `/v1/tool-grants/:assistantRef/:toolId` | revogar (idempotente) | — | `200 { grant }` | `400`, `404` |

**`403 TOOL_NOT_IN_CATALOG`** é o guardião de "grant não pode habilitar ferramenta fora do
catálogo": a rota resolve `toolId` em `toolCatalog` **antes** de chamar o repositório. Se não
existe → `404 TOOL_NOT_FOUND` (recurso inexistente) é mais correto REST que `403`; recomendo `404`
para simetria com `ASSISTANT_NOT_FOUND` (`providers.ts:214`). **PENDENTE 9**: `404` vs `403`.

**`:assistantRef`** aceita UUID **ou** key, resolvido por `resolveAssistantRef` extraído de
`providers.ts:178-205` (§7.2).

### 10.2 Preferências

| Método | Caminho | Objetivo | Entrada | Saída | Erros |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/v1/assistant-preferences` | listar | — | `200 { preferences }` | `401` |
| `GET` | `/v1/assistant-preferences/:assistantRef` | uma preferência efetiva | path | `200 { preference, effective }` | `404 ASSISTANT_NOT_FOUND` |
| `PUT` | `/v1/assistant-preferences/:assistantRef` | upsert | `{ isDefault?, sortOrder?, displayLabel?, responseVerbosity? }` | `200 { preference }` | `400 INVALID_REQUEST` |
| `DELETE` | `/v1/assistant-preferences/:assistantRef` | remover | — | `204` | `404` |

**`isDefault: true` no `PUT`** dispara `setDefault` (transação com 2 `UPDATE`s), não um `UPDATE`
solitário — senão o índice único parcial rejeita.

### 10.3 Rotas explicitamente **não** criadas nesta fase

| Rota | Por que não |
| --- | --- |
| `POST /v1/tool-confirmations` | sem execução (§4.4) |
| `GET/PUT /v1/tool-definitions` | catálogo é código; sem escritor (§4.1.1) |
| `PUT /v1/conversations/:id/settings` | sem requisito (§4.6) |
| qualquer rota que aceite `ownerId` no corpo | viola §1.7 |

### 10.4 Autenticação e autorização

- **Autenticação:** `requireAuth` (token assinado; `ownerId` constante do payload). Sem token →
  `401 UNAUTHORIZED` no formato do plugin.
- **Autorização:** não há papel além de "o owner". Não existe rota administrativa nem leitura por
  terceiros. **Não** criar `:ownerId` no path — isso permitiria enumeração e não tem caso de uso.
- **Contexto transacional:** cada handler abre `withOwnerTransaction({ ownerId:
  req.session!.ownerId, actor: { type: "owner" } }, …)`. Actor `assistant` **nunca** aparece em
  rota (§9.3).

### 10.5 Arquivos previstos

```
apps/server/src/routes/tool-grants.ts          (novo, ~120 linhas)
apps/server/src/routes/assistant-preferences.ts (novo, ~110 linhas)
apps/server/src/routes/assistant-ref.ts         (novo, extraido de providers.ts)
apps/server/src/app.ts                          (+2 registros)
apps/server/src/routes/tool-grants.test.ts      (novo)
apps/server/src/routes/assistant-preferences.test.ts (novo)
```

**Dependência de injeção:** as rotas existentes recebem `options.core`/`options.providers`; as
novas precisam de um `NexusDatabase`. `apps/server/src/app.ts:46-50` já injeta por `options`.
Padrão: `AssistantRoutesOptions` ganha `database?: NexusDatabase`; ausente → `503
CORE_NOT_CONFIGURED` (mesmo padrão de `routes/core.ts:66`). **Sem** singleton global de banco — mantém
testabilidade.

---

## 11. Matriz de testes (PostgreSQL 17 real)

**Proibido mock/pg-mem.** Todos os cenários abaixo rodam contra o container do
`test-postgres-integration.sh` com `nexus_app` (`NOSUPERUSER NOBYPASSRLS`), como `integration.sql`.

### 11.1 Esquema e invariantes (SQL puro, `bootstrap.sql`/novo verificador)

| ID | Cenário | Verificação | Tipo |
| --- | --- | --- | --- |
| S01 | 3 tabelas novas existem | `pg_class` conta 27 | SQL |
| S02 | 20 tabelas com `FORCE RLS` | `relrowsecurity AND relforcerowsecurity` | SQL |
| S03 | 7 policies novas | `pg_policies` por `tablename` | SQL |
| S04 | 3 índices novos presentes | `pg_indexes` | SQL |
| S05 | `actor_type` exigido na escrita de grants | policy contém `current_actor_type()` | SQL |
| S06 | `nexus_app` **não** tem `INSERT` em `tool_grant_audit` | `has_table_privilege` falso | SQL |

### 11.2 Isolamento RLS (o núcleo)

| ID | Contexto | Operação | Esperado |
| --- | --- | --- | --- |
| R01 | **sem contexto** | `SELECT tool_grants` | 0 linhas |
| R02 | **sem contexto** | `INSERT tool_grants` | `insufficient_privilege` (42501) |
| R03 | **sem contexto** | `SELECT user_assistant_preferences` | 0 linhas |
| R04 | owner A (configurado), `actor=owner` | `INSERT`/`SELECT`/`UPDATE`/`DELETE` | sucesso, vê só A |
| R05 | **owner B sintético** (`≠ configured_owner_id()`) | `SELECT`/`INSERT` | 0 linhas / 42501 |
| R06 | owner A, **`actor=assistant`** | `SELECT` grants | **0 linhas** (variante B) |
| R07 | owner A, **`actor=assistant`** | `SELECT` preferências | **1 linha** (variante A: leitura permitida) |
| R08 | owner A, `actor=assistant` | `INSERT`/`UPDATE`/`DELETE` em preferências | 42501 |
| R09 | owner A, **sem `actor_type`** | `INSERT` grants | 42501 |
| R10 | owner A, `actor=owner` | `DELETE` físico de grant | 42501 (sem policy de DELETE) |
| R11 | owner A | `INSERT tool_grant_audit` direto | 42501 (append-only via trigger) |

### 11.3 Integridade de domínio (constraints)

| ID | Cenário | Esperado |
| --- | --- | --- |
| C01 | `INSERT` grant com `status='revoked'` | 42501 (`Tool grant history must begin with an explicit grant`) |
| C02 | `UPDATE` mudando `tool_id` | 42501 (`scope is immutable`) |
| C03 | `status='granted'` com `revoked_at` preenchido | `23514` (CHECK) |
| C04 | `status='revoked'` sem `revoked_by_owner_id` | `23514` |
| C05 | `granted_by_owner_id <> owner_id` | `23514` |
| C06 | dois grants ativos para o mesmo (owner, assistente, tool) | `23505` |
| C07 | `tool_id = ''` | `23514` |
| C08 | `sort_order = -1` | `23514` |
| C09 | `display_label` com 65 chars | `23514` |
| C10 | `display_label` com `sk_live_…` (credencial) | `23514` |
| C11 | `response_verbosity = 'verbose'` | `23514` |
| C12 | dois `is_default = true` para o mesmo owner | `23505` (índice parcial) |
| C13 | grant para `assistant_id` inexistente | `23503` (FK) |
| C14 | `DELETE` de assistente com grant | `23503` (`RESTRICT`), preservando o histórico |
| C15 | `DELETE` de assistente com preferência | sucesso (`CASCADE`) — assimetria intencional (§5) |

### 11.4 Auditoria

| ID | Cenário | Esperado |
| --- | --- | --- |
| A01 | `INSERT` grant | 1 linha em `tool_grant_audit`, `action='granted'` |
| A02 | `UPDATE` para `revoked` | +1 linha, `action='revoked'`, `actor_owner_id` = revogador |
| A03 | `UPDATE` sem mudança de status | **nenhuma** linha nova |
| A04 | `UPDATE` `updated_at` apenas | nenhuma linha (trigger faz `RETURN NEW` sem ação) |
| A05 | re-concessão | +1 linha `granted`; histórico com 3 linhas |
| A06 | `DELETE` de owner | audit cascateia (`ON DELETE CASCADE`) |

### 11.5 Concorrência e transações

| ID | Cenário | Esperado |
| --- | --- | --- |
| X01 | 2 `grant` simultâneos do mesmo par (2 conexões) | 1 sucesso, 1 `23505` **ou** ambos idempotentes (§4.1.4, PENDENTE 4) |
| X02 | `revoke` concorrente com `grant` | serialização; estado final consistente (não "granted" com `revoked_at`) |
| X03 | `setDefault` trocando de A para B concorrentemente | nunca 2 padrões; nunca 0 |
| X04 | `setDefault` e `clear` concorrentes | estado final é um dos válidos, sem violar índice |
| X05 | rollback no meio de `grant` + audit | **nenhuma** linha em `tool_grants` **nem** em `tool_grant_audit` |
| X06 | rollback após `setDefault` (2 UPDATEs) | padrão original preservado |
| X07 | transação com erro no meio | `withOwnerTransaction` faz `ROLLBACK` e não vaza contexto (§1.7) |
| X08 | duas transações de owners diferentes (A e B) | cada uma vê só o seu; sem bloqueio cruzado |
| X09 | `resolveAuthorization` durante `revoke` concorrente | leitura vê granted **ou** revoked, nunca nulo inconsistente (READ COMMITTED) |

### 11.6 Aplicação (Vitest, sem mock de banco)

| ID | Cenário | Esperado |
| --- | --- | --- |
| P01 | `grant` + `resolveAuthorization` | `grant.status='granted'` |
| P02 | sem linha | `grant: null` → política nega |
| P03 | `revoke` + `resolveAuthorization` | `grant.status='revoked'` → política nega |
| P04 | `list` ordena `assistant_id, tool_id` | determinístico |
| P05 | `set` com `isDefault` | padrão anterior desmarcado |
| P06 | `resolveEffective` sem preferência | defaults (não `undefined`) |
| P07 | `grant` com owner de outra sessão | impossível: `ownerId` vem do RLS (§9.2) |

### 11.7 Política (unitário, `packages/tools`)

| ID | Cenário | Esperado |
| --- | --- | --- |
| T01-T09 | os 9 testes atuais | **inalterados** (compatibilidade, §8.1) |
| T10 | `effectiveAuthorization.grant = null` | `assistant_not_authorized` |
| T11 | `grant.status='revoked'` | `assistant_not_authorized` |
| T12 | `grant.status='granted'` + perfil permite | `eligible` (se o resto permitir) |
| T13 | `grant=granted` mas perfil **não** permite | `assistant_not_authorized` |
| T14 | `toolId` fora do catálogo | `assistant_not_authorized` |
| T15 | `canCoordinate` presente no perfil | irrelevante: política não o lê (§7.4) |
| T16 | `grant` presente e `userAuthorization.status='not_authorized'` | negado (a interseção é `AND`) |

### 11.8 Contratos/API (Vitest + `app.inject`)

| ID | Cenário | Esperado |
| --- | --- | --- |
| A01 | `GET /v1/tool-grants` sem token | 401 |
| A02 | `GET` com token | 200, envelope `{ grants }` |
| A03 | `PUT` com `toolId` inexistente | 404 `TOOL_NOT_FOUND` |
| A04 | `PUT` com `assistantRef` inexistente | 404 `ASSISTANT_NOT_FOUND` |
| A05 | `PUT` com `toolId` de outro assistente (perfil nega) | **200 ou 422?** (PENDENTE 10) |
| A06 | `PUT` com `ownerId` no corpo | `400` (schema `.strict()`) |
| A07 | `PUT` idempotente (2x) | 200 nas duas, 1 linha |
| A08 | `DELETE` idempotente | 200 nas duas |
| A09 | `PUT` preferência `sortOrder: -1` | 400 |
| A10 | `PUT` `isDefault` | padrão antigo desmarcado |
| A11 | resposta nunca contém `ownerId` de terceiros | inspeção do JSON |

**A05 é uma decisão de produto relevante (PENDENTE 10):** conceder um grant para uma ferramenta que
o **perfil** proíbe. O grant em si é inofensivo (a política nega por `assistant_not_authorized` no
passo 4), mas permitir a escrita cria um "grant que nunca funciona", confuso na UI. Recomendação:
**rejeitar na escrita** com `422 TOOL_NOT_AVAILABLE_FOR_ASSISTANT`, mantendo o grant como
inofensivo mas impossível de criar. Isso fecha a lacuna de "permissão antiga" no nível da API.

---

## 12. Plano por subfase

### 5.1 — Modelagem e migração `00007`

**Entrega:** `00007_tool_grants_and_preferences.sql` com as 3 tabelas, 2 tipos, trigger de escopo,
trigger de auditoria, 3 índices, 8 policies; atualização de `bootstrap.sql` (contagens 27/20/21,
`GRANT`s), `migrations.test.ts` (2 listas), `test-postgres-integration.sh` (`-ne 7`), e um
verificador `verify-stage-5-rls.sql`.

**Pronto quando:** `test-postgres-integration.sh` passa com 7 migrações; `S01-S06` e `R01-R11`
verdes; nenhuma tabela existente alterada (diff de `git show --stat` só adiciona).

**Risco:** os verificadores de contagem falham em cascata se esquecidos. Mitigação: atualizar os
cinco pontos **na mesma PR**, na ordem: migração → bootstrap → `migrations.test.ts` → shell script
→ verificador.

### 5.2 — Contratos, Zod e repositórios

**Entrega:** `packages/shared/src/schemas/tool-grants.ts`; extensão de `contracts.ts`;
`repositories/tool-grants.ts` e `repositories/assistant-preferences.ts`; registro em
`repositories/index.ts`.

**Pronto quando:** `P01-P07` verdes; nenhum `any`; `tsc --noEmit` limpo nos 6 workspaces;
`requireOwnerId` presente nos dois novos repositórios (verificável por teste de fonte, padrão de
`assistant-coupling-guard.test.ts`).

### 5.3 — Política

**Entrega:** `effectiveToolAuthorizationSchema`; `policy.ts` com o passo "catálogo" e o caminho
`effectiveAuthorization`; guarda de `canCoordinate`; `T10-T16`.

**Pronto quando:** `T01-T09` **inalterados** e verdes (prova de não-regressão) + `T10-T16` verdes.

**Dependência:** 5.3 **não** depende de 5.2 para os testes (política é pura), mas depende de 5.1
para o significado de `grant`. Ordem pode ser 5.1 → 5.3 → 5.2 se conveniente, já que 5.3 não toca
banco. Manter 5.1 primeiro.

### 5.4 — API

**Entrega:** `routes/tool-grants.ts`, `routes/assistant-preferences.ts`, `routes/assistant-ref.ts`
(extração de `providers.ts`), 2 registros em `app.ts`, testes `A01-A11`.

**Pronto quando:** as rotas devolvem envelopes corretos, nenhum `ownerId` sai do corpo, `tsc`
limpo, e `providers.ts` continua verde depois da extração (prova de refatoração segura).

### 5.5 — Integração e validação

**Entrega:** integração `resolveAuthorization` + política (chamada de exemplo dentro da transação,
sem wiring no engine), `X01-X09`, `A01-A06` (auditoria), suíte completa, build.

**Pronto quando:** suíte total ≥ 818 + novos; build exit 0; `tsc --noEmit` nos 6; nenhum teste
existente alterado sem justificativa escrita.

**Fora de escopo (explicitamente):** wiring no `CoreEngine`, executor, `tool_confirmations`,
`tool_definitions`, `conversation_settings`.

---

## 13. Critérios de aceite

| # | Critério | Como se prova |
| --- | --- | --- |
| 1 | Catálogo global, autorização pessoal e preferências são estruturas **distintas** | catálogo em código; `tool_grants` (segurança); `user_assistant_preferences` (apresentação) |
| 2 | Nenhuma tabela nova duplica responsabilidade de existente | §4.7: 3 tabelas, 0 sobreposições |
| 3 | Owner A não lê nem altera grant de B | R05 (com owner sintético) + R06 |
| 4 | Grant não habilita ferramenta fora do catálogo | A03 (API) + T14 (política) |
| 5 | Grant não ignora o perfil | T13 + A05 |
| 6 | Ausência de grant → `assistant_not_authorized` | T10 + P02 |
| 7 | Revogação impede novas autorizações | T11 + P03 + X09 |
| 8 | `canCoordinate` não concede ferramentas | T15 + teste de fonte (§7.4) |
| 9 | Assistentes não alteram as próprias permissões | R06/R08 (RLS variante B) |
| 10 | Preferências não ampliam permissões | §4.3: nenhuma coluna de permissão; T16 |
| 11 | API nunca confia em `ownerId` do cliente | A06 + §1.7 (token) |
| 12 | Auditoria é append-only e infalsificável pela aplicação | S06 + R11 + A01-A05 |
| 13 | Personalizado só restringe o global | critérios 4, 5, 6, 7, 10 |
| 14 | Pré-existente permanece intacto | T01-T09 inalterados; suíte ≥ 818; nenhuma migração 00001-00006 alterada |
| 15 | Testes de RLS rodam em PostgreSQL 17 real | `test-postgres-integration.sh`; zero mocks |

---

## 14. Riscos e decisões pendentes

### 14.1 Riscos técnicos

| # | Risco | Probabilidade | Impacto | Mitigação proposta |
| --- | --- | --- | --- | --- |
| R1 | Acesso direto ao banco fora da transação autorizada (bug de aplicação) | baixa | alto | RLS `FORCE` + `requireOwnerId` + variante B para grants |
| R2 | Vazamento entre owners | baixa hoje (singleton), **alta** após multi-owner | crítico | R05 com owner sintético; revisar `configured_owner_id()` na Fase 7 |
| R3 | Confusão identidade assistente × owner | média | alto | actor `assistant` sem escrita; `canCoordinate` fora da política |
| R4 | Corrida em atualização de grants | média | médio | `UNIQUE` + `CHECK` de estado; X01/X02 |
| R5 | Permissão antiga sobrevive à revogação (cache) | média | alto | política lê **dentro** da transação; sem cache nesta fase; X09 |
| R6 | Grant órfão (`nexus.help`) gera diagnóstico confuso | **certa** (D2) | médio | PENDENTE 1 (resolver os 2 órfãos) |
| R7 | Regressão nos verificadores de contagem | **alta** | baixo | atualizar os 5 pontos na mesma PR (§12, 5.1) |
| R8 | `evaluateToolPolicy` divergir de `userAuthorization` legado | média | médio | caminho opcional; T01-T09 como contrato |
| R9 | Duplicação de `buildApiError`/`resolveAssistantRef` (D6) | alta | baixo | extrair na 5.4 |

### 14.2 Decisões pendentes de aprovação

| # | Decisão | Recomendação | Bloqueia |
| --- | --- | --- | --- |
| **1** | O que fazer com `nexus.help` e `technical.system_inspection` (D2) | adicionar as duas ao catálogo como `demonstration_only` **ou** removê-las dos perfis. Recomendo **remover dos perfis** — criar definições no catálogo para ferramentas sem executor amplia a superfície do que parece existir | 5.1 (FK/validação de `tool_id`) |
| **2** | `tool_definitions` (espelho) agora ou na Fase 6 | **adiar** para a Fase 6 | 5.1 (`tool_id` sem FK) |
| **3** | Semântica de "sem grant" | **deny-by-default** (ausência = negado) | 5.3 |
| **4** | Concessão idempotente vs. conflito | **idempotente** (`PUT`), conflito em concessão em massa | 5.2 |
| **5** | `is_default` como coluna ou `default_assistant_id` por owner | **coluna + índice único parcial** | 5.1 |
| **6** | `user_assistant_settings` existe? | **não** — uma tabela `user_assistant_preferences`; verbosidade como coluna (6b: incluir ou adiar) | 5.1 |
| **7** | Novo motivo `tool_not_granted` | **não** — reutilizar `assistant_not_authorized` + `details.reason` | 5.3 |
| **8** | `effectiveAuthorization` substitui ou complementa `userAuthorization` | **complementa** (campo opcional; legado preservado) | 5.3 |
| **9** | Ferramenta fora do catálogo na API: `404` ou `403` | **404 `TOOL_NOT_FOUND`** (simetria com `ASSISTANT_NOT_FOUND`) | 5.4 |
| **10** | Conceder grant para ferramenta que o perfil proíbe | **rejeitar na escrita** (`422`) | 5.4 |
| **11** | `tool_confirmations` | **adiar** para a Fase 6 | 5.1 |

**Nenhuma decisão pendente impede o início da 5.1** se as recomendações 1-6 forem aprovadas.
As decisões 7-10 afetam 5.3/5.4 e podem ser tomadas depois da 5.1.

### 14.3 Débitos registrados (não corrigidos nesta fase)

1. **D3** — `provider_authorizations` e `assistant_/conversation_provider_preferences` têm PK sem
   `owner_id`. Corrigir exige migração com backfill e só faz sentido junto com o fim do singleton
   (Fase 7). **Não** copiar o padrão em tabelas novas.
2. **D6** — `buildApiError` duplicado; extrair quando 5.4 criar a terceira cópia.
3. **D2** — teste de alinhamento unidirecional; tornar bidirecional em 5.5 (§11) ou junto com a
   decisão 1.
4. **D7** — o plano (§6.3) descreve `tool_events` como "a popular"; ela já é populada. Corrigir a
   documentação do plano na fase em que ele for revisado — **não** agora (fora de escopo).

---

## Resumo executivo

**Auditoria (fatos):** a base de G13 é boa e o desenho não precisa ser inventado. RLS `FORCE` com
duas variantes, `withOwnerTransaction` com `set_config` transaction-local, `requireOwnerId` que
deriva o owner do próprio banco, e dois precedentes completos de autorização pessoal
(`provider_authorizations` com trigger de enforcement; `memory_permissions` com
grant/revogação/auditoria) já existem e são exatamente o molde de `tool_grants`.

**Três lacunas reais**, não sete: (1) autorização de ferramenta não é persistida — `evaluateToolPolicy`
recebe a autorização como objeto em memória e, além disso, **nunca é chamada em produção**
(`@nexus/tools` não é dependência de ninguém); (2) preferências pessoais de assistente não existem;
(3) o teste de alinhamento perfil↔catálogo é unidirecional e esconde **dois** `toolId` órfãos
(`nexus.help`, `technical.system_inspection`).

**Proposta:** 3 tabelas novas — `nexus.tool_grants` (com `UNIQUE (owner_id, assistant_id, tool_id)`,
CHECKs de coerência e trigger de escopo imutável), `nexus.tool_grant_audit` (append-only via trigger
`SECURITY DEFINER`) e `nexus.user_assistant_preferences` (PK composta com `owner_id`). **Não** criar
`user_assistant_settings` (sobreposição), `conversation_settings` (sem requisito),
`tool_confirmations` nem `tool_definitions` (sem consumidor antes da Fase 6). Autorização efetiva =
`catálogo ∩ perfil ∩ grant`, deny-by-default, com os 13 motivos de bloqueio existentes preservados.

**Escopo de risco:** 20 tabelas com RLS forçada, 27 tabelas, 7 policies novas, 7 migrações — todos
os verificadores de contagem precisam ser atualizados na mesma PR. Suíte de aceite: PostgreSQL 17
real, 0 mocks, ~55 cenários novos (S, R, C, A, X, P, T, A-API).

**Bloqueios:** 11 decisões pendentes; apenas 6 bloqueiam a 5.1 e todas têm recomendação. Nenhuma
linha de código foi alterada.

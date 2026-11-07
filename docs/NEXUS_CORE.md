# NEXUS CORE — Etapa 3B

Este documento registra as decisões de implementação do NEXUS CORE sobre os contratos já
existentes das Etapas 1, 2A, 2B e 3A. Nada aqui substitui `docs/ARCHITECTURE.md`: o documento
apenas detalha como a orquestração foi materializada sem alterar contratos congelados.

## 1. Superfície HTTP

Todas as rotas exigem sessão `Bearer` válida (`requireAuth`). Sem sessão, a resposta é `401`
com o envelope `apiErrorSchema`; com o CORE não injetado em `buildApp`, a resposta é
`503 CORE_NOT_CONFIGURED`.

| Método e rota | Finalidade |
| --- | --- |
| `GET /v1/conversations` | lista as conversas do proprietário autenticado |
| `POST /v1/conversations` | cria conversa (assistentes opcionais) |
| `GET /v1/conversations/:id` | recupera uma conversa do proprietário |
| `GET /v1/conversations/:id/messages` | histórico ordenado (`afterSequence` opcional) |
| `POST /v1/conversations/:id/messages` | registra a mensagem e executa o CORE (`execute: false` apenas registra) |
| `POST /v1/conversations/:id/executions` | executa o contrato completo `coreExecutionRequestSchema` |
| `GET /v1/conversations/:id/executions` | lista execuções da conversa |
| `GET /v1/executions/:runId` | inspeção com etapas, resultados e execuções filhas |
| `POST /v1/executions/:runId/cancel` | cancela execução em andamento e cascateia para filhas |

## 2. Fluxo de execução

1. Validação do contrato (`coreExecutionRequestSchema`) e resolução do assistente pelo catálogo
   congelado `@nexus/assistant-profiles` (`yui`, `alice`, `schwi`).
2. Admissão transacional curta: conversa ativa do proprietário, assistente participante,
   idempotência, mensagem de entrada e `core_runs` em estado `queued`.
3. Transição para `running` em transação curta.
4. Seleção de provedor/modelo **exclusivamente** pela Etapa 3A (`:free`, zero custo verificado
   antes da chamada, sem fallback pago).
5. Montagem de contexto a partir das mensagens persistidas, dentro do limite do modelo.
6. Chamada real ao provedor **fora** de qualquer transação/lock de banco.
7. Persistência atômica final: mensagem do assistente, resultado, etapa e estado terminal.
8. Falha em qualquer ponto: estado terminal `failed` persistido com `failureCode`, **sem**
   produzir, persistir ou devolver resposta simulada.

Nenhuma transação PostgreSQL permanece aberta durante uma chamada externa.

## 3. Controle de contexto

- Fonte única: mensagens persistidas da conversa exata do proprietário exato.
- Ordem cronológica por `sequence`; nunca histórico ilimitado
  (`maxHistoryMessages`, padrão 40).
- Limite efetivo: `contextWindow` do modelo selecionado, limitado por um teto
  (`maxContextWindowCap`); quando o metadado é ausente/ inválido, usa-se fallback conservador
  de 4 096 unidades e o relatório marca `usedFallbackWindow: true`.
- Reserva de saída: `maxOutputTokens` solicitado, ou reserva padrão de 1 024.
- Mensagens obrigatórias (instruções de sistema + entrada atual) nunca são truncadas: se não
  couberem, a execução falha com `CONTEXT_LIMIT_EXCEEDED`.
- Histórico é reduzido apenas por mensagens inteiras, do mais novo para o mais antigo,
  registrando `includedHistoryCount` / `omittedHistoryCount`.
- Separação estrita: `system` (perfil congelado), mensagens de `user` e de `assistant`.
- Sem memória de longo prazo nesta etapa.

## 4. Delegação

- Somente `yui` é coordenadora; alvos autorizados são `alice` e `schwi`
  (`DELEGATION_TARGETS`).
- A delegação é sempre **estruturada**: envelope `nexus.core.coordination.v1`
  (`coordinatorDecisionEnvelopeSchema`) ou plano explícito
  `delegations[]` (`delegationTaskSpecSchema`). Texto livre nunca é interpretado como comando.
- Validação antes de qualquer chamada de provedor, nesta ordem: ciclo → profundidade →
  autorização → volume.
- Cada filha é uma `core_runs` própria com `parent_run_id`, `parent_step_id` e
  `delegation_depth`, ligada por FK composta à conversa e à etapa pai.
- O resultado da filha retorna ao coordenador como `delegationOutcomeRecordSchema` e alimenta a
  etapa de síntese, onde `yui` responde mantendo sua própria identidade.
- Falha de uma filha é explícita (`PROVIDER_*`/`CORE`), marca a etapa correspondente como
  `failed` e torna a execução raiz `partial` quando há resultados válidos, ou
  `DELEGATED_EXECUTION_FAILED` quando todas falham.

Limites padrão: profundidade 2, 3 delegações por execução, 6 no total.

### 4.1 Lacuna documentada

`delegationTaskSpecSchema` permite `subDelegations`, e o CORE valida profundidade e ciclos
sobre a árvore completa. Como apenas `yui` possui autoridade de coordenação, sub-delegações são
rejeitadas com `DELEGATION_NOT_ALLOWED` na etapa atual; executá-las exigiria conceder
autoridade de coordenação a `alice`/`schwi`, o que alteraria o catálogo congelado de perfis.
A decisão fica registrada e fora do escopo desta etapa.

## 5. Segurança e integridade

- Autenticação obrigatória em todas as rotas; `verifySessionToken` já rejeita `ownerId`
  divergente do proprietário único.
- Propriedade validada no domínio **e** pelo PostgreSQL (`withOwnerTransaction` +
  `set_config(..., true)` + RLS `FORCE`); acesso cruzado retorna `404` sem expor dados.
- `core_runs.idempotency_key` é globalmente única: o CORE deriva a chave como
  `core:<conversationId>:<clientKey>` e grava um `requestFingerprint` (SHA-256) para detectar
  reutilização com payload diferente (`IDEMPOTENCY_CONFLICT`).
- Concidência de envios simultâneos: a inserção perdedora é convertida em
  `EXECUTION_IN_PROGRESS`, sem duplicar mensagens ou execuções.
- Execuções terminais são imutáveis no repositório, no trigger `core_runs_identity_immutable`
  e na superfície da API.
- Segredos são redigidos em mensagens, causas, stacks e detalhes (`redactSecrets`,
  `sanitizeDetailsRecord`); JSONB persistido nunca usa chaves com `token`/`secret`/`key`.
- Rate limiting existente (login e política de provedores) é reutilizado; nenhuma nova
  infraestrutura de autenticação foi criada.

## 5.1 Cancelamento entre instâncias

O cancelamento é autoritativo no **PostgreSQL persistido**, nunca apenas em memória. A
topologia de destino (Vercel/serverless) não garante que `POST /v1/executions/:runId/cancel`
chegue à mesma instância que está executando a chamada ao provedor; por isso
`ExecutionCancellationRegistry` (o `AbortController` em memória) é apenas um atalho local.

- **Autoridade**: `nexus.core_runs.status` é a única fonte de verdade. Uma execução cancelada
  por qualquer instância é observada por todas as demais.
- **`ExecutionCancellationWatcher`** (`apps/server/src/core/cancellation-watcher.ts`): consulta
  o status persistido em leituras curtas e isoladas (transação própria por probe), com
  intervalo padrão de 1 s e coalescência mínima de 250 ms entre probes. Ao ver um estado
  terminal (`succeeded`, `partial`, `failed`, `cancelled`) aborta o `AbortController` local.
  Erros de probe são registrados no log e **nunca** abortam a execução. Os timers são
  `unref()`, então não seguram o processo.
- **Antes das fronteiras externas**: a execução relê o estado persistido antes da chamada
  primária ao provedor, antes da síntese e antes de cada chamada de filha delegada
  (`assertNotCancelled`); um run cancelado falha com `EXECUTION_CANCELLED` e nenhuma resposta
  é produzida.
- **Durante a chamada**: quando o adaptador aceita `AbortSignal`, o sinal entregue é
  `AbortSignal.any([callerSignal, timeoutSignal, persistedSignal])`, de modo que a chamada é
  interrompida assim que o cancelamento persistido é detectado — sem esperar o timeout.
- **Antes de persistir resultados**: `completeRootExecution` e a finalização de filhas tomam
  o lock da linha (`getStatusForUpdate`) e, dentro da mesma transação, rejeitam `cancelled`
  (`EXECUTION_CANCELLED`) e qualquer status fora de `running`/`queued`
  (`EXECUTION_ALREADY_TERMINAL`). Um run cancelado nunca termina como `succeeded`/`partial`.
- **Conflito de escrita**: se o cancelamento vencer entre a leitura e a escrita
  (transição para `running`, marcação de etapa ou finalização), o repositório rejeita a
  escrita imutável e o engine reconcilia a falha com o estado persistido, devolvendo
  `EXECUTION_CANCELLED` em vez de um erro opaco de persistência.
- **Cascata**: `cancel()` percorre os descendentes em largura sobre `parent_run_id`
  (`cancelDescendants`, com guarda de ciclo) e marca as filhas ativas com
  `cancellationSource: "parent"` na mesma transação. Como o estado é persistido, a instância
  que executa a filha observa o cancelamento e aborta a própria chamada.
- **Nunca segurar transação/lock durante polling ou chamadas externas**: cada probe e cada
  leitura de status usam sua própria transação curta; nenhuma transação envolve
  `adapter.generate()`.
- **Idempotência**: recancelar um run terminal responde `EXECUTION_ALREADY_TERMINAL`; o
  cancelamento repetido não sobrescreve estado terminal.

Testes dedicados: `apps/server/src/core/cancellation-cross-instance.test.ts` (duas instâncias
com registries independentes compartilhando só o banco em memória) e
`apps/server/src/core/cancellation.postgres.integration.test.ts` (duas instâncias com pools
próprios contra PostgreSQL 17, incluindo corrida cancelamento × finalização).

## 6. Migração `00004_core_execution_hierarchy.sql`

Aditiva e aplicada sobre `00001`–`00003` sem reescrevê-las:

- colunas `parent_run_id`, `parent_step_id`, `delegation_depth` (default `0`);
- FK composta `core_runs_parent_run_same_conversation_fk` (mesma conversa do pai);
- FK composta `core_runs_parent_step_same_parent_run_fk` (etapa pertence ao pai);
- check `core_runs_delegation_hierarchy_valid` (linhagem coerente ou ausente);
- índice parcial `core_runs_by_parent_run_idx`;
- trigger `core_runs_identity_immutable` para linhagem/identidade.

As contagens verificadas por `bootstrap.sql` (tabelas, políticas, índices nomeados e RLS)
permanecem intactas porque nenhuma tabela ou política nova é criada.

## 7. Testes

- `apps/server/src/core/engine.test.ts`: cenários 1–20 (execução normal, três assistentes,
  contexto, isolamento, seleção, bloqueio pago/não verificável, timeout/falha, cancelamento,
  persistência, delegação ALICE/SCHWI, retorno ao coordenador, falha de filha, ciclo,
  profundidade, contagem, concorrência/deduplicação, acesso cruzado, falha de persistência e
  ausência de resposta fictícia).
- `apps/server/src/routes/core.test.ts`: E2E HTTP com Fastify e provedor mockado.
- `apps/server/src/core/{context-builder,delegation,errors,cancellation-registry}.test.ts`.
- `apps/server/src/core/engine.postgres.integration.test.ts`: fluxo real contra PostgreSQL 17.11.
- `apps/server/src/core/cancellation-cross-instance.test.ts`: cancelamento observado por outra
  instância, checagem persistida antes da chamada, cascata pai→filha e corrida
  cancelamento × finalização (registries independentes).
- `apps/server/src/core/cancellation.postgres.integration.test.ts`: as mesmas garantias com
  dois pools reais contra PostgreSQL 17.11, executado no CI em
  `.github/workflows/database-postgres.yml`.
- `packages/database/src/postgres/repositories.integration.test.ts`: linhagem, cancelamento e
  listagens no banco real.

Nenhum teste realiza chamadas reais ou pagas ao OpenRouter.

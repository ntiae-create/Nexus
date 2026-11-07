# Chat no aplicativo móvel (Etapa 3C.2)

Esta etapa transforma a tela autenticada provisória da 3C.1 em um cliente de conversa
funcional sobre o **NEXUS CORE** já existente (Etapa 3B). Nada do backend foi alterado:
nenhum contrato, rota, tabela, provedor, perfil ou regra de execução mudou. O aplicativo
consome exclusivamente a superfície HTTP documentada em [`NEXUS_CORE.md`](NEXUS_CORE.md).

## 1. Princípio central: o servidor é a única fonte de verdade

O cliente **não simula** nada:

- nenhuma bolha de mensagem é desenhada antes de o servidor devolvê-la;
- nenhuma resposta de assistente é gerada localmente — a bolha do assistente sempre vem de
  um `Message` persistido com `role: "assistant"`;
- quando a execução falha, o app mostra o estado real (`failed`, `cancelled`, `partial`) e
  **não** inventa texto substituto;
- quando um envio termina de forma ambígua (conexão perdida), o app diz que não conseguiu
  confirmar, em vez de afirmar que a mensagem foi entregue.

Consequência de projeto: a tela mantém uma cópia do histórico só para renderização. Toda
mutação (criar conversa, enviar mensagem, cancelar) passa pelo servidor primeiro.

## 2. Camadas

| Módulo | Arquivo | Responsabilidade |
| --- | --- | --- |
| Catálogo de assistentes | `src/lib/assistants.ts` | Espelho somente-leitura do catálogo congelado (`yui`, `alice`, `schwi`): chave, UUID canônico, nome. Não decide delegação. |
| Identificadores | `src/lib/ids.ts` | `requestId` (UUID v4) e `idempotencyKey` estável por mensagem. |
| Cliente HTTP | `src/services/api-client.ts` | *(inalterado)* Único ponto de `fetch`, Bearer, timeout, `ApiError`. |
| Serviço do CORE | `src/services/core-service.ts` | Mapeia as 9 rotas do CORE, valida cada corpo com os schemas Zod de `@nexus/shared`. |
| Serviço de execução | `src/services/execution-service.ts` | Envio, acompanhamento por polling, estados terminais, cancelamento, recuperação por `requestId`. |
| Serviço de conversas | `src/services/conversation-service.ts` | Listagem, criação, histórico, sessão de chat e tradução de erros para texto de UI. |
| Montagem | `src/lib/auth/bootstrap.ts` | Expõe `createConversationService(token)` no container da aplicação. |
| Navegação | `src/App.tsx` | Lista ⇄ chat; fecha o chat quando a sessão termina. |
| Tela de conversas | `src/screens/HomeScreen.tsx` | Lista, criação, refresh, estados de carregamento/vazio/erro, logout. |
| Tela de chat | `src/screens/ChatScreen.tsx` | Histórico, seleção de assistente, envio, processamento, cancelamento, erros. |
| Componentes | `src/components/MessageBubble.tsx`, `src/components/ChatComposer.tsx` | Bolha de mensagem persistida e campo multilinha com envio explícito. |

## 3. Contratos usados (sem alteração)

| Operação | Rota | Uso no app |
| --- | --- | --- |
| Listar conversas | `GET /v1/conversations` | Tela inicial; recarrega após criar. |
| Criar conversa | `POST /v1/conversations` | Envia somente `{ assistantIds: [uuid] }`. |
| Abrir conversa | `GET /v1/conversations/:id` | Reserva (a lista já traz o objeto completo). |
| Histórico | `GET /v1/conversations/:id/messages` | Fonte do histórico ao abrir e após cada envio. |
| Enviar mensagem | `POST /v1/conversations/:id/messages` | `{ content, requestId, idempotencyKey, assistantKey }`. |
| Listar execuções | `GET /v1/conversations/:id/executions` | Descoberta do run de um envio em andamento. |
| Inspecionar execução | `GET /v1/executions/:runId` | Polling de estado durante o processamento. |
| Cancelar execução | `POST /v1/executions/:runId/cancel` | Botão "Cancelar execução". |

Detalhes que o app respeita:

- `assistantKey` é exatamente `"yui" | "alice" | "schwi"` (`initialAssistantKeySchema`), e
  `assistantIds` na criação usa os UUIDs canônicos semeados por `00001_initial_schema.sql`,
  porque o CORE rejeita com `ASSISTANT_NOT_IN_CONVERSATION` quem não participa da conversa.
- `coreExecutionInspectionSchema` **não** contém mensagens. Por isso a resposta do assistente
  é lida no histórico persistido e casada por `execution.finalMessageId`. Se o run não tem
  `finalMessageId` (caso de `failed`/`cancelled`), nenhuma bolha é criada.
- `coreExecutionResponseSchema` (retorno do `POST .../messages`) traz `inputMessage` e
  `assistantMessage` já persistidos; esses objetos são usados como fallback caso a
  recarga do histórico falhe.

## 4. Fluxo de criação de conversa

1. O usuário escolhe YUI, ALICE ou SCHWI (os três únicos valores aceitos pelo contrato) e
   toca em "Nova conversa com …".
2. `createConversation({ assistantIds: [uuid] })` → `201 { conversation }`.
3. A lista é recarregada de `GET /v1/conversations` (nada é inserido localmente).
4. A conversa criada é aberta usando o **id atribuído pelo servidor**.
5. Em caso de erro (`503 CORE_NOT_CONFIGURED`, rede, `401`), a mensagem aparece no cartão de
   criação e nenhuma conversa é aberta.

## 5. Envio de mensagem

```
draft (trim) ──▶ PendingSend { requestId, idempotencyKey, assistantKey, text }
                       │
                       ▼
     POST /v1/conversations/:id/messages  (timeout de 90 s)
                       │
        ┌──────────────┴───────────────┐
        │ 201/200 com execução          │ erro
        ▼                               ▼
 assistantMessage persistido     rede/EXECUTION_IN_PROGRESS?
        │                               │ sim → recuperar por requestId
        ▼                               ▼
 GET .../messages (recarga)      GET .../executions → achar run
        │                               │
        ▼                               ▼
   render do histórico         GET /v1/executions/:runId (polling)
```

Regras aplicadas:

- **`requestId`** é gerado uma vez por mensagem e reutilizado em toda tentativa daquela
  mensagem; é o identificador de correlação que o servidor persiste no run.
- **`idempotencyKey`** também é única por mensagem (`msg:<uuid>`, ≤ 200 caracteres) e nunca é
  reaproveitada para outro texto: o CORE responde `IDEMPOTENCY_CONFLICT` se a mesma chave
  chegar com conteúdo diferente (`requestFingerprint` SHA-256).
- O texto é enviado com `trim`; rascunhos vazios ou só com espaços não são enviados.
- O `assistantKey` é sempre o do assistente selecionado entre os que participam da conversa;
  o app **nunca** envia `delegations` — delegação YUI → ALICE/SCHWI é decisão exclusiva do CORE.
- Nenhum campo de provedor, modelo ou preço é enviado pelo cliente; a política `:free` continua
  inteiramente no backend.
- **Ciclo de vida do rascunho**: o campo é limpo apenas quando o servidor já consumiu o texto
  (`delivered`, `failed` ou `cancelled`). Em `rejected`/`unknown` o rascunho permanece, porque
  nada foi persistido ou não há confirmação. Rascunhos nunca são limpos "otimisticamente".
- **Trava de concorrência**: o envio é bloqueado somente enquanto o `POST` está em voo
  (`sending !== null`). Uma execução que está apenas sendo acompanhada — inclusive uma
  recuperada ao reabrir — **não** trava o composer: o servidor aceita uma nova mensagem e o
  usuário não foi convidado a esperar.

## 6. Descoberta do run e acompanhamento

O `POST .../messages` só responde ao final da execução, então o `runId` necessário para
cancelar não existe no cliente enquanto o CORE trabalha. O app separa dois ciclos, com no
máximo **um de cada por vez**:

1. **Descoberta** — `GET /v1/conversations/:id/executions` procurando o run cujo `requestId`
   é exatamente o da mensagem enviada. Nenhum id de run é derivado, hasheado ou inventado no
   cliente.
2. **Acompanhamento** — `GET /v1/executions/:runId` com atrasos crescentes
   (`400, 800, 1200, 1600, 2000, 2500, 3000` ms, teto de 40 tentativas), iniciado pela
   descoberta ou pela recuperação ao reabrir.

### Política de descoberta

| Aspecto | Comportamento |
| --- | --- |
| Limite com sinal | **Não existe teto de tentativas.** Quem limita é exclusivamente o **tempo de vida do envio** (`AbortSignal` do `POST`): a descoberta vive enquanto o POST estiver pendente, por mais probes bem-sucedidas que passem. |
| Limite sem sinal | Sem `AbortSignal` não há ciclo de vida a observar, então vale o orçamento conservador `DEFAULT_DISCOVERY_ATTEMPTS = 8` probes bem-sucedidas. Esse valor **nunca** é aplicado quando há sinal. |
| `maxAttempts` | Override explícito de quem chama (usado em teste). Não é definido pela tela. |
| Falhas transitórias | Até 5 falhas **consecutivas** (rede/`5xx`) são toleradas e o contador zera a cada sucesso; elas não consomem o orçamento de probes bem-sucedidas. Um `401` encerra como `unavailable` e devolve o usuário ao login. |
| Concorrência | Uma probe por vez (`await`), sempre. Um servidor lento nunca empilha requisições duplicadas. |
| Encerramento | Termina quando: encontra o run pelo `requestId`; o POST termina e aborta a descoberta (`discovery.abort()` no `finally` do send); a tela desmonta; a conversa troca; a sessão expira; ou as falhas transitórias excedem o orçamento. **Nenhum desses caminhos é contagem de probes bem-sucedidas.** |
| Resultado | `found` (run real do servidor), `aborted` (cancelado localmente — nada se conclui sobre o run) ou `unavailable` (o estado não pôde ser lido — falhas de transporte ou `401`; a UI diz isso e oferece atualizar). Nunca confunde abort local com "run inexistente". |
| Timers e listeners | `waitForDelay` sempre limpa o `setTimeout` e remove o listener de `abort`, inclusive no caminho feliz — nenhum timer ou listener abandonado por probe. |

Quando a lista já contém o run, `onProbe` publica o id **real** na tela imediatamente, e é
isso que faz o botão de cancelar aparecer no instante em que o servidor expõe a execução.

### Garantias do acompanhamento

- a consulta **para no primeiro estado terminal** (`succeeded`, `partial`, `failed`, `cancelled`);
- erros transitórios são tolerados até 4 probes consecutivas; `401` interrompe na hora e volta
  ao login;
- cada ciclo (`send`, `discovery`, `tracking`, `history`, `recovery`, `cancel`) tem seu próprio
  `AbortController`, todos abortados no unmount;
- toda continuação depois de um `await` valida `mounted` **e** o id da conversa antes de tocar
  no estado, então uma resposta atrasada não escreve na tela errada;
- a taxa é limitada pelo backoff — não há laço apertado, requisição concorrente nem streaming
  inventado.

## 7. Estados apresentados

| Estado do run | O que a tela mostra |
| --- | --- |
| `queued` / `running` | Indicador "O NEXUS CORE está processando esta mensagem." + botão Cancelar (quando o run já é conhecido). |
| `succeeded` | Resposta persistida do assistente, autor e horário reais. |
| `partial` | A resposta persistida, com o selo `partial` que veio em `metadata.runStatus`. |
| `failed` | Bloco de erro com `failureCode` persistido (ex.: `PROVIDER_TIMEOUT`) e nenhuma bolha de assistente. |
| `cancelled` | Nenhuma resposta; o histórico é recarregado e o indicador desaparece. |
| ambíguo | "Não foi possível confirmar o envio/estado. Reabra a conversa antes de reenviar." |
| recuperado | O mesmo indicador de progresso, com a nota "Execução em andamento recuperada do servidor ao reabrir a conversa." e botão Cancelar. |
| `401` | Volta ao login e limpa o token armazenado. |

O código exato do erro é exibido apenas quando vem do contrato (`coreExecutionErrorCodeSchema`
ou `PROVIDER_*`); mensagens internas do servidor nunca são ecoadas.

## 8. Cancelamento

1. O botão aparece quando o run real foi descoberto por `requestId` (ou recuperado ao reabrir).
   Antes disso a tela só informa "Enviando ao NEXUS CORE…" — ela não inventa um id.
2. `POST /v1/executions/:runId/cancel` — a autoridade é o PostgreSQL do CORE, não o app.
3. O clique tem trava própria: um `AbortController` de cancelamento, o botão desabilitado e o
   rótulo "Cancelando…" enquanto a requisição está em voo. Duplo toque não gera duas chamadas.
4. **Cancelar não abre segundo laço.** Se já existe um acompanhamento vivo para aquele run, ele
   é quem observa o estado terminal; a decisão é tomada *antes* do `await`, porque o laço pode
   terminar durante o cancelamento. Só o caso órfão (run conhecido, sem laço) faz um `follow`.
5. `EXECUTION_ALREADY_TERMINAL` / `EXECUTION_CANCELLED` não são tratados como falha: a execução
   apenas terminou antes, e a tela informa isso.
6. Falha do cancelamento **não** é mascarada: a mensagem de erro aparece, a execução continua
   marcada como em andamento e nenhum estado terminal é inventado.
7. **Abortar localmente ≠ cancelar no servidor.** Desmontar a tela ou trocar de conversa apenas
   para o polling local; a execução continua no CORE e será recuperada na próxima visita.

## 9. Persistência e recuperação ao reabrir

- O histórico vem sempre de `GET .../messages`. Fechar e reabrir (ou reiniciar o app) mostra
  exatamente o que o servidor guardou — `ChatScreen` não tem cache próprio.
- Após um envio, a recarga do histórico é a fonte de renderização. Se essa recarga falhar, o
  app usa os objetos já devolvidos pelo `POST` (`inputMessage`/`assistantMessage`), que também
  são persistidos; nada é perdido nem inventado.

### Execução iniciada antes de sair da tela

Cenário real: o usuário envia, o provedor ainda está trabalhando e ele sai da conversa (ou o
app é suspenso). O `POST` local é abortado, mas a execução **continua no CORE**. Ao reabrir:

1. a tela carrega o histórico persistido; com histórico não vazio, faz **uma** consulta a
   `GET /v1/conversations/:id/executions`;
2. os runs são filtrados com o vocabulário do schema compartilhado — permanecem apenas
   `queued`/`running` (`activeRuns()`, usando `isTerminalRunStatus`);
3. havendo execução ativa, a tela restaura o estado de processamento e passa a acompanhar
   aquele `runId` real, com botão Cancelar disponível;
4. ao chegar ao estado terminal, o histórico é recarregado e a resposta exibida é a
   **persistida** — nunca uma mensagem otimista;
5. **nada é reenviado**: a recuperação só lê e observa. Nenhum `POST .../messages` é feito, e
   nenhuma segunda execução é criada para "buscar" a primeira.

Contrato usado: o CORE grava `core_run_id` em `messages` apenas via `appendAssistant`, e a
mensagem do usuário tem `runId = null`; a correlação entre mensagem e execução é feita pelo
`requestId` do run. Por isso a recuperação parte da lista de execuções, e não do histórico.

Múltiplas execuções ativas: a tela segue a **mais antiga** (ordem do servidor,
`created_at ASC, id ASC`), que é a única ordem determinística que o contrato oferece, e diz
que a execução foi recuperada do servidor. Ela não escolhe arbitrariamente, não mescla duas
execuções em um estado e não inventa eventos.

Se a consulta falhar, a tela **não** afirma que não há execução: mostra "não foi possível
confirmar" com ação de verificar novamente. Um `401` volta ao login. Não há recuperação em
segundo plano: o app não finge suporte a background que o contrato não oferece.

## 10. Falhas, isolamento e idempotência

- **Sem fallback de sucesso falso**: qualquer caminho que não tenha confirmação do servidor
  termina em `unknown` (aviso + recarga manual), jamais em mensagem "enviada".
- **Sem duplicação**: além da chave idempotente, a tela tem um travamento de submissão
  (`submitLock`) que ignora submissões concorrentes, e o botão/composer ficam desabilitados
  durante o envio.
- **Isolamento de proprietário**: todas as chamadas levam o Bearer da sessão atual; o
  servidor valida o dono em todas as rotas (`404` para conversas de outro dono). O app não
  faz nenhuma consulta sem token e exibe apenas o que o backend devolveu.
- **Segredos**: o token vive apenas na sessão em memória e no armazenamento seguro já existente
  (3C.1); não é renderizado, registrado nem incluído em mensagens de erro.

## 11. Interface

- Tema grafite/preto (`#0b0b0f`) com superfícies discretas, acentos violeta/azul.
- Bolhas distintas: usuário à direita (violeta), assistente à esquerda (grafite), com autor
  e horário.
- Composer multilinha (`textarea`) com altura limitada, botão "Enviar" e `Ctrl/Cmd+Enter`
  como atalho; `Enter` continua sendo quebra de linha, o que importa no teclado do Android.
- Alvos de toque ≥ 44 px; `aria-checked` nos botões de assistente; lista de mensagens com
  `aria-label`; estados anunciados com `role="status"`/`role="alert"`.
- Auto-scroll só acontece quando o usuário está no fim da conversa; se ele rolou para cima,
  novas mensagens não puxam a tela.
- Layout com `100dvh` e `env(safe-area-inset-*)`, então o teclado do Android não esconde o
  campo de texto nem o botão de enviar.

## 12. Testes

Arquivos (nenhum teste existente foi removido ou enfraquecido):

| Arquivo | Cobertura |
| --- | --- |
| `src/services/core-service.test.ts` | 9 rotas, envelopes, validação Zod, Bearer, ids, timeouts, erros do contrato. |
| `src/services/execution-service.test.ts` | Estados terminais, backoff, `succeeded`/`partial`/`failed`/`cancelled`, erros transitórios, `401`, abort, cancelamento, recuperação. |
| `src/services/conversation-service.test.ts` | Listagem/criação/histórico, envio, idempotência, recuperação por `requestId`, tradução de erros, descoberta (abort, concorrência, backoff, **250 probes bem-sucedidas sem teto** com sinal e orçamento de 8 sem sinal) e `activeRuns()`. |
| `src/lib/assistants.test.ts` | Espelho do catálogo conferido contra `catalog.ts` e a migração `00001`. |
| `src/screens/HomeScreen.test.tsx` | Estados de lista, criação com cada assistente, refresh, logout, sem exclusão. |
| `src/screens/ChatScreen.test.tsx` | Histórico, seleção, envio, trava de duplicidade, `partial`/`failed`/`cancelled`, cancelamento, sessão expirada. |
| `src/screens/chat-recovery.test.tsx` | **Auditoria corretiva**: descoberta pelo serviço real (run admitido depois de 8 probes, **run admitido depois de 250 probes** pela própria tela, parada no fim do envio, parada no unmount, id real exposto), recuperação ao reabrir, `succeeded`/`partial`/`failed`/`cancelled`, nenhum reenvio, dois runs ativos, laço único, troca rápida de conversa, sessão expirada e rede fora durante a recuperação, ausência de `setState` após unmount. |
| `src/chat-flow.test.tsx` | Fluxo completo pelo `App` real com `fetch` mockado: criar, conversar, reabrir, recuperar, cancelar, sair. |

`chat-recovery.test.tsx` monta `createConversationService` sobre um `CoreService` dublê, então
o laço de descoberta, o backoff e os `AbortSignal` exercitados são os de produção — a tela é
apenas a orquestração sobre eles. `ChatScreen.test.tsx` mantém o dublê de `ChatSession` para
isolar comportamento de interface.

Mocks controlados apenas: `fetchImpl` injetado e dublês de `CoreService`. **Nenhum teste faz
chamada real a provedor ou a OpenRouter.** Todas as fixtures vêm dos schemas compartilhados
(`test-support/core-fixtures.ts`); nenhum formato é inventado no teste.

Os testes de integração PostgreSQL (`*.integration.test.ts`, 28 casos) exigem
`NEXUS_DATABASE_URL` e por isso aparecem como *skipped* fora do workflow dedicado.

## 13. Limitações desta etapa

- **Sem exclusão de conversa**: o backend não expõe rota de exclusão; o app não oferece o
  botão. A listagem já filtra `status !== "deleted"`.
- **Sem streaming**: o contrato não tem SSE/WebSocket; o acompanhamento é polling limitado.
- **Cancelamento depende de descoberta**: enquanto o servidor não lista o run, a tela não tem
  id para cancelar e mostra apenas "processando" — nada é inventado no cliente. A descoberta
  não é mais limitada por número fixo de tentativas enquanto o envio está pendente, então o
  botão aparece assim que o CORE expõe a execução, mesmo num enfileiramento lento.
- **Sem cancelamento em segundo plano**: se o app for encerrado, o polling local morre. A
  execução continua no CORE e é recuperada na próxima abertura da conversa (com cancelamento
  disponível de novo); não há trabalho em background após o processo morrer.
- **Várias execuções ativas**: o contrato não oferece um "run atual" por conversa; a tela segue
  a mais antiga e informa a origem. Ela não soma, mescla nem escolhe por conta própria.
- **Sem título automático**: a conversa fica "Conversa sem título" até existir um resumo
  gerado pelo backend; o app não inventa título a partir do texto local.
- **Sem token refresh**: mantido o comportamento da 3C.1; sessão expirada volta ao login.
- **Um assistente por conversa na criação**: `POST /v1/conversations` aceita vários, mas o app
  cria com o assistente escolhido. Conversas antigas com vários participantes mostram o
  seletor apenas com os que estão no catálogo.

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

## 6. Acompanhamento de execução (polling)

O `POST .../messages` só responde ao final da execução. Para que o usuário veja progresso e
possa cancelar, o app faz duas coisas em paralelo:

1. **Descoberta** — `GET /v1/conversations/:id/executions` até encontrar o run cujo
   `requestId` é o da mensagem enviada (8 tentativas, 400 ms → 3 s). Nenhum id de run é
   derivado no cliente.
2. **Acompanhamento** — quando o envio se recupera de falha ambígua, `GET /v1/executions/:runId`
   com atrasos crescentes (`400, 800, 1200, 1600, 2000, 2500, 3000` ms, teto de 40 tentativas).

Garantias:

- a consulta **para no primeiro estado terminal** (`succeeded`, `partial`, `failed`, `cancelled`);
- erros transitórios (rede, `5xx`) são tolerados até 4 probes consecutivos; `401` interrompe
  imediatamente e devolve o usuário ao login;
- cada envio tem seu próprio `AbortController`, abortado no unmount da tela, então nenhuma
  requisição ou timer sobrevive à navegação;
- a taxa é limitada pelo backoff — não há laço apertado nem streaming inventado.

## 7. Estados apresentados

| Estado do run | O que a tela mostra |
| --- | --- |
| `queued` / `running` | Indicador "O NEXUS CORE está processando esta mensagem." + botão Cancelar (quando o run já é conhecido). |
| `succeeded` | Resposta persistida do assistente, autor e horário reais. |
| `partial` | A resposta persistida, com o selo `partial` que veio em `metadata.runStatus`. |
| `failed` | Bloco de erro com `failureCode` persistido (ex.: `PROVIDER_TIMEOUT`) e nenhuma bolha de assistente. |
| `cancelled` | Nenhuma resposta; o histórico é recarregado e o indicador desaparece. |
| ambíguo | "Não foi possível confirmar o envio/estado. Reabra a conversa antes de reenviar." |
| `401` | Volta ao login e limpa o token armazenado. |

O código exato do erro é exibido apenas quando vem do contrato (`coreExecutionErrorCodeSchema`
ou `PROVIDER_*`); mensagens internas do servidor nunca são ecoadas.

## 8. Cancelamento

1. O botão aparece quando o run foi descoberto por `requestId`.
2. `POST /v1/executions/:runId/cancel` — autoridade é o PostgreSQL do CORE, não o app.
3. `EXECUTION_ALREADY_TERMINAL` / `EXECUTION_CANCELLED` não são tratados como falha: a
   execução apenas terminou antes, e o histórico é recarregado.
4. Depois do cancelamento o app segue o run até o estado terminal e recarrega o histórico,
   garantindo que nada seja "cancelado" apenas na UI.

## 9. Persistência e recuperação ao reabrir

- O histórico vem sempre de `GET .../messages`. Fechar e reabrir (ou reiniciar o app) mostra
  exatamente o que o servidor guardou — `ChatScreen` não tem cache próprio.
- Após um envio, a recarga do histórico é a fonte de renderização. Se essa recarga falhar, o
  app usa os objetos já devolvidos pelo `POST` (`inputMessage`/`assistantMessage`), que também
  são persistidos; nada é perdido nem inventado.
- Se o reload falhar depois de um polling de sucesso, o resultado aparece como "não foi
  possível carregar o histórico" com ação de atualizar — nunca como resposta inexistente.

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

Arquivos novos (nenhum teste existente foi removido ou enfraquecido):

| Arquivo | Cobertura |
| --- | --- |
| `src/services/core-service.test.ts` | 9 rotas, envelopes, validação Zod, Bearer, ids, timeouts, erros do contrato. |
| `src/services/execution-service.test.ts` | Estados terminais, backoff, `succeeded`/`partial`/`failed`/`cancelled`, erros transitórios, `401`, abort, cancelamento, recuperação. |
| `src/services/conversation-service.test.ts` | Listagem/criação/histórico, envio, idempotência, recuperação por `requestId`, tradução de erros. |
| `src/lib/assistants.test.ts` | Espelho do catálogo conferido contra `catalog.ts` e a migração `00001`. |
| `src/screens/HomeScreen.test.tsx` | Estados de lista, criação com cada assistente, refresh, logout, sem exclusão. |
| `src/screens/ChatScreen.test.tsx` | Histórico, seleção, envio, trava de duplicidade, `partial`/`failed`/`cancelled`, cancelamento, sessão expirada. |
| `src/chat-flow.test.tsx` | Fluxo completo pelo `App` real com `fetch` mockado: criar, conversar, reabrir, recuperar, cancelar, sair. |

Mocks controlados apenas: `fetchImpl` injetado e dublês de `CoreService`. **Nenhum teste faz
chamada real a provedor ou a OpenRouter.**

## 13. Limitações desta etapa

- **Sem exclusão de conversa**: o backend não expõe rota de exclusão; o app não oferece o
  botão. A listagem já filtra `status !== "deleted"`.
- **Sem streaming**: o contrato não tem SSE/WebSocket; o acompanhamento é polling limitado.
- **Cancelamento depende de descoberta**: enquanto o `POST` não retorna e a lista de execuções
  não mostra o run, o botão de cancelar aparece apenas como "processando". O estado chega em
  poucos segundos, porque o CORE persiste o run antes de chamar o provedor.
- **Sem título automático**: a conversa fica "Conversa sem título" até existir um resumo
  gerado pelo backend; o app não inventa título a partir do texto local.
- **Sem token refresh**: mantido o comportamento da 3C.1; sessão expirada volta ao login.
- **Um assistente por conversa na criação**: `POST /v1/conversations` aceita vários, mas o app
  cria com o assistente escolhido. Conversas antigas com vários participantes mostram o
  seletor apenas com os que estão no catálogo.

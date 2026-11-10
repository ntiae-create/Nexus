/**
 * @vitest-environment happy-dom
 *
 * End-to-end app flow for Etapa 3C.2, driven through the real React tree, the real session
 * manager, the real HTTP client and the real CORE services — only `fetch` is mocked.
 *
 * This is the test that proves the wiring (bootstrap container → service → screen → wire
 * contract) rather than each unit in isolation. No real backend and no provider is involved:
 * every response is a fixture matching `packages/shared/src/schemas/*`.
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
  registerPlugin: vi.fn(() => ({
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  })),
}));

const preferencesStore = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: preferencesStore.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      preferencesStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferencesStore.delete(key);
    }),
  },
}));

const { default: App } = await import("./App.js");
const { createSessionManager } = await import("./lib/auth/session-manager.js");
const { createAuthService } = await import("./services/auth-service.js");
const { createApiClient } = await import("./services/api-client.js");
const { createCoreService } = await import("./services/core-service.js");
const { createConversationService } = await import("./services/conversation-service.js");
const { createMemoryStorage } = await import("./test-support/fakes.js");
const { TEST_BASE_URL, TEST_TOKEN, TEST_OWNER_ID } = await import("./test-support/fakes.js");
const fixtures = await import("./test-support/core-fixtures.js");

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (host: HTMLElement) => host.textContent ?? "";

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for UI state");
    await act(async () => {
      await wait(10);
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Request = { url: string; init: RequestInit; body: Record<string, unknown> | undefined };
type Handler = (request: Request) => Response | Promise<Response>;

const mePayload = {
  owner: { userId: TEST_OWNER_ID },
  session: {
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
};

/**
 * Router keyed by `METHOD path`, with the path template already containing the real ids.
 * Unmatched requests return 404 so a test can never accidentally pass on a stray call.
 */
function makeApp(handlers: Record<string, Handler>, initialToken: string | null = TEST_TOKEN) {
  const calls: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const request: Request = { url, init: init ?? {}, body };
    calls.push(request);
    const parsed = new URL(url);
    const key = `${init?.method ?? "GET"} ${parsed.pathname}`;
    const handler = handlers[key];
    if (!handler) {
      return json(404, {
        error: { code: "NOT_FOUND", message: `no handler for ${key}`, retryable: false },
        timestamp: new Date().toISOString(),
      });
    }
    return handler(request);
  }) as unknown as typeof fetch;

  const storage = createMemoryStorage({ initial: initialToken });
  const client = createApiClient({ getBaseUrl: () => TEST_BASE_URL, fetchImpl });
  const sessionManager = createSessionManager({
    authService: createAuthService(client),
    storage,
  });
  const coreService = createCoreService(client);

  const container = {
    sessionManager,
    storage,
    apiBaseUrl: TEST_BASE_URL,
    configureApiBaseUrl: async () => ({ ok: true }),
    apiClient: client,
    createConversationService: (token: string) =>
      createConversationService({ service: coreService, token }),
    // Fase 2: o app busca o catálogo do servidor ao entrar. Nestes testes a chamada não é o
    // objeto de interesse e devolve `unavailable`, mantendo o fallback de build.
    loadAssistantCatalog: async () => ({ status: "unavailable" as const }),
  };

  return { calls, container, storage };
}

function renderApp(container: Parameters<typeof App>[0]["container"]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(App, { container }));
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/**
 * Clicks the last matching button.
 *
 * "Last" matters: a conversation named "Conversa sem título" also appears in the assistant
 * selector and in the create button ("Nova conversa com ALICE"), so the smallest, most
 * specific control is not always the first match in document order.
 */
function clickByText(host: HTMLElement, needle: string, index = -1) {
  const matches = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) =>
    (candidate.textContent ?? "").includes(needle),
  );
  const button = index < 0 ? matches[matches.length - 1] : matches[index];
  if (!button) throw new Error(`no button containing "${needle}" (found ${matches.length})`);
  act(() => button.click());
  return button;
}

function typeMessage(host: HTMLElement, value: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>("#chat-message-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitComposer(host: HTMLElement) {
  act(() => {
    host
      .querySelector<HTMLFormElement>(".composer")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const conversationsPath = "/v1/conversations";
const messagesPath = `/v1/conversations/${fixtures.CONVERSATION_ID}/messages`;
const conversationPath = `/v1/conversations/${fixtures.CONVERSATION_ID}`;
const executionsPath = `/v1/conversations/${fixtures.CONVERSATION_ID}/executions`;
const runPath = `/v1/executions/${fixtures.RUN_ID}`;
/** Single active conversation used by the execution-state scenarios. */
const conversation = fixtures.makeConversation();

/** Standard authenticated app with an empty inbox. */
function baseHandlers(overrides: Record<string, Handler> = {}) {
  return {
    "GET /v1/auth/me": () => json(200, mePayload),
    "GET /v1/auth/logout": () => json(200, { ok: true }),
    "GET /v1/conversations": () => json(200, { conversations: [] }),
    ...overrides,
  } as Record<string, Handler>;
}

describe("3C.2 — create conversation and talk to YUI", () => {
  it("creates a conversation, opens it and shows the real CORE reply", async () => {
    const conversation = fixtures.makeConversation({ assistantIds: [fixtures.YUI_ID] });
    const { calls, container } = makeApp(
      baseHandlers({
        "POST /v1/conversations": () => json(201, { conversation }),
        [`GET ${conversationPath}`]: () => json(200, { conversation }),
        [`POST ${messagesPath}`]: () => json(201, fixtures.makeExecutionResponse()),
        [`GET ${messagesPath}`]: () =>
          json(200, { messages: [fixtures.makeUserMessage(), fixtures.makeAssistantMessage()] }),
        [`GET ${executionsPath}`]: () => json(200, { executions: [fixtures.makeRun()] }),
        [`GET ${runPath}`]: () => json(200, fixtures.makeInspection()),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Nenhuma conversa ainda"));

    clickByText(view.host, "Nova conversa com YUI");
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Olá, YUI");
    submitComposer(view.host);
    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));

    // The reply is the persisted fixture, not anything the client produced.
    expect(text(view.host)).toContain("Você");
    expect(text(view.host)).toContain("YUI");
    // The wire body carried the selected assistant and the two correlation ids.
    const post = calls.find(
      (call) => call.url.includes("/messages") && call.init.method === "POST",
    )!;
    expect(post.body).toMatchObject({
      content: [{ type: "text", text: "Olá, YUI" }],
      assistantKey: "yui",
    });
    expect(String(post.body!.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(post.body!.idempotencyKey)).toMatch(/^msg:/);
    // Every request carried the Bearer token and nothing else.
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TEST_TOKEN}`,
      );
    }
    view.unmount();
  });

  it("creates a conversation with ALICE and sends to alice", async () => {
    const conversation = fixtures.makeConversation({ assistantIds: [fixtures.ALICE_ID] });
    const { calls, container } = makeApp(
      baseHandlers({
        "POST /v1/conversations": () => json(201, { conversation }),
        [`POST ${messagesPath}`]: () =>
          json(
            201,
            fixtures.makeExecutionResponse({
              execution: fixtures.makeRun({ assistantIds: [fixtures.ALICE_ID] }),
              assistantMessage: fixtures.makeAssistantMessage({
                assistantId: fixtures.ALICE_ID,
                metadata: { assistantKey: "alice" },
              }),
            }),
          ),
        [`GET ${messagesPath}`]: () =>
          json(200, {
            messages: [
              fixtures.makeUserMessage(),
              fixtures.makeAssistantMessage({
                assistantId: fixtures.ALICE_ID,
                metadata: { assistantKey: "alice" },
              }),
            ],
          }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Nenhuma conversa ainda"));

    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>(".assistant-option")]
        .find((button) => button.textContent === "ALICE")!
        .click();
    });
    clickByText(view.host, "Nova conversa com ALICE");
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Pesquise isso");
    submitComposer(view.host);
    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));

    const create = calls.find((call) => call.url.endsWith("/v1/conversations") && call.init.method === "POST")!;
    expect(create.body).toEqual({ assistantIds: [fixtures.ALICE_ID] });
    const post = calls.find((call) => call.url.includes("/messages") && call.init.method === "POST")!;
    expect(post.body!.assistantKey).toBe("alice");
    expect(text(view.host)).toContain("ALICE");
    view.unmount();
  });

  it("creates a conversation with SCHWI", async () => {
    const conversation = fixtures.makeConversation({ assistantIds: [fixtures.SCHWI_ID] });
    const { calls, container } = makeApp(
      baseHandlers({
        "POST /v1/conversations": () => json(201, { conversation }),
        [`GET ${messagesPath}`]: () => json(200, { messages: [] }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Nenhuma conversa ainda"));

    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>(".assistant-option")]
        .find((button) => button.textContent === "SCHWI")!
        .click();
    });
    clickByText(view.host, "Nova conversa com SCHWI");
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    const create = calls.find((call) => call.init.method === "POST" && call.url.endsWith("/v1/conversations"))!;
    expect(create.body).toEqual({ assistantIds: [fixtures.SCHWI_ID] });
    view.unmount();
  });
});

describe("3C.2 — persistence and reopening", () => {
  it("lists existing conversations, opens one and shows the persisted history", async () => {
    const conversation = fixtures.makeConversation({ title: "Conversa antiga" });
    const { container } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        [`GET ${conversationPath}`]: () => json(200, { conversation }),
        [`GET ${messagesPath}`]: () =>
          json(200, {
            messages: [
              fixtures.makeUserMessage({ content: [{ type: "text", text: "Pergunta antiga" }] }),
              fixtures.makeAssistantMessage({ content: [{ type: "text", text: "Resposta antiga" }] }),
            ],
          }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa antiga"));

    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => text(view.host).includes("Resposta antiga"));
    expect(text(view.host)).toContain("Pergunta antiga");
    view.unmount();
  });

  it("restores the history after a full close-and-reopen cycle", async () => {
    const conversation = fixtures.makeConversation({ title: "Reabrir" });
    const handlers = baseHandlers({
      "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
      [`GET ${messagesPath}`]: () =>
        json(200, {
          messages: [
            fixtures.makeUserMessage({ content: [{ type: "text", text: "Fica persistido" }] }),
            fixtures.makeAssistantMessage({ content: [{ type: "text", text: "Também fica" }] }),
          ],
        }),
    });

    const first = makeApp(handlers);
    const firstView = renderApp(first.container);
    await waitFor(() => text(firstView.host).includes("Reabrir"));
    act(() => firstView.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => text(firstView.host).includes("Também fica"));
    firstView.unmount();

    // A brand-new app instance with the same stored token: nothing survives in memory.
    const second = makeApp(handlers);
    const secondView = renderApp(second.container);
    await waitFor(() => text(secondView.host).includes("Reabrir"));
    act(() => secondView.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => text(secondView.host).includes("Também fica"));
    secondView.unmount();
  });
});

describe("3C.2 — execution states over the wire", () => {
  function chatHandler(execution: () => Response, history: () => Response) {
    return baseHandlers({
      "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
      [`POST ${messagesPath}`]: execution,
      [`GET ${messagesPath}`]: history,
      [`GET ${executionsPath}`]: () => json(200, { executions: [] }),
    });
  }

  it("shows a partial result as a persisted answer", async () => {
    const { container } = makeApp(
      chatHandler(
        () =>
          json(
            201,
            fixtures.makeExecutionResponse({ execution: fixtures.makeRun({ status: "partial" }) }),
          ),
        () => json(200, { messages: [fixtures.makeUserMessage(), fixtures.makeAssistantMessage()] }),
      ),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Tarefa");
    submitComposer(view.host);
    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));
    view.unmount();
  });

  it("shows a failed execution without a fabricated reply", async () => {
    const { container } = makeApp(
      chatHandler(
        () =>
          json(500, {
            error: {
              code: "PROVIDER_TIMEOUT",
              message: "Provider timed out",
              retryable: true,
            },
            timestamp: new Date().toISOString(),
          }),
        () => json(200, { messages: [] }),
      ),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Vai falhar");
    submitComposer(view.host);

    await waitFor(() => text(view.host).includes("provedor de IA"));
    expect(view.host.querySelectorAll(".bubble-assistant").length).toBe(0);
    view.unmount();
  });

  it("never reports success when the connection dies during the send", async () => {
    const { container } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        [`POST ${messagesPath}`]: () => {
          throw new TypeError("Failed to fetch");
        },
        [`GET ${messagesPath}`]: () => json(200, { messages: [] }),
        [`GET ${executionsPath}`]: () => json(200, { executions: [] }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Sem conexão");
    submitComposer(view.host);

    await waitFor(() => text(view.host).includes("não foi enviada ao servidor"));
    expect(view.host.querySelectorAll(".bubble-user").length).toBe(0);
    view.unmount();
  });

  it("recovers a run that was persisted even though the reply was lost", async () => {
    const { container } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        [`POST ${messagesPath}`]: () => {
          throw new TypeError("Failed to fetch");
        },
        [`GET ${messagesPath}`]: () =>
          json(200, { messages: [fixtures.makeUserMessage(), fixtures.makeAssistantMessage()] }),
        [`GET ${executionsPath}`]: () =>
          json(200, { executions: [fixtures.makeRun({ status: "succeeded" })] }),
        [`GET ${runPath}`]: () => json(200, fixtures.makeInspection()),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Enviada mas perdida");
    submitComposer(view.host);

    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));
    view.unmount();
  });

  it("cancels a running execution through the CORE cancel route", async () => {
    /** The real requestId the app generated for this message. */
    let sentRequestId: string | null = null;
    let cancelled = false;
    const { calls, container } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        // Long-running: the POST never resolves during this test.
        [`POST ${messagesPath}`]: (request) => {
          sentRequestId = String(request.body!.requestId);
          return new Promise<Response>(() => undefined);
        },
        [`GET ${messagesPath}`]: () => json(200, { messages: [fixtures.makeUserMessage()] }),
        // The server correlates the run by the requestId the client sent — the app must
        // find it that way, never by deriving an id locally.
        [`GET ${executionsPath}`]: () =>
          json(200, {
            executions: sentRequestId
              ? [fixtures.makeRun({ status: "running", requestId: sentRequestId })]
              : [],
          }),
        // After the cancel, the run is reported as cancelled by the CORE.
        [`GET ${runPath}`]: () =>
          json(
            200,
            fixtures.makeInspection({
              execution: fixtures.makeRun({ status: cancelled ? "cancelled" : "running" }),
            }),
          ),
        [`POST ${runPath}/cancel`]: () => {
          cancelled = true;
          return json(
            200,
            fixtures.makeInspection({ execution: fixtures.makeRun({ status: "cancelled" }) }),
          );
        },
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    typeMessage(view.host, "Demora muito");
    submitComposer(view.host);

    await waitFor(() => text(view.host).includes("Cancelar execução"));
    clickByText(view.host, "Cancelar execução");
    await waitFor(() => calls.some((call) => call.url.includes("/cancel")));

    // The cancel used the run discovered from persisted state — never a client-derived id.
    const cancel = calls.find((call) => call.url.includes("/cancel"))!;
    expect(cancel.init.method).toBe("POST");
    expect(cancel.url).toContain(fixtures.RUN_ID);

    // The UI reloads the persisted state and settles: no spinner, no invented answer.
    await waitFor(() => view.host.querySelector("[data-testid='chat-processing']") === null);
    expect(text(view.host)).not.toContain("Cancelar execução");
    expect(view.host.querySelectorAll(".bubble-assistant").length).toBe(0);
    view.unmount();
  });

  it("returns to login when the session expires mid-conversation", async () => {
    const { container, storage } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        [`GET ${messagesPath}`]: () =>
          json(401, {
            error: { code: "UNAUTHORIZED", message: "expired", retryable: false },
            timestamp: new Date().toISOString(),
          }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());

    await waitFor(() => view.host.querySelector("#owner-password") !== null);
    expect(storage.peek()).toBeNull();
    view.unmount();
  });
});

describe("3C.2 — navigation and session", () => {
  it("keeps the logout flow working from the conversation list", async () => {
    const { calls, container, storage } = makeApp(baseHandlers());

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Suas conversas"));

    act(() => view.host.querySelector<HTMLButtonElement>(".home-footer .button-secondary")!.click());
    expect(text(view.host)).toContain("Encerrar a sessão neste dispositivo?");
    act(() => view.host.querySelector<HTMLButtonElement>(".home-footer .button-primary")!.click());

    await waitFor(() => view.host.querySelector("#owner-password") !== null);
    expect(calls.some((call) => call.url.endsWith("/v1/auth/logout"))).toBe(true);
    expect(storage.peek()).toBeNull();
    view.unmount();
  });

  it("closes the chat and returns to the list when going back", async () => {
    const conversation = fixtures.makeConversation({ title: "Voltar" });
    const { container } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        [`GET ${messagesPath}`]: () => json(200, { messages: [] }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Voltar"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => text(view.host).includes("Nenhuma mensagem nesta conversa"));

    clickByText(view.host, "← Conversas");
    // The list is mounted again and reloads from the server before showing the item.
    await waitFor(() => text(view.host).includes("Suas conversas"));
    await waitFor(() => view.host.querySelector(".conversation-item") !== null);
    expect(text(view.host)).toContain("Voltar");
    view.unmount();
  });

  it("does not render an assistant message unless the server persisted one", async () => {
    const { container } = makeApp(
      baseHandlers({
        "GET /v1/conversations": () => json(200, { conversations: [conversation] }),
        [`GET ${messagesPath}`]: () => json(200, { messages: [fixtures.makeUserMessage()] }),
      }),
    );

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Conversa sem título"));
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());
    await waitFor(() => text(view.host).includes("Você"));
    expect(view.host.querySelectorAll(".bubble-assistant").length).toBe(0);
    view.unmount();
  });

  it("never writes the session token into the DOM", async () => {
    const { container } = makeApp(baseHandlers());

    const view = renderApp(container);
    await waitFor(() => text(view.host).includes("Suas conversas"));
    expect(view.host.innerHTML).not.toContain(TEST_TOKEN);
    view.unmount();
  });
});

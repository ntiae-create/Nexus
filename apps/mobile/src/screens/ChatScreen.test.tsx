/**
 * @vitest-environment happy-dom
 *
 * Chat screen behaviour: history rendering, assistant selection, send, duplicate-send lock,
 * execution errors, cancellation, recovery and session expiry. `ConversationService` is a
 * stub; no network and no provider call are involved.
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "@nexus/shared";
import { ChatScreen } from "./ChatScreen.js";
import type {
  CancelOutcome,
  ChatSession,
  PendingSend,
  ConversationService,
  FollowResult,
  LoadResult,
  SendResult,
} from "../services/conversation-service.js";
import {
  ALICE_ID,
  ASSISTANT_MESSAGE_ID,
  CONVERSATION_ID,
  RUN_ID,
  USER_MESSAGE_ID,
  YUI_ID,
  makeAssistantMessage,
  makeConversation,
  makeRun,
  makeUserMessage,
} from "../test-support/core-fixtures.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (host: HTMLElement) => host.textContent ?? "";

async function waitFor(predicate: () => boolean, timeoutMs = 2500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for UI state");
    await act(async () => {
      await wait(10);
    });
  }
}

type ChatOverrides = {
  send?: ChatSession["send"];
  cancel?: ChatSession["cancel"];
  follow?: ChatSession["follow"];
  findRun?: ChatSession["findRun"];
  activeRuns?: ChatSession["activeRuns"];
};

function makeService(options: {
  history?: () => Promise<LoadResult<readonly Message[]>>;
  chat?: ChatOverrides;
  historyCalls?: { count: number };
} = {}): ConversationService {
  const chatSession: ChatSession = {
    send: options.chat?.send ?? (async () => ({ kind: "rejected", message: "não configurado" })),
    cancel: options.chat?.cancel ?? (async () => ({ kind: "cancelled" })),
    follow: options.chat?.follow ?? (async () => ({ outcome: { kind: "aborted" }, messages: null })),
    findRun: options.chat?.findRun ?? (async () => ({ kind: "aborted" })),
    activeRuns: options.chat?.activeRuns ?? (async () => ({ ok: true as const, data: [] })),
  };

  return {
    list: async () => ({ ok: true, data: { conversations: [], isEmpty: true } }),
    get: async () => ({ ok: true, data: makeConversation() }),
    create: async () => ({ ok: true, data: makeConversation() }),
    history:
      options.history ??
      (async () => {
        if (options.historyCalls) options.historyCalls.count += 1;
        return { ok: true, data: [] };
      }),
    chat: () => chatSession,
  };
}

function render(service: ConversationService, extra: { onSessionExpired?: () => void } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const back = vi.fn();
  let expiryCount = 0;

  act(() => {
    root.render(
      createElement(ChatScreen, {
        conversation: makeConversation({ assistantIds: [YUI_ID] }),
        service,
        onBack: back,
        onSessionExpired: () => {
          expiryCount += 1;
          extra.onSessionExpired?.();
        },
      }),
    );
  });

  return {
    host,
    back,
    expiries: () => expiryCount,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function typeInto(host: HTMLElement, value: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>("#chat-message-input")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Enviar mensagem"]')!;
}

function submit(host: HTMLElement) {
  const form = host.querySelector<HTMLFormElement>(".composer")!;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("ChatScreen — history", () => {
  it("renders the persisted history chronologically, user and assistant separated", async () => {
    const view = render(
      makeService({
        history: async () => ({
          ok: true,
          data: [
            makeUserMessage({ content: [{ type: "text", text: "Pergunta do usuário" }] }),
            makeAssistantMessage({ content: [{ type: "text", text: "Resposta da YUI" }] }),
          ],
        }),
      }),
    );

    await waitFor(() => text(view.host).includes("Resposta da YUI"));

    const bubbles = [...view.host.querySelectorAll(".bubble")];
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.className).toContain("bubble-user");
    expect(bubbles[1]!.className).toContain("bubble-assistant");
    expect(text(view.host)).toContain("Você");
    expect(text(view.host)).toContain("YUI");
    view.unmount();
  });

  it("shows the empty state for a conversation with no messages", async () => {
    const view = render(makeService());
    await waitFor(() => text(view.host).includes("Nenhuma mensagem nesta conversa"));
    view.unmount();
  });

  it("shows a loading indicator before the history arrives", async () => {
    let resolveHistory: (value: LoadResult<readonly Message[]>) => void = () => undefined;
    const view = render(
      makeService({
        history: () =>
          new Promise((resolve) => {
            resolveHistory = resolve;
          }),
      }),
    );

    expect(text(view.host)).toContain("Carregando histórico…");
    await act(async () => {
      resolveHistory({ ok: true, data: [] });
      await wait(10);
    });
    await waitFor(() => !text(view.host).includes("Carregando histórico…"));
    view.unmount();
  });

  it("shows a comprehensible error with retry when history fails", async () => {
    let attempt = 0;
    const view = render(
      makeService({
        history: async () => {
          attempt += 1;
          if (attempt === 1) {
            return {
              ok: false,
              message: "Não foi possível conectar ao servidor.",
              signedOut: false,
            };
          }
          return {
            ok: true,
            data: [makeUserMessage({ content: [{ type: "text", text: "Recuperado" }] })],
          };
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Não foi possível conectar"));
    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Tentar novamente"))!
        .click();
    });
    await waitFor(() => text(view.host).includes("Recuperado"));
    view.unmount();
  });

  it("reloads persisted messages when the conversation is reopened", async () => {
    // Simulates closing and reopening: a second mount loads from the server again.
    const history = async () => ({
      ok: true as const,
      data: [
        makeUserMessage({ content: [{ type: "text", text: "Persistida" }] }),
        makeAssistantMessage({ content: [{ type: "text", text: "Também persistida" }] }),
      ],
    });

    const first = render(makeService({ history }));
    await waitFor(() => text(first.host).includes("Também persistida"));
    first.unmount();

    const second = render(makeService({ history }));
    await waitFor(() => text(second.host).includes("Também persistida"));
    expect(second.host.querySelectorAll(".bubble")).toHaveLength(2);
    second.unmount();
  });

  it("returns to the list through the back action", async () => {
    const view = render(makeService());
    await waitFor(() => text(view.host).includes("← Conversas"));
    act(() => view.host.querySelector<HTMLButtonElement>(".chat-back")!.click());
    expect(view.back).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe("ChatScreen — assistant selection", () => {
  it("only offers the assistants that participate in the conversation", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(ChatScreen, {
          conversation: makeConversation({ assistantIds: [ALICE_ID] }),
          service: makeService(),
          onBack: () => undefined,
          onSessionExpired: () => undefined,
        }),
      );
    });

    await waitFor(() => host.querySelectorAll(".assistant-option").length > 0);
    const options = [...host.querySelectorAll(".assistant-option")];
    expect(options.map((option) => option.textContent)).toEqual(["ALICE"]);
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");

    act(() => root.unmount());
    host.remove();
  });

  it("hides the selector when the conversation has no catalog assistant", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(ChatScreen, {
          conversation: makeConversation({ assistantIds: [] }),
          service: makeService(),
          onBack: () => undefined,
          onSessionExpired: () => undefined,
        }),
      );
    });

    await waitFor(() => text(host).includes("Carregando histórico") || text(host).includes("Nenhuma"));
    expect(host.querySelector(".chat-assistant")?.hasAttribute("hidden")).toBe(true);
    act(() => root.unmount());
    host.remove();
  });

  it("blocks sending when no catalog assistant is available", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(ChatScreen, {
          conversation: makeConversation({ assistantIds: [] }),
          service: makeService(),
          onBack: () => undefined,
          onSessionExpired: () => undefined,
        }),
      );
    });

    await waitFor(() => host.querySelector("#chat-message-input") !== null);
    typeInto(host, "Olá");
    submit(host);
    await waitFor(() => text(host).includes("não possui um assistente do catálogo"));
    act(() => root.unmount());
    host.remove();
  });
});

describe("ChatScreen — sending", () => {
  it("sends the draft with the selected assistant and clears the input on success", async () => {
    const send = vi.fn(async (_pending: PendingSend): Promise<SendResult> => ({
      kind: "delivered",
      status: "succeeded",
      messages: [
        makeUserMessage({ content: [{ type: "text", text: "Olá, YUI" }] }),
        makeAssistantMessage({ content: [{ type: "text", text: "Olá! Como posso ajudar?" }] }),
      ],
      persisted: { user: makeUserMessage(), assistant: makeAssistantMessage() },
      run: makeRun(),
    }));

    const view = render(makeService({ chat: { send } }));
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "  Olá, YUI  ");
    submit(view.host);

    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));

    const pending = send.mock.calls[0]![0];
    expect(pending.text).toBe("Olá, YUI"); // trimmed, no whitespace-only send
    expect(pending.assistantKey).toBe("yui");
    expect(pending.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending.idempotencyKey).toMatch(/^msg:/);
    expect(view.host.querySelector<HTMLTextAreaElement>("#chat-message-input")!.value).toBe("");
    view.unmount();
  });

  it("never sends an empty or whitespace-only draft", async () => {
    const send = vi.fn(async (_pending: PendingSend): Promise<SendResult> => ({ kind: "rejected", message: "nope" }));
    const view = render(makeService({ chat: { send } }));
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "   ");
    expect(sendButton(view.host).disabled).toBe(true);
    submit(view.host);

    expect(send).not.toHaveBeenCalled();
    view.unmount();
  });

  it("locks duplicate sends while a message is in flight", async () => {
    let release: (() => void) | null = null;
    const send = vi.fn(async (_pending: PendingSend): Promise<SendResult> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        kind: "delivered",
        status: "succeeded",
        messages: [makeAssistantMessage()],
        persisted: { user: makeUserMessage(), assistant: makeAssistantMessage() },
        run: makeRun(),
      };
    });

    const view = render(makeService({ chat: { send } }));
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "Primeira");
    submit(view.host);
    submit(view.host);
    submit(view.host);

    await waitFor(() => text(view.host).includes("Enviando ao NEXUS CORE"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.host.querySelector<HTMLTextAreaElement>("#chat-message-input")!.disabled).toBe(true);
    expect(sendButton(view.host).disabled).toBe(true);

    await act(async () => {
      release?.();
      await wait(20);
    });
    await waitFor(() => view.host.querySelector("#chat-message-input")!.hasAttribute("disabled") === false);
    // Still exactly one request for the whole burst.
    expect(send).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("generates a distinct requestId/idempotencyKey per message", async () => {
    const send = vi.fn(async (_pending: PendingSend): Promise<SendResult> => ({
      kind: "delivered",
      status: "succeeded",
      messages: [makeAssistantMessage()],
      persisted: { user: makeUserMessage(), assistant: makeAssistantMessage() },
      run: makeRun(),
    }));

    const view = render(makeService({ chat: { send } }));
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "Primeira");
    submit(view.host);
    await waitFor(() => send.mock.calls.length === 1);
    // Wait for the first send to fully settle (the composer re-enables and the draft is
    // cleared). Typing while it is still disabled would be discarded by the browser.
    await waitFor(
      () => view.host.querySelector<HTMLTextAreaElement>("#chat-message-input")!.disabled === false,
    );

    typeInto(view.host, "Segunda");
    submit(view.host);
    await waitFor(() => send.mock.calls.length === 2);

    const [first, second] = send.mock.calls.map((call) => call[0]);
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
    expect(first!.requestId).not.toBe(second!.requestId);
    view.unmount();
  });

  it("keeps the draft when the server rejects the message", async () => {
    const send = vi.fn(async (_pending: PendingSend): Promise<SendResult> => ({
      kind: "rejected",
      message: "A mensagem não foi enviada ao servidor. Verifique a conexão e tente novamente.",
    }));

    const view = render(makeService({ chat: { send } }));
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Texto importante");
    submit(view.host);

    await waitFor(() => text(view.host).includes("não foi enviada ao servidor"));
    expect(view.host.querySelector<HTMLTextAreaElement>("#chat-message-input")!.value).toBe(
      "Texto importante",
    );
    view.unmount();
  });
});

describe("ChatScreen — execution states", () => {
  it("renders a partial result as partial, keeping the answer", async () => {
    const view = render(
      makeService({
        chat: {
          send: async () => ({
            kind: "delivered",
            status: "partial",
            messages: [
              makeUserMessage(),
              makeAssistantMessage({ metadata: { assistantKey: "yui", runStatus: "partial" } }),
            ],
            persisted: { user: makeUserMessage(), assistant: makeAssistantMessage() },
            run: makeRun({ status: "partial" }),
          }),
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Tarefa coordenada");
    submit(view.host);

    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));
    // The reply is shown because it is persisted; no "failed" wording appears.
    expect(text(view.host)).not.toContain("A execução falhou");
    view.unmount();
  });

  it("shows a failed execution explicitly and never invents a reply", async () => {
    const view = render(
      makeService({
        chat: {
          send: async () => ({
            kind: "failed",
            message: "A execução falhou (PROVIDER_TIMEOUT). Nenhuma resposta foi gerada.",
            messages: [makeUserMessage()],
            runId: RUN_ID,
          }),
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Isso vai falhar");
    submit(view.host);

    await waitFor(() => text(view.host).includes("PROVIDER_TIMEOUT"));
    expect(view.host.querySelectorAll(".bubble-assistant").length).toBe(0);
    expect(view.host.querySelectorAll(".bubble-user").length).toBe(1);
    view.unmount();
  });

  it("shows a cancelled execution without an answer", async () => {
    const view = render(
      makeService({
        chat: {
          send: async () => ({
            kind: "cancelled",
            messages: [makeUserMessage()],
            runId: RUN_ID,
          }),
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Cancelar");
    submit(view.host);

    await waitFor(() => view.host.querySelectorAll(".bubble-user").length === 1);
    expect(view.host.querySelectorAll(".bubble-assistant").length).toBe(0);
    view.unmount();
  });

  it("warns instead of confirming when the outcome could not be verified", async () => {
    const view = render(
      makeService({
        chat: {
          send: async () => ({
            kind: "unknown",
            message:
              "A conexão falhou durante o envio e não foi possível confirmar o estado no servidor. " +
              "Reabra a conversa antes de reenviar.",
            runId: null,
          }),
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Talvez enviada");
    submit(view.host);

    await waitFor(() => text(view.host).includes("não foi possível confirmar"));
    // Nothing is rendered as sent: no bubbles at all.
    expect(view.host.querySelectorAll(".bubble-user").length).toBe(0);
    view.unmount();
  });

  it("returns to login when the server reports an expired session mid-send", async () => {
    const view = render(makeService({ chat: { send: async () => ({ kind: "signed_out" }) } }));

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Sessão expirada");
    submit(view.host);

    await waitFor(() => view.expiries() === 1);
    view.unmount();
  });
});

describe("ChatScreen — cancellation while processing", () => {
  it("offers cancel while processing and reloads the persisted state afterwards", async () => {
    let releaseSend: (() => void) | null = null;
    // The tracking loop stays open, exactly like a run the server is still executing.
    let resolveFollow: (value: FollowResult) => void = () => undefined;
    const follow = vi.fn(
      (): Promise<FollowResult> =>
        new Promise<FollowResult>((resolve) => {
          resolveFollow = resolve;
        }),
    );
    const cancel = vi.fn(async (): Promise<CancelOutcome> => {
      // The server honours the cancel: the loop already watching the run observes it.
      resolveFollow({
        outcome: { kind: "cancelled", run: makeRun({ status: "cancelled" }) },
        messages: [
          makeUserMessage({ content: [{ type: "text", text: "Mensagem persistida" }] }),
        ],
      });
      return { kind: "cancelled" };
    });

    const view = render(
      makeService({
        chat: {
          send: async (): Promise<SendResult> => {
            await new Promise<void>((resolve) => {
              releaseSend = resolve;
            });
            return { kind: "cancelled", messages: null, runId: RUN_ID };
          },
          cancel,
          follow,
          // The run becomes discoverable immediately, so the cancel button appears.
          findRun: async () => ({ kind: "found" as const, run: makeRun({ status: "running" }) }),
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Tarefa longa");
    submit(view.host);

    await waitFor(() => text(view.host).includes("Cancelar execução"));
    // The single tracking loop owns the run before the cancel.
    await waitFor(() => follow.mock.calls.length === 1);

    await act(async () => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancelar execução")!
        .click();
      await wait(20);
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(RUN_ID, expect.anything());
    await waitFor(() => text(view.host).includes("Mensagem persistida"));
    await waitFor(() => text(view.host).includes("A execução foi cancelada"));
    // No second loop: the cancel only asks the server and lets the live loop finish.
    expect(follow).toHaveBeenCalledTimes(1);
    expect(text(view.host)).not.toContain("Cancelar execução");

    await act(async () => {
      releaseSend?.();
      await wait(20);
    });
    view.unmount();
  });

  it("reports a cancel failure without pretending it worked", async () => {
    const view = render(
      makeService({
        chat: {
          send: async (): Promise<SendResult> => new Promise(() => undefined),
          cancel: async () => ({
            kind: "error",
            error: new (await import("../services/api-client.js")).ApiError({
              kind: "network",
              message: "Não foi possível conectar ao servidor.",
            }),
          }),
          findRun: async () => ({ kind: "found" as const, run: makeRun({ status: "running" }) }),
        },
      }),
    );

    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Tarefa longa");
    submit(view.host);
    await waitFor(() => text(view.host).includes("Cancelar execução"));

    await act(async () => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancelar execução")!
        .click();
      await wait(20);
    });

    await waitFor(() => text(view.host).includes("Não foi possível conectar"));
    view.unmount();
  });
});

describe("ChatScreen — rendered contracts", () => {
  it("labels assistant messages by the persisted author, not by the selection", async () => {
    const view = render(
      makeService({
        history: async () => ({
          ok: true,
          data: [
            makeUserMessage(),
            // Persisted by SCHWI even though only YUI participates now.
            makeAssistantMessage({
              assistantId: "00000000-0000-4000-8000-000000000003",
              metadata: { assistantKey: "schwi" },
            }),
          ],
        }),
      }),
    );

    await waitFor(() => text(view.host).includes("SCHWI"));
    view.unmount();
  });

  it("shows a persisted non-complete message status honestly", async () => {
    const view = render(
      makeService({
        history: async () => ({
          ok: true,
          data: [makeUserMessage({ status: "failed" })],
        }),
      }),
    );

    await waitFor(() => text(view.host).includes("registrou esta mensagem como falha"));
    view.unmount();
  });

  it("exposes the history as a labelled list and keeps the bubbles addressable", async () => {
    const view = render(
      makeService({
        history: async () => ({
          ok: true,
          data: [makeUserMessage(), makeAssistantMessage()],
        }),
      }),
    );

    // The list element exists before the history arrives, so wait for the bubbles themselves.
    await waitFor(
      () => view.host.querySelector(`[data-testid="message-${ASSISTANT_MESSAGE_ID}"]`) !== null,
    );
    const list = view.host.querySelector('[data-testid="chat-messages"]')!;
    expect(list.getAttribute("aria-label")).toBe("Histórico da conversa");
    expect(view.host.querySelector(`[data-testid="message-${USER_MESSAGE_ID}"]`)).not.toBeNull();
    expect(view.host.querySelector(`[data-testid="message-${ASSISTANT_MESSAGE_ID}"]`)).not.toBeNull();
    view.unmount();
  });

  it("uses a multiline textarea with an explicit send control", async () => {
    const view = render(makeService());
    await waitFor(() => view.host.querySelector("#chat-message-input") !== null);

    const textarea = view.host.querySelector<HTMLTextAreaElement>("#chat-message-input")!;
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
    expect(sendButton(view.host)).not.toBeNull();
    view.unmount();
  });

  it("sends on Ctrl+Enter but keeps Enter as a newline", async () => {
    const send = vi.fn(async (_pending: PendingSend): Promise<SendResult> => ({
      kind: "delivered",
      status: "succeeded",
      messages: [makeAssistantMessage()],
      persisted: { user: makeUserMessage(), assistant: makeAssistantMessage() },
      run: makeRun(),
    }));

    const view = render(makeService({ chat: { send } }));
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));
    typeInto(view.host, "Enviar com atalho");

    const textarea = view.host.querySelector<HTMLTextAreaElement>("#chat-message-input")!;
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(send).not.toHaveBeenCalled();

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await waitFor(() => send.mock.calls.length === 1);
    view.unmount();
  });
});

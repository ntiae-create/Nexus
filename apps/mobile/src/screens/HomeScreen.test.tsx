/**
 * @vitest-environment happy-dom
 *
 * Home screen behaviour with a mocked CORE: conversation list, creation, states and logout.
 * No real backend, no provider call and no network — `ConversationService` is a stub here and
 * a mocked `fetch` in `App.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Conversation } from "@nexus/shared";
import { HomeScreen } from "./HomeScreen.js";
import type { ConversationService, LoadResult } from "../services/conversation-service.js";
import { ApiError } from "../services/api-client.js";
import { ASSISTANT_CATALOG } from "../lib/assistants.js";
import {
  ALICE_ID,
  CONVERSATION_ID,
  CONVERSATION_ID_2,
  makeConversation,
  SCHWI_ID,
  YUI_ID,
} from "../test-support/core-fixtures.js";
import { TEST_OWNER_ID, TEST_TOKEN } from "../test-support/fakes.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (host: HTMLElement) => host.textContent ?? "";

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for UI state");
    await act(async () => {
      await wait(10);
    });
  }
}

/** Minimal in-memory ConversationService; every method is replaceable per test. */
function makeService(overrides: Partial<ConversationService> = {}): ConversationService {
  const base: ConversationService = {
    list: async () => ({ ok: true, data: { conversations: [], isEmpty: true } }),
    get: async () => ({ ok: true, data: makeConversation() }),
    create: async () => ({ ok: true, data: makeConversation() }),
    history: async () => ({ ok: true, data: [] }),
    chat: () => ({
      send: async () => ({ kind: "rejected", message: "not used in this test" }),
      cancel: async () => ({ kind: "cancelled" }),
      follow: async () => ({ outcome: { kind: "aborted" }, messages: null }),
      findRun: async () => null,
    }),
  };
  return { ...base, ...overrides };
}

const session = {
  token: TEST_TOKEN,
  ownerId: TEST_OWNER_ID,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function render(service: ConversationService, extra: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const opened: Conversation[] = [];
  let expiryCount = 0;
  const logout = vi.fn(async () => ({ revokedRemotely: true }));

  act(() => {
    root.render(
      createElement(HomeScreen, {
        session,
        service,
        busy: false,
        onOpenConversation: (conversation: Conversation) => opened.push(conversation),
        onLogout: logout,
        onSessionExpired: () => {
          expiryCount += 1;
        },
        ...extra,
      }),
    );
  });

  return {
    host,
    opened,
    logout,
    expiries: () => expiryCount,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("HomeScreen — conversation list", () => {
  it("shows a spinner while loading, then the empty state", async () => {
    const view = render(makeService());

    expect(text(view.host)).toContain("Carregando conversas…");
    await waitFor(() => text(view.host).includes("Nenhuma conversa ainda"));
    view.unmount();
  });

  it("renders owner conversations with assistant names and timestamps", async () => {
    const conversations = [
      makeConversation({ id: CONVERSATION_ID, title: "Planejamento", assistantIds: [YUI_ID] }),
      makeConversation({
        id: CONVERSATION_ID_2,
        title: null,
        assistantIds: [ALICE_ID, SCHWI_ID],
        updatedAt: "2026-02-03T10:11:12.000Z",
      }),
    ];
    const view = render(
      makeService({ list: async () => ({ ok: true, data: { conversations, isEmpty: false } }) }),
    );

    await waitFor(() => text(view.host).includes("Planejamento"));
    expect(text(view.host)).toContain("Conversa sem título");
    expect(text(view.host)).toContain("YUI");
    expect(text(view.host)).toContain("ALICE · SCHWI");
    expect(view.host.querySelectorAll(".conversation-item")).toHaveLength(2);
    view.unmount();
  });

  it("opens a conversation by its real id when tapped", async () => {
    const conversation = makeConversation({ title: "Abrir" });
    const view = render(
      makeService({ list: async () => ({ ok: true, data: { conversations: [conversation], isEmpty: false } }) }),
    );

    await waitFor(() => view.host.querySelector<HTMLButtonElement>(".conversation-item") !== null);
    act(() => view.host.querySelector<HTMLButtonElement>(".conversation-item")!.click());

    expect(view.opened).toHaveLength(1);
    expect(view.opened[0]!.id).toBe(CONVERSATION_ID);
    view.unmount();
  });

  it("shows a comprehensible error with a working retry", async () => {
    let attempt = 0;
    const list = vi.fn(async (): Promise<LoadResult<{ conversations: readonly Conversation[]; isEmpty: boolean }>> => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, message: "Não foi possível conectar ao servidor.", signedOut: false };
      }
      return { ok: true, data: { conversations: [makeConversation({ title: "Depois do retry" })], isEmpty: false } };
    });

    const view = render(makeService({ list }));

    await waitFor(() => text(view.host).includes("Não foi possível conectar"));
    act(() => {
      const retry = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Tentar novamente"),
      )!;
      retry.click();
    });
    await waitFor(() => text(view.host).includes("Depois do retry"));
    view.unmount();
  });

  it("reports an expired session instead of showing an empty inbox", async () => {
    const view = render(
      makeService({
        list: async () => ({
          ok: false,
          message: "Sua sessão expirou. Entre novamente.",
          signedOut: true,
        }),
      }),
    );

    await waitFor(() => view.expiries() === 1);
    view.unmount();
  });

  it("refreshes the list from the server on demand", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      data: { conversations: [makeConversation({ title: `Carga ${list.mock.calls.length}` })], isEmpty: false },
    }));
    const view = render(makeService({ list }));

    await waitFor(() => text(view.host).includes("Carga 1"));
    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Atualizar")!
        .click();
    });
    await waitFor(() => text(view.host).includes("Carga 2"));
    view.unmount();
  });
});

describe("HomeScreen — conversation creation", () => {
  it("creates with YUI by default and opens the created conversation", async () => {
    const create = vi.fn(async (_input: { assistant: typeof ASSISTANT_CATALOG[number] }) => ({
      ok: true as const,
      data: makeConversation({ id: CONVERSATION_ID, assistantIds: [YUI_ID] }),
    }));
    const view = render(makeService({ create }));

    await waitFor(() => !text(view.host).includes("Carregando conversas"));

    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Nova conversa com YUI"))!
        .click();
    });

    await waitFor(() => view.opened.length === 1);
    // Only the chosen assistant is passed: no conversation id, no provider, no model.
    expect(create).toHaveBeenCalledWith({ assistant: ASSISTANT_CATALOG[0] });
    expect(view.opened[0]!.id).toBe(CONVERSATION_ID);
    view.unmount();
  });

  it("creates with ALICE after selecting her", async () => {
    const create = vi.fn(async (_input: { assistant: typeof ASSISTANT_CATALOG[number] }) => ({
      ok: true as const,
      data: makeConversation({ assistantIds: [ALICE_ID] }),
    }));
    const view = render(makeService({ create }));

    await waitFor(() => text(view.host).includes("Nova conversa com YUI"));

    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>(".assistant-option")]
        .find((button) => button.textContent === "ALICE")!
        .click();
    });

    expect(text(view.host)).toContain("Nova conversa com ALICE");

    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Nova conversa com ALICE"))!
        .click();
    });

    await waitFor(() => create.mock.calls.length === 1);
    expect(create.mock.calls[0]![0]).toEqual({ assistant: ASSISTANT_CATALOG[1] });
    view.unmount();
  });

  it("marks the selected assistant for assistive technology", async () => {
    const view = render(makeService());
    await waitFor(() => text(view.host).includes("Nova conversa com YUI"));

    const options = [...view.host.querySelectorAll<HTMLButtonElement>(".assistant-option")];
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    view.unmount();
  });

  it("shows the server error and does not open anything when creation fails", async () => {
    const view = render(
      makeService({
        create: async () => ({
          ok: false,
          message: "O NEXUS CORE não está configurado no servidor.",
          signedOut: false,
        }),
      }),
    );

    await waitFor(() => text(view.host).includes("Nova conversa com YUI"));
    act(() => {
      [...view.host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Nova conversa com YUI"))!
        .click();
    });

    await waitFor(() => text(view.host).includes("não está configurado"));
    expect(view.opened).toHaveLength(0);
    view.unmount();
  });

  it("never offers a delete action (the backend has no such route)", async () => {
    const view = render(
      makeService({
        list: async () => ({
          ok: true,
          data: { conversations: [makeConversation({ title: "Sem exclusão" })], isEmpty: false },
        }),
      }),
    );

    await waitFor(() => text(view.host).includes("Sem exclusão"));
    const labels = [...view.host.querySelectorAll("button")].map((button) =>
      (button.textContent ?? "").toLowerCase(),
    );
    expect(labels.some((label) => label.includes("excluir") || label.includes("apagar"))).toBe(false);
    view.unmount();
  });
});

describe("HomeScreen — session and logout", () => {
  it("keeps the existing logout confirmation flow", async () => {
    const view = render(makeService());
    await waitFor(() => text(view.host).includes("Sair"));

    act(() => view.host.querySelector<HTMLButtonElement>(".home-footer .button-secondary")!.click());
    expect(text(view.host)).toContain("Encerrar a sessão neste dispositivo?");

    await act(async () => {
      view.host.querySelector<HTMLButtonElement>(".home-footer .button-primary")!.click();
      await wait(10);
    });

    expect(view.logout).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("does not leak the session token into the rendered output", async () => {
    const view = render(
      makeService({ list: async () => ({ ok: true, data: { conversations: [], isEmpty: true } }) }),
    );
    await waitFor(() => text(view.host).includes("Suas conversas"));

    expect(text(view.host)).not.toContain(TEST_TOKEN);
    view.unmount();
  });

  it("shows the owner id as the only identity detail", async () => {
    const view = render(makeService());
    await waitFor(() => text(view.host).includes("Suas conversas"));
    expect(text(view.host)).toContain(TEST_OWNER_ID);
    view.unmount();
  });
});

describe("HomeScreen — unreachable backend", () => {
  it("surfaces a network ApiError message verbatim", async () => {
    const view = render(
      makeService({
        list: async () => ({
          ok: false,
          message: new ApiError({ kind: "network", message: "Sem conexão com a API." }).message,
          signedOut: false,
        }),
      }),
    );

    await waitFor(() => text(view.host).includes("Sem conexão com a API"));
    view.unmount();
  });
});

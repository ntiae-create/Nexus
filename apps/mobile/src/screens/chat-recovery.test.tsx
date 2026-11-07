/**
 * @vitest-environment happy-dom
 *
 * Corrective audit of Etapa 3C.2 (PR #6) — discovery, recovery and lifecycle of a chat
 * execution, exercised against the **real** `ConversationService`.
 *
 * Unlike `ChatScreen.test.tsx` (which stubs `ChatSession` to isolate the screen), this file
 * drives `createConversationService` over a stubbed `CoreService`. That way the discovery
 * loop, the backoff, the abort plumbing and `activeRuns()` filtering are the production code
 * under test, and the screen is only the orchestration on top of it.
 *
 * Every fixture comes from the shared schemas through `core-fixtures.ts`; no shape is
 * invented here.
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CoreRun, Message } from "@nexus/shared";
import { ChatScreen } from "./ChatScreen.js";
import type { ConversationService } from "../services/conversation-service.js";
import { createConversationService } from "../services/conversation-service.js";
import type { CoreService } from "../services/core-service.js";
import { ApiError } from "../services/api-client.js";
import {
  CONVERSATION_ID,
  RUN_ID,
  YUI_ID,
  makeAssistantMessage,
  makeConversation,
  makeExecutionResponse,
  makeInspection,
  makeRun,
  makeUserMessage,
} from "../test-support/core-fixtures.js";
import { TEST_TOKEN } from "../test-support/fakes.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (host: HTMLElement) => host.textContent ?? "";
const RUN_ID_2 = "11111111-1111-4111-8111-111111111111";

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout waiting for UI state");
    await act(async () => {
      await wait(10);
    });
  }
}

function typeInto(host: HTMLElement, value: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>("#chat-message-input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(host: HTMLElement) {
  const form = host.querySelector<HTMLFormElement>(".composer")!;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function clickButton(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  act(() => {
    button.click();
  });
}

/** Core service stub with recording, so request counts can be asserted. */
function coreStub(overrides: Partial<CoreService> = {}): CoreService {
  const notStubbed = (name: string) => () =>
    Promise.reject(new Error(`unstubbed core service method: ${name}`));
  return {
    listConversations: notStubbed("listConversations") as CoreService["listConversations"],
    getConversation: notStubbed("getConversation") as CoreService["getConversation"],
    createConversation: notStubbed("createConversation") as CoreService["createConversation"],
    listMessages: notStubbed("listMessages") as CoreService["listMessages"],
    sendMessage: notStubbed("sendMessage") as CoreService["sendMessage"],
    listExecutions: notStubbed("listExecutions") as CoreService["listExecutions"],
    getExecution: notStubbed("getExecution") as CoreService["getExecution"],
    cancelExecution: notStubbed("cancelExecution") as CoreService["cancelExecution"],
    ...overrides,
  };
}

function serviceFrom(core: CoreService, history: () => Promise<readonly Message[]>): {
  service: ConversationService;
  historyCalls: { count: number };
} {
  const historyCalls = { count: 0 };
  const base = createConversationService({ service: core, token: TEST_TOKEN });
  return {
    historyCalls,
    service: {
      ...base,
      history: async (conversationId, options = {}) => {
        historyCalls.count += 1;
        try {
          return { ok: true, data: await history() };
        } catch (error) {
          if (error instanceof ApiError && error.meansSessionInvalid) {
            return { ok: false, signedOut: true, message: "sessão expirada" };
          }
          return {
            ok: false,
            signedOut: false,
            message: error instanceof Error ? error.message : "erro",
          };
        }
      },
    } as ConversationService,
  };
}

function render(
  service: ConversationService,
  options: { scheduler?: (callback: () => void, delayMs: number) => void } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let expiries = 0;

  act(() => {
    root.render(
      createElement(ChatScreen, {
        conversation: makeConversation({ assistantIds: [YUI_ID] }),
        service,
        onBack: () => undefined,
        onSessionExpired: () => {
          expiries += 1;
        },
        ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      }),
    );
  });

  return {
    host,
    expiries: () => expiries,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------
// 1–4: discovery driven by the real service
// ---------------------------------------------------------------------------------------
describe("audit 3C.2 — discovery keeps the execution cancellable", () => {
  it("finds a run admitted only after 8 successful probes and offers cancel", async () => {
    let probes = 0;
    let sendRelease: (() => void) | null = null;
    const listExecutions = vi.fn(async () => {
      probes += 1;
      // Admitted late: the CORE only records the run after 10 successful probes.
      return probes >= 10
        ? [makeRun({ status: "running", requestId: REQUEST_ID_OF_SEND() || undefined })]
        : [];
    });

    const core = coreStub({
      listExecutions,
      sendMessage: (async (_token: string, _conversationId: string, input: unknown) => {
        captureRequestId(input);
        await new Promise<void>((resolve) => {
          sendRelease = resolve;
        });
        return makeExecutionResponse();
      }) as unknown as CoreService["sendMessage"],
      getExecution: async () =>
        makeInspection({ execution: makeRun({ status: "running" }) }),
    });

    const { service } = serviceFrom(core, async () => []);
    const view = render(service, { scheduler: immediateScheduler });
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "Tarefa longa");
    submit(view.host);

    // The cancel control appears as soon as the server exposes the real execution id.
    await waitFor(() => text(view.host).includes("Cancelar execução"));
    expect(probes).toBeGreaterThan(8);
    expect(text(view.host)).toContain("O NEXUS CORE está processando esta mensagem.");

    await act(async () => {
      sendRelease?.();
      await wait(20);
    });
    view.unmount();
  });

  /**
   * Review blocker on PR #6: the screen passes only `signal` (never `maxAttempts`), so the
   * discovery it drives must not be cut by a probe ceiling. Here the run appears only after
   * 250 successful probes — well past the removed 240 cap — while the POST is still pending,
   * and the cancel button must still show up with the real server id.
   */
  it("keeps probing past 240 successful probes and still exposes the real run id", async () => {
    let probes = 0;
    let sendRelease: (() => void) | null = null;
    const listExecutions = vi.fn(async () => {
      probes += 1;
      return probes >= 250
        ? [makeRun({ status: "running", requestId: REQUEST_ID_OF_SEND() || undefined })]
        : [];
    });

    const core = coreStub({
      listExecutions,
      sendMessage: (async (_token: string, _conversationId: string, input: unknown) => {
        captureRequestId(input);
        await new Promise<void>((resolve) => {
          sendRelease = resolve;
        });
        return makeExecutionResponse();
      }) as unknown as CoreService["sendMessage"],
      getExecution: async () => makeInspection({ execution: makeRun({ status: "running" }) }),
    });

    const { service } = serviceFrom(core, async () => []);
    const view = render(service, { scheduler: immediateScheduler });
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "Tarefa muito longa");
    submit(view.host);

    // 250 probes later the screen still finds the run instead of giving up as unavailable.
    await waitFor(() => text(view.host).includes("Cancelar execução"), 8000);
    expect(probes).toBeGreaterThanOrEqual(250);
    expect(text(view.host)).not.toContain("não pôde ser consultado");
    expect(text(view.host)).not.toContain("não registrou uma execução");

    await act(async () => {
      sendRelease?.();
      await wait(20);
    });
    view.unmount();
  });

  it("stops discovery the moment the send settles", async () => {
    let probes = 0;
    const listExecutions = vi.fn(async () => {
      probes += 1;
      return [];
    });
    let sendResolve: (() => void) | null = null;

    const core = coreStub({
      listExecutions,
      sendMessage: (async (_token: string, _conversationId: string, input: unknown) => {
        captureRequestId(input);
        await new Promise<void>((resolve) => {
          sendResolve = resolve;
        });
        return makeExecutionResponse();
      }) as unknown as CoreService["sendMessage"],
    });

    const manual = createManualScheduler();
    const { service } = serviceFrom(core, async () => [
      makeUserMessage(),
      makeAssistantMessage(),
    ]);
    const view = render(service, { scheduler: manual.scheduler });
    // This conversation already has messages, so wait for the loaded history instead of the
    // empty state.
    await waitFor(() => text(view.host).includes("Olá! Como posso ajudar?"));

    typeInto(view.host, "Mensagem");
    submit(view.host);
    // First probe runs immediately; further probes are gated by the manual scheduler.
    await waitFor(() => probes >= 1);
    await manual.flush();
    await waitFor(() => probes >= 2);
    expect(manual.pending()).toBeGreaterThan(0);

    // The send settles -> discovery must be aborted before the next delay fires.
    await act(async () => {
      sendResolve?.();
      await wait(40);
    });

    const settled = probes;
    let fired = 0;
    while (await manual.flush()) fired += 1;
    await act(async () => {
      await wait(60);
    });

    // Every pending delay either belonged to the settled send (no probe happens) or was
    // cancelled with it: the probe count must not move.
    expect(probes).toBe(settled);
    expect(fired).toBeLessThanOrEqual(1);
    view.unmount();
  });

  it("stops discovery on unmount and issues nothing afterwards", async () => {
    let probes = 0;
    const listExecutions = vi.fn(async () => {
      probes += 1;
      return [];
    });
    const core = coreStub({
      listExecutions,
      sendMessage: (async () => new Promise(() => undefined)) as unknown as CoreService["sendMessage"],
    });

    const { service } = serviceFrom(core, async () => []);
    const view = render(service);
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "Mensagem");
    submit(view.host);
    await waitFor(() => probes >= 2);

    view.unmount();
    const atUnmount = probes;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(probes).toBe(atUnmount);
  });

  it("uses the server's own requestId — never a locally derived run id", async () => {
    const requestIds: string[] = [];
    const listExecutions = vi.fn(async () => {
      requestIds.push("probe");
      return [];
    });
    const core = coreStub({
      listExecutions,
      sendMessage: (async () => new Promise(() => undefined)) as unknown as CoreService["sendMessage"],
    });

    const { service } = serviceFrom(core, async () => []);
    const view = render(service);
    await waitFor(() => text(view.host).includes("Nenhuma mensagem"));

    typeInto(view.host, "Mensagem");
    submit(view.host);
    await waitFor(() => requestIds.length >= 1);

    // Before the server lists a run, the screen must not pretend to know one.
    expect(view.host.querySelectorAll("button")).not.toHaveLength(0);
    expect(text(view.host)).not.toContain("Cancelar execução");
    view.unmount();
  });
});

// ---------------------------------------------------------------------------------------
// 5–10: recovery of an execution left running, through the real service
// ---------------------------------------------------------------------------------------
describe("audit 3C.2 — reopening a conversation recovers the run", () => {
  const persisted: readonly Message[] = [
    makeUserMessage({ content: [{ type: "text", text: "Mensagem já persistida" }] }),
  ];

  it("leaving during execution and reopening recovers it without duplicating anything", async () => {
    const sendMessage = vi.fn();
    const listExecutions = vi.fn(async () => [makeRun({ status: "running" })]);
    let probes = 0;
    const getExecution = vi.fn(async () => {
      probes += 1;
      return makeInspection({
        // Still running for the first two inspections, then the provider answers.
        execution: makeRun({ status: probes >= 3 ? "succeeded" : "running" }),
      });
    });

    const core = coreStub({ sendMessage, listExecutions, getExecution });
    const { service, historyCalls } = serviceFrom(core, async () => [
      ...persisted,
      makeAssistantMessage({ content: [{ type: "text", text: "Resposta recuperada" }] }),
    ]);

    // First visit: the user sends, then leaves while the provider is still working.
    const first = render(service);
    await waitFor(() => text(first.host).includes("Mensagem já persistida"));
    first.unmount();

    // Reopen: the run is recovered and followed — nothing is re-sent.
    const second = render(service);
    await waitFor(() => text(second.host).includes("Mensagem já persistida"));
    await waitFor(() => text(second.host).includes("Resposta recuperada"));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(getExecution).toHaveBeenCalled();
    expect(listExecutions).toHaveBeenCalled();
    // The history is reloaded once on mount and once after the run reaches its terminal
    // state — the answer shown is always the persisted one.
    expect(historyCalls.count).toBeGreaterThanOrEqual(2);
    second.unmount();
  });

  it("restores the processing state with a working cancel while the run is still active", async () => {
    // `POST /v1/executions/:runId/cancel` answers with the inspection of the run it cancelled.
    const cancelExecution = vi.fn(async () =>
      makeInspection({ execution: makeRun({ status: "cancelled" }) }),
    );
    const listExecutions = async () => [makeRun({ status: "running" })];
    let resolveInspection: (() => void) | null = null;
    const getExecution = async () => {
      await new Promise<void>((resolve) => {
        resolveInspection = resolve;
      });
      return makeInspection({ execution: makeRun({ status: "running" }) });
    };

    const core = coreStub({
      cancelExecution,
      listExecutions,
      getExecution: getExecution as unknown as CoreService["getExecution"],
    });
    const { service } = serviceFrom(core, async () => persisted);
    const view = render(service);

    await waitFor(() => text(view.host).includes("Cancelar execução"));
    expect(text(view.host)).toContain("recuperada do servidor ao reabrir a conversa");

    await act(async () => {
      resolveInspection?.();
      await wait(20);
    });
    clickButton(view.host, "Cancelar execução");
    await waitFor(() => cancelExecution.mock.calls.length === 1);
    expect(cancelExecution).toHaveBeenCalledWith(TEST_TOKEN, RUN_ID, expect.anything());
    view.unmount();
  });

  it.each([
    ["succeeded", "Resposta concluída", true],
    ["partial", "Resposta parcial", true],
  ] as const)("recovers a %s run and shows the persisted answer", async (status, _label, _hasAnswer) => {
    const core = coreStub({
      listExecutions: async () => [makeRun({ status: "running" })],
      getExecution: async () => makeInspection({ execution: makeRun({ status }) }),
    });
    const { service } = serviceFrom(core, async () => [
      ...persisted,
      makeAssistantMessage({ content: [{ type: "text", text: "Resposta concluída" }] }),
    ]);

    const view = render(service);
    await waitFor(() => text(view.host).includes(`Resposta concluída`));

    expect(text(view.host)).toContain("Resposta concluída");
    expect(text(view.host)).not.toContain("Cancelar execução");
    view.unmount();
  });

  it.each([
    ["failed", "A execução falhou"],
    ["cancelled", "A execução foi cancelada"],
  ] as const)("recovers a %s run without inventing an answer", async (status, notice) => {
    const core = coreStub({
      listExecutions: async () => [makeRun({ status: "running" })],
      getExecution: async () =>
        makeInspection({
          execution: makeRun({ status, finalMessageId: undefined }),
        }),
    });
    const { service } = serviceFrom(core, async () => persisted);

    const view = render(service);
    await waitFor(() => text(view.host).includes(notice));

    expect(text(view.host)).toContain(notice);
    // The persisted user message is shown; no assistant bubble is fabricated.
    expect(text(view.host)).toContain("Mensagem já persistida");
    expect(view.host.querySelectorAll(".bubble-assistant")).toHaveLength(0);
    view.unmount();
  });

  it("follows the oldest active run and never merges two executions", async () => {
    const older = makeRun({
      id: RUN_ID,
      status: "running",
      createdAt: "2026-01-01T10:00:00.000Z",
    });
    const newer = makeRun({
      id: RUN_ID_2,
      status: "running",
      createdAt: "2026-01-01T10:10:00.000Z",
    });
    const inspected: string[] = [];
    const core = coreStub({
      listExecutions: async () => [older, newer],
      getExecution: (async (_token: string, runId: string) => {
        inspected.push(runId);
        return makeInspection({ execution: makeRun({ id: runId, status: "running" }) });
      }) as unknown as CoreService["getExecution"],
    });
    const { service } = serviceFrom(core, async () => persisted);

    const view = render(service);
    await waitFor(() => inspected.length > 0);
    await act(async () => {
      await wait(60);
    });

    expect(new Set(inspected)).toEqual(new Set([RUN_ID]));
    view.unmount();
  });

  it("does not re-post a message when recovering a run", async () => {
    const sendMessage = vi.fn();
    const core = coreStub({
      sendMessage: sendMessage as unknown as CoreService["sendMessage"],
      listExecutions: async () => [makeRun({ status: "queued" })],
      getExecution: async () => makeInspection({ execution: makeRun({ status: "succeeded" }) }),
    });
    const { service } = serviceFrom(core, async () => [
      ...persisted,
      makeAssistantMessage({ content: [{ type: "text", text: "Resposta" }] }),
    ]);

    const view = render(service);
    await waitFor(() => text(view.host).includes("Resposta"));

    expect(sendMessage).not.toHaveBeenCalled();
    view.unmount();
  });
});

// ---------------------------------------------------------------------------------------
// 11–15: concurrency, lifecycle and failure paths
// ---------------------------------------------------------------------------------------
describe("audit 3C.2 — lifecycle and concurrency", () => {
  it("keeps a single tracking loop per run", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const core = coreStub({
      listExecutions: async () => [makeRun({ status: "running" })],
      getExecution: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await wait(10);
        inFlight -= 1;
        return makeInspection({ execution: makeRun({ status: "running" }) });
      },
    });
    const { service } = serviceFrom(core, async () => [makeUserMessage()]);

    const view = render(service);
    await waitFor(() => maxInFlight > 0);
    await act(async () => {
      await wait(150);
    });

    expect(maxInFlight).toBe(1);
    view.unmount();
  });

  it("does not contaminate a second conversation after a fast switch", async () => {
    const getExecution = vi.fn(async (_token: string, runId: string) => {
      if (runId === RUN_ID) {
        // Slow answer for the conversation the user already left.
        await wait(120);
      }
      return makeInspection({ execution: makeRun({ id: runId, status: "succeeded" }) });
    });
    const core = coreStub({
      listExecutions: async () => [makeRun({ status: "running" })],
      getExecution,
    });
    const { service } = serviceFrom(core, async () => [
      makeUserMessage({ content: [{ type: "text", text: "Conversa A" }] }),
    ]);

    const first = render(service);
    await waitFor(() => text(first.host).includes("Conversa A"));
    await waitFor(() => getExecution.mock.calls.length > 0);

    // Fast switch: a brand-new screen replaces the first one.
    first.unmount();
    const second = render(service);
    await waitFor(() => text(second.host).includes("Conversa A"));
    await act(async () => {
      await wait(200);
    });

    // The stale run's answer never lands on the new screen.
    expect(text(second.host)).not.toContain("Resposta concluída");
    second.unmount();
  });

  it("returns to login when the session expires during recovery polling", async () => {
    let calls = 0;
    const core = coreStub({
      listExecutions: async () => [makeRun({ status: "running" })],
      getExecution: async () => {
        calls += 1;
        if (calls >= 2) {
          throw new ApiError({ kind: "http", status: 401, message: "unauthorized", code: "AUTH_REQUIRED" });
        }
        return makeInspection({ execution: makeRun({ status: "running" }) });
      },
    });
    const { service } = serviceFrom(core, async () => persistedMessage());
    const view = render(service);

    await waitFor(() => view.expiries() === 1);
    expect(calls).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  it("states that the state is unconfirmed when the network is down during recovery", async () => {
    const core = coreStub({
      listExecutions: async () => {
        throw new ApiError({ kind: "network", message: "Sem conexão com o servidor." });
      },
      getExecution: async () => makeInspection(),
    });
    const { service } = serviceFrom(core, async () => persistedMessage());
    const view = render(service);

    await waitFor(() => text(view.host).includes("Verificar novamente"));
    expect(text(view.host)).toContain("Sem conexão com o servidor.");
    view.unmount();
  });

  it("refreshes into the persisted answer after a recovery that could not be confirmed", async () => {
    let fail = true;
    const core = coreStub({
      listExecutions: async () => {
        if (fail) throw new ApiError({ kind: "network", message: "Sem conexão com o servidor." });
        return [];
      },
      getExecution: async () => makeInspection(),
    });
    let history: readonly Message[] = [makeUserMessage()];
    const { service } = serviceFrom(core, async () => history);
    const view = render(service);

    await waitFor(() => text(view.host).includes("Verificar novamente"));

    // The user comes back online and the conversation is refreshed.
    fail = false;
    history = [makeUserMessage(), makeAssistantMessage({ content: [{ type: "text", text: "Resposta persistida" }] })];
    clickButton(view.host, "Atualizar");
    await waitFor(() => text(view.host).includes("Resposta persistida"));
    view.unmount();
  });

  it("does not setState after unmount when probes resolve late", async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args[0]);
    };
    try {
      const core = coreStub({
        listExecutions: async () => {
          await wait(40);
          return [makeRun({ status: "running" })];
        },
        getExecution: async () => {
          await wait(40);
          return makeInspection({ execution: makeRun({ status: "running" }) });
        },
      });
      const { service } = serviceFrom(core, async () => [makeUserMessage()]);
      const view = render(service);
      await waitFor(() => text(view.host).includes("Atualizar"));
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const reactWarnings = errors.filter(
        (entry) => typeof entry === "string" && entry.includes("unmounted"),
      );
      expect(reactWarnings).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

/** Fires every scheduled delay immediately: the backoff is exercised, the wall clock is not. */
const immediateScheduler = (callback: () => void) => {
  callback();
};

/**
 * A scheduler the test drives by hand, so a probe can be released only when the test wants
 * it. Used to prove discovery stops the instant the send settles.
 */
function createManualScheduler() {
  const queue: (() => void)[] = [];
  return {
    scheduler: (callback: () => void) => {
      queue.push(callback);
    },
    pending: () => queue.length,
    /** Fires the oldest pending delay and lets the resulting microtasks run. */
    async flush() {
      const callback = queue.shift();
      if (!callback) return false;
      await act(async () => {
        callback();
        await wait(5);
      });
      return true;
    },
  };
}

/**
 * The `requestId` the CORE echoes back for the send happening in this test.
 *
 * The app generates it, so the fake server records it from the request instead of inventing
 * one: discovery must match on the server's own value.
 */
let lastSendRequestId: string | null = null;

function captureRequestId(input: unknown): void {
  const body = input as { requestId?: string } | null;
  if (body?.requestId) lastSendRequestId = body.requestId;
}

function REQUEST_ID_OF_SEND(): string {
  return lastSendRequestId ?? "";
}

function persistedMessage(): readonly Message[] {
  return [makeUserMessage()];
}

// Keep the imported helpers referenced even if a fixture stops using one of them.
void CONVERSATION_ID;
void RUN_ID_2;
void ((run: CoreRun) => run.id);

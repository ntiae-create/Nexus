import { describe, expect, it } from "vitest";
import type { ProviderPreferenceSet } from "@nexus/shared";
import { OWNER_ID } from "../auth/session.js";
import {
  createModelSelectionService,
  createOpenRouterAdapter,
  createProviderCatalogService,
  deriveModelId,
  OPENROUTER_PROVIDER_ID,
} from "./index.js";
import { ProviderError } from "./types.js";

/**
 * Fase 0 — caracterização da política `free_only`.
 *
 * O que já existe e cobre o caminho manual (`catalog-and-selection.test.ts`): modelo pago →
 * `PAID_MODEL_BLOCKED`; preço desconhecido → `UNVERIFIED_PRICING_BLOCKED`; modelo offline →
 * `MODEL_UNAVAILABLE`; provider/modelo inexistente → `INVALID_SELECTION`.
 *
 * O que faltava — e é o que esta suíte fixa — são as garantias do **modo automático**, onde não
 * existe preferência explícita para culpar. É justamente aí que um fallback pago silencioso
 * poderia se esconder.
 */

const FAKE_TEST_KEY = "test-only-fake-openrouter-credential-freeonly-331";
const FIXED_EPOCH = 1_700_000_000_000;
const FIXED_NOW = "2026-11-05T00:00:00.000Z";

function catalogWith(models: readonly unknown[]) {
  const adapter = createOpenRouterAdapter({
    apiKey: FAKE_TEST_KEY,
    fetchFn: (async () =>
      new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
    now: () => FIXED_EPOCH,
  });
  return createProviderCatalogService({ adapters: [adapter], ttlMs: 30_000, now: () => FIXED_EPOCH });
}

function automaticPrefs(): ProviderPreferenceSet {
  return {
    global: {
      id: OWNER_ID,
      userId: OWNER_ID,
      selection: { mode: "automatic" },
      updatedAt: FIXED_NOW,
    },
    byAssistant: [],
    byConversation: [],
  };
}

const PAID_MODEL = {
  id: "anthropic/claude-sonnet-4",
  name: "Claude Sonnet 4 (Paid)",
  context_length: 200000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  supported_parameters: ["temperature", "max_tokens"],
};

const FREE_MODEL = {
  id: "qwen/qwen3-coder:free",
  name: "Qwen 3 Coder Free",
  context_length: 65536,
  pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["temperature", "max_tokens"],
};

describe("Fase 0 — free_only no modo automático", () => {
  it("nunca cai para um modelo pago quando o catálogo só tem pagos", async () => {
    // Cenário sem alternativa gratuita: o resultado correto é indisponibilidade explícita,
    // nunca um modelo pago escolhido "porque era o único que servia".
    const selection = createModelSelectionService({
      catalog: catalogWith([PAID_MODEL]),
      now: () => FIXED_EPOCH,
    });

    const error = await selection
      .resolveEffectiveSelection(automaticPrefs())
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("MODEL_UNAVAILABLE");
    // A mensagem/estrutura declara a política: o detalhe é o que impede alguém de "consertar"
    // a falha introduzindo fallback pago sem perceber que ele é proibido.
    expect((error as ProviderError).details).toMatchObject({ paidFallbackAllowed: false });
  });

  it("nunca escolhe um modelo de preço desconhecido automaticamente", async () => {
    const unverified = {
      id: "vendor/ambiguous-price:free",
      name: "Ambiguous Price Free",
      context_length: 32768,
      pricing: null,
      supported_parameters: ["temperature"],
    };
    const catalog = catalogWith([unverified]);

    // O catálogo já separa elegíveis de bloqueados; o automático só enxerga os elegíveis.
    const eligible = await catalog.listEligibleModels();
    expect(eligible.models).toEqual([]);
    expect(eligible.summary.blockedUnverifiedCount).toBe(1);

    const selection = createModelSelectionService({ catalog, now: () => FIXED_EPOCH });
    await expect(selection.resolveEffectiveSelection(automaticPrefs())).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
    });
  });

  it("não promove um modelo free offline a elegível", async () => {
    const offline = {
      id: "google/gemma-offline:free",
      name: "Gemma Offline Free",
      context_length: 32768,
      unavailable: true,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["temperature"],
    };
    const catalog = catalogWith([offline]);

    const eligible = await catalog.listEligibleModels();
    expect(eligible.models).toEqual([]);
    expect(eligible.unavailableModels.map((model) => model.key)).toEqual([offline.id]);

    const selection = createModelSelectionService({ catalog, now: () => FIXED_EPOCH });
    await expect(selection.resolveEffectiveSelection(automaticPrefs())).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
    });
  });

  it("escolhe o modelo gratuito quando existe um, ignorando o pago", async () => {
    // Contraprova: a política não bloqueia tudo — ela só exclui o que não é gratuito verificado.
    const selection = createModelSelectionService({
      catalog: catalogWith([PAID_MODEL, FREE_MODEL]),
      now: () => FIXED_EPOCH,
    });

    const resolved = await selection.resolveEffectiveSelection(automaticPrefs());
    expect(resolved.resolvedScope).toBe("global");
    expect(resolved.preference).toEqual({ mode: "automatic" });
    expect(resolved.model.id).toBe(deriveModelId(OPENROUTER_PROVIDER_ID, FREE_MODEL.id));
    expect(resolved.model.freeEligibility.eligible).toBe(true);
    expect(resolved.model.freeEligibility.costStatus).toBe("free_confirmed");
    expect(resolved.model.freeEligibility.reason).toBe("verified_free");
  });
});

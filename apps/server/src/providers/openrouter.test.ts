import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterAdapter,
  evaluateOpenRouterModel,
  isOpenRouterFreeModelKey,
  loadOpenRouterConfig,
  OPENROUTER_PROVIDER_ID,
  ProviderError,
  redactSecrets,
  verifyOpenRouterPricing,
} from "./index.js";

const FAKE_TEST_CREDENTIAL = "test-only-fake-openrouter-credential-alpha-991";
const FIXED_NOW_MS = Date.parse("2026-11-05T12:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSampleRawModels() {
  return [
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      name: "Meta: Llama 3.3 70B Instruct (free)",
      context_length: 131072,
      architecture: {
        modality: "text->text",
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      pricing: {
        prompt: "0",
        completion: "0",
        request: "0",
        image: "0",
      },
      top_provider: {
        context_length: 131072,
        max_completion_tokens: 8192,
      },
      supported_parameters: [
        "temperature",
        "top_p",
        "max_tokens",
        "stop",
        "response_format",
      ],
    },
    {
      id: "openai/gpt-4o",
      name: "OpenAI: GPT-4o",
      context_length: 128000,
      pricing: {
        prompt: "0.0000025",
        completion: "0.00001",
      },
      supported_parameters: ["temperature", "max_tokens"],
    },
    {
      id: "vendor/deceptive-paid:free",
      name: "Vendor: Deceptive Non-Zero Free Suffix",
      context_length: 32768,
      pricing: {
        prompt: "0",
        completion: "0.000001",
      },
      supported_parameters: ["temperature"],
    },
    {
      id: "vendor/missing-price:free",
      name: "Vendor: Missing Price Free Suffix",
      context_length: 32768,
      pricing: {
        prompt: "0",
      },
      supported_parameters: ["temperature"],
    },
    {
      id: "vendor/offline-model:free",
      name: "Vendor: Offline Free Model",
      context_length: 32768,
      unavailable: true,
      pricing: {
        prompt: "0",
        completion: "0",
      },
      supported_parameters: ["temperature"],
    },
  ];
}

describe("OpenRouter free-eligibility & pricing verifier", () => {
  it("accepts strictly ':free' suffixed model keys and rejects paid or malformed keys", () => {
    expect(isOpenRouterFreeModelKey("meta-llama/llama-3.3-70b-instruct:free")).toBe(true);
    expect(isOpenRouterFreeModelKey("qwen/qwen3-coder:free")).toBe(true);
    expect(isOpenRouterFreeModelKey("openai/gpt-4o")).toBe(false);
    expect(isOpenRouterFreeModelKey("meta-llama/llama-3.3:FREE")).toBe(false);
    expect(isOpenRouterFreeModelKey(":free")).toBe(false);
    expect(isOpenRouterFreeModelKey("model::free")).toBe(false);
    expect(isOpenRouterFreeModelKey("meta llama/model:free")).toBe(false);
  });

  it("verifies zero pricing fail-closed across prompt, completion, and auxiliary price fields", () => {
    expect(
      verifyOpenRouterPricing({
        prompt: "0",
        completion: "0",
        request: "0",
        image: "0.000000",
      }).status,
    ).toBe("zero_confirmed");

    expect(
      verifyOpenRouterPricing({
        prompt: "0",
        completion: "0.000001",
      }).status,
    ).toBe("paid");

    expect(
      verifyOpenRouterPricing({
        prompt: "0",
        completion: "0",
        request: "0.01",
      }).status,
    ).toBe("paid");

    expect(verifyOpenRouterPricing(null).status).toBe("unverifiable");
    expect(verifyOpenRouterPricing({}).status).toBe("unverifiable");
    expect(verifyOpenRouterPricing({ prompt: "0" }).status).toBe("unverifiable");
    expect(
      verifyOpenRouterPricing({ prompt: "-1", completion: "-1" }).status,
    ).toBe("unverifiable");
    expect(
      verifyOpenRouterPricing({ prompt: "free", completion: "0" }).status,
    ).toBe("unverifiable");
  });

  it("classifies eligible free, paid, zero-without-suffix, unverified, and unavailable free models", () => {
    const eligible = evaluateOpenRouterModel(
      {
        id: "qwen/qwen3-coder:free",
        name: "Qwen 3 Coder (free)",
        context_length: 65536,
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: ["temperature", "top_p", "max_tokens", "reasoning"],
      },
      { nowMs: FIXED_NOW_MS },
    );
    expect(eligible.freeEligibility.eligible).toBe(true);
    expect(eligible.freeEligibility.costStatus).toBe("free_confirmed");
    expect(eligible.availability).toBe("available");
    expect(eligible.capabilities).toContain("code");
    expect(eligible.capabilities).toContain("reasoning");

    const zeroPriceWithoutFreeSuffix = evaluateOpenRouterModel(
      {
        id: "vendor/zero-without-suffix",
        pricing: { prompt: "0", completion: "0" },
      },
      { nowMs: FIXED_NOW_MS },
    );
    expect(zeroPriceWithoutFreeSuffix.freeEligibility.eligible).toBe(false);
    expect(zeroPriceWithoutFreeSuffix.freeEligibility.reason).toBe(
      "missing_free_suffix",
    );

    const expiredFree = evaluateOpenRouterModel(
      {
        id: "vendor/expired:free",
        expiration_date: "2026-01-01T00:00:00.000Z",
        pricing: { prompt: "0", completion: "0" },
      },
      { nowMs: FIXED_NOW_MS },
    );
    expect(expiredFree.freeEligibility.eligible).toBe(false);
    expect(expiredFree.freeEligibility.costStatus).toBe("free_confirmed");
    expect(expiredFree.availability).toBe("unavailable");
    expect(expiredFree.freeEligibility.reason).toBe("model_unavailable");
  });
});

describe("OpenRouterAdapter", () => {
  it("executes generation for a verified ':free' model and normalizes response", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });

      if (url.endsWith("/models") && method === "GET") {
        return jsonResponse({ data: makeSampleRawModels() });
      }
      if (url.endsWith("/chat/completions") && method === "POST") {
        return jsonResponse({
          id: "gen-free-001",
          model: "meta-llama/llama-3.3-70b-instruct",
          created: 1_762_344_000,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Resposta verificada e gratuita.",
              },
            },
          ],
          usage: {
            prompt_tokens: 18,
            completion_tokens: 9,
            total_tokens: 27,
            cost: 0,
          },
        });
      }
      return jsonResponse({ error: { message: "Unexpected endpoint" } }, 404);
    }) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      baseUrl: "https://openrouter.example.test/api/v1",
      fetchFn,
      now: () => FIXED_NOW_MS,
    });

    const result = await adapter.generate({
      model: "meta-llama/llama-3.3-70b-instruct:free",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Ping" },
      ],
      parameters: {
        temperature: 0.3,
        maxOutputTokens: 128,
      },
    });

    // Must verify /models live BEFORE calling /chat/completions
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://openrouter.example.test/api/v1/models",
      method: "GET",
    });
    expect(calls[1]).toMatchObject({
      url: "https://openrouter.example.test/api/v1/chat/completions",
      method: "POST",
      body: {
        model: "meta-llama/llama-3.3-70b-instruct:free",
        temperature: 0.3,
        max_tokens: 128,
      },
    });

    expect(result.providerId).toBe(OPENROUTER_PROVIDER_ID);
    expect(result.providerKey).toBe("openrouter");
    expect(result.modelKey).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(result.content).toBe("Resposta verificada e gratuita.");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      inputTokens: 18,
      outputTokens: 9,
      totalTokens: 27,
    });
    expect(result.freeEligibility.eligible).toBe(true);
    expect(result.freeEligibility.costStatus).toBe("free_confirmed");
  });

  it("blocks paid models immediately without issuing any network call to /chat/completions", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn,
    });

    await expect(
      adapter.generate({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "PAID_MODEL_BLOCKED",
      statusCode: 403,
      retryable: false,
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("re-verifies live pricing before every generation and blocks a ':free' model whose pricing turned paid or unverifiable", async () => {
    let modelsCallCount = 0;
    let completionCalled = false;

    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        modelsCallCount += 1;
        if (modelsCallCount === 1) {
          // Initially free when catalog was queried earlier
          return jsonResponse({
            data: [
              {
                id: "vendor/volatile:free",
                pricing: { prompt: "0", completion: "0" },
              },
            ],
          });
        }
        // Later changed to non-zero pricing before generate() was invoked!
        return jsonResponse({
          data: [
            {
              id: "vendor/volatile:free",
              pricing: { prompt: "0.0001", completion: "0.0002" },
            },
          ],
        });
      }
      completionCalled = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn,
    });

    const initialCatalog = await adapter.listModels();
    expect(initialCatalog[0]?.freeEligibility.eligible).toBe(true);

    await expect(
      adapter.generate({
        model: "vendor/volatile:free",
        messages: [{ role: "user", content: "Test" }],
      }),
    ).rejects.toMatchObject({
      code: "PAID_MODEL_BLOCKED",
      statusCode: 403,
    });

    expect(completionCalled).toBe(false);
  });

  it("blocks models without verifiable pricing before generation", async () => {
    let completionCalled = false;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) {
        return jsonResponse({ data: makeSampleRawModels() });
      }
      completionCalled = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn,
    });

    await expect(
      adapter.generate({
        model: "vendor/missing-price:free",
        messages: [{ role: "user", content: "Test" }],
      }),
    ).rejects.toMatchObject({
      code: "UNVERIFIED_PRICING_BLOCKED",
      statusCode: 403,
    });

    expect(completionCalled).toBe(false);
  });

  it("fails explicitly when a ':free' model is unavailable or missing from live catalog", async () => {
    let completionCalled = false;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) {
        return jsonResponse({ data: makeSampleRawModels() });
      }
      completionCalled = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn,
    });

    await expect(
      adapter.generate({
        model: "vendor/offline-model:free",
        messages: [{ role: "user", content: "Test" }],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      statusCode: 503,
    });

    await expect(
      adapter.generate({
        model: "vendor/non-existent:free",
        messages: [{ role: "user", content: "Test" }],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      statusCode: 503,
    });

    expect(completionCalled).toBe(false);
  });

  it("fails explicitly with NOT_CONFIGURED when OPENROUTER_API_KEY is absent", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const config = loadOpenRouterConfig({});
    expect(config.apiKey).toBeUndefined();

    const adapter = createOpenRouterAdapter({
      apiKey: config.apiKey,
      fetchFn,
    });

    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.getStatus().availability).toBe("unavailable");

    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      statusCode: 503,
      retryable: false,
    });

    await expect(
      adapter.generate({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      statusCode: 503,
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("handles request timeouts explicitly via AbortController", async () => {
    const fetchFn = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const abortErr = new Error("The operation was aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            },
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      timeoutMs: 25,
      fetchFn,
    });

    await expect(adapter.listModels()).rejects.toMatchObject({
      code: "TIMEOUT",
      statusCode: 504,
      retryable: true,
    });
  });

  it("normalizes HTTP errors (401, 402, 404, 429, 503) without bypassing quotas or inventing responses", async () => {
    const statuses: Array<{
      status: number;
      expectedCode: ProviderError["code"];
      expectedRetryable: boolean;
    }> = [
      { status: 401, expectedCode: "AUTHENTICATION_FAILED", expectedRetryable: false },
      { status: 402, expectedCode: "PAID_MODEL_BLOCKED", expectedRetryable: false },
      { status: 404, expectedCode: "MODEL_UNAVAILABLE", expectedRetryable: false },
      { status: 429, expectedCode: "RATE_LIMITED", expectedRetryable: true },
      { status: 503, expectedCode: "UNAVAILABLE", expectedRetryable: true },
    ];

    for (const item of statuses) {
      const fetchFn = vi.fn(async () =>
        jsonResponse(
          { error: { code: item.status, message: `Upstream HTTP ${item.status}` } },
          item.status,
        ),
      ) as unknown as typeof fetch;

      const adapter = createOpenRouterAdapter({
        apiKey: FAKE_TEST_CREDENTIAL,
        fetchFn,
      });

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: item.expectedCode,
        retryable: item.expectedRetryable,
      });
      // Must never retry automatically to bypass quotas/limits
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed JSON, missing catalog arrays, missing choices, and unexpected paid response routing", async () => {
    // 1. Invalid JSON on /models
    const invalidJsonAdapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn: (async () =>
        new Response("<html>gateway broken</html>", { status: 200 })) as typeof fetch,
    });
    await expect(invalidJsonAdapter.listModels()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      statusCode: 502,
    });

    // 2. Malformed /models schema (missing `data` array)
    const missingDataAdapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn: (async () => jsonResponse({ models: [] })) as typeof fetch,
    });
    await expect(missingDataAdapter.listModels()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    // 3. Malformed /chat/completions response (empty choices)
    const malformedCompletionAdapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/models")) {
          return jsonResponse({ data: makeSampleRawModels() });
        }
        return jsonResponse({ id: "gen-bad", choices: [] });
      }) as typeof fetch,
    });
    await expect(
      malformedCompletionAdapter.generate({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    // 4. Completion response reporting non-zero cost or unauthorized paid model substitution
    const unexpectedCostAdapter = createOpenRouterAdapter({
      apiKey: FAKE_TEST_CREDENTIAL,
      fetchFn: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/models")) {
          return jsonResponse({ data: makeSampleRawModels() });
        }
        return jsonResponse({
          id: "gen-cost",
          model: "openai/gpt-4o",
          choices: [{ message: { content: "Should never pass" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0.02 },
        });
      }) as typeof fetch,
    });
    await expect(
      unexpectedCostAdapter.generate({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toMatchObject({
      code: "PAID_MODEL_BLOCKED",
    });
  });

  it("prevents credential leakage across error messages, causes, stacks, and serialized payloads", async () => {
    const rawKey = FAKE_TEST_CREDENTIAL;
    const base64Key = Buffer.from(rawKey, "utf8").toString("base64");

    const syntheticPrefixSample = ["sk", "or", "v1", "syntheticpattern000000"].join(
      "-",
    );
    const redactedSample = redactSecrets(
      `Header Authorization: Bearer ${rawKey} and encoded=${base64Key} and ${syntheticPrefixSample}`,
      [rawKey],
    );
    expect(redactedSample).not.toContain(rawKey);
    expect(redactedSample).not.toContain(syntheticPrefixSample);

    const fetchFn = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 401,
            message: `Invalid key ${rawKey} in Authorization: Bearer ${rawKey}`,
          },
        },
        401,
      ),
    ) as unknown as typeof fetch;

    const adapter = createOpenRouterAdapter({
      apiKey: rawKey,
      fetchFn,
    });

    let caughtError: ProviderError | undefined;
    try {
      await adapter.listModels();
    } catch (err) {
      caughtError = err as ProviderError;
    }

    expect(caughtError).toBeInstanceOf(ProviderError);
    const serialized = JSON.stringify({
      message: caughtError!.message,
      stack: caughtError!.stack,
      apiError: caughtError!.toApiError(),
      causeMessage:
        caughtError!.cause instanceof Error ? caughtError!.cause.message : undefined,
    });
    expect(serialized).not.toContain(rawKey);
    expect(serialized).toContain("[REDACTED]");
  });
});

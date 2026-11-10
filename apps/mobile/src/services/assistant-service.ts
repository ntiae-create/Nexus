import { z } from "zod";
import { ApiError } from "./api-client.js";
import type { CoreService } from "./core-service.js";
import {
  applyCatalogFromApi,
  resetAssistantCatalog,
  type AssistantApiRecord,
} from "../lib/assistants.js";

/**
 * Loads the assistant catalog from `GET /v1/assistants`.
 *
 * Fase 2 (G6): o catálogo de apresentação vinha de listas literais no app. Agora vem do
 * servidor, que por sua vez deriva de `@nexus/assistant-profiles`.
 *
 * Contrato de falha: este carregamento **nunca** lança. Se a API estiver indisponível, o app
 * continua com o fallback de build e a tela permanece utilizável — indisponibilidade de rede não
 * pode impedir o usuário de abrir o app.
 */

const assistantRecordSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  primaryRole: z.string(),
  capabilities: z.array(z.string()),
  status: z.string(),
});

/**
 * `min(1)`: uma resposta vazia é sintaticamente válida e praticamente inútil — sem assistente o
 * usuário não abre conversa. Tratá-la como inválida mantém o fallback e o app funcionando.
 */
const assistantListSchema = z.object({
  assistants: z.array(assistantRecordSchema).min(1),
});

export type AssistantCatalogOutcome =
  /** The API answered and the catalog was replaced. */
  | { readonly status: "loaded"; readonly count: number }
  /** The API answered with something unusable; the fallback stays in place. */
  | { readonly status: "invalid" }
  /** The API could not be reached; the fallback stays in place. */
  | { readonly status: "unavailable" }
  /**
   * A newer load (or a session change) superseded this one; the response was discarded so it
   * cannot overwrite a fresher catalog.
   */
  | { readonly status: "superseded" };

/**
 * Monotonic generation counter for catalog loads.
 *
 * The catalog lives in module state, so two overlapping loads can settle out of order: the slow
 * one for session A can land after the fast one for session B and reintroduce an assistant that
 * the second session never saw. Every load takes a ticket; only the newest ticket may write.
 * `resetAssistantCatalog()` (logout/session change) bumps the counter so any in-flight load from
 * the previous session becomes stale.
 */
let generation = 0;

/**
 * Marks every in-flight load as superseded and restores the build fallback.
 *
 * Call on logout and before starting a session: the previous session's catalog must not stay
 * visible, and any response still in flight for it must not be applied.
 */
export function abandonAssistantCatalog(): void {
  generation += 1;
  resetAssistantCatalog();
}

/** Busca o catálogo e aplica em `ASSISTANT_CATALOG` quando esta chamada ainda for a mais recente. */
export async function loadAssistantCatalog(input: {
  readonly service: Pick<CoreService, "listAssistants">;
  readonly token: string;
  readonly signal?: AbortSignal;
}): Promise<AssistantCatalogOutcome> {
  const ticket = (generation += 1);

  let payload: unknown;
  try {
    payload = await input.service.listAssistants(input.token, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof ApiError || error instanceof Error) {
      return { status: "unavailable" };
    }
    return { status: "unavailable" };
  }

  // Uma resposta que perdeu a corrida não pode tocar no catálogo — nem para validar.
  if (ticket !== generation) return { status: "superseded" };

  const parsed = assistantListSchema.safeParse(payload);
  if (!parsed.success) return { status: "invalid" };

  const records: AssistantApiRecord[] = parsed.data.assistants.map((assistant) => ({
    id: assistant.id,
    key: assistant.key,
    name: assistant.name,
    description: assistant.description,
    primaryRole: assistant.primaryRole,
    capabilities: assistant.capabilities,
    status: assistant.status,
  }));

  const applied = applyCatalogFromApi(records);
  return applied ? { status: "loaded", count: records.length } : { status: "invalid" };
}

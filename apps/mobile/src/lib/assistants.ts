import {
  listAssistantProfiles,
  type AssistantProfile,
} from "@nexus/assistant-profiles";
import { assistantKeySchema } from "@nexus/shared";

/**
 * Assistant catalog for display and selection.
 *
 * Fase 2 (G6): antes desta fase o mobile mantinha **duas** listas literais independentes — esta
 * e um `ASSISTANTS` em `config.ts` — com ids, nomes e descrições escritos à mão. Adicionar um
 * assistente exigia editar o app.
 *
 * A fonte de verdade é o servidor (`GET /v1/assistants`, derivado de
 * `@nexus/assistant-profiles`). O app carrega o catálogo no início e usa o **fallback de build**
 * abaixo quando a API ainda não respondeu ou está indisponível.
 *
 * O fallback **não é** uma nova lista manual: ele é derivado dos perfis congelados do pacote
 * compartilhado, no mesmo import que o bundler já resolve. Assim, quando o catálogo canônico
 * mudar, o fallback acompanha no próximo build — sem edição manual e sem divergência silenciosa.
 *
 * Escopo preservado: este módulo é apresentação. Quem decide quem responde é o servidor; o
 * cliente apenas envia `assistantKey` que o contrato já aceita, e só oferece assistentes da
 * conversa atual.
 */

/** Registro mínimo que a API devolve para cada assistente (`GET /v1/assistants`). */
export interface AssistantApiRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly primaryRole: string;
  readonly capabilities: readonly string[];
  readonly status: string;
}

/** O que uma tela precisa saber sobre um assistente para exibi-lo. */
export interface AssistantOption {
  readonly key: string;
  /** Canonical UUID used when creating a conversation (`assistantIds`). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly primaryRole: string;
  readonly capabilities: readonly string[];
  readonly status: string;
}

function toOption(profile: AssistantProfile): AssistantOption {
  return Object.freeze({
    key: profile.key,
    id: profile.id,
    name: profile.name,
    description: profile.description ?? "",
    primaryRole: profile.primaryRole,
    capabilities: Object.freeze([...profile.capabilities]),
    status: profile.status,
  });
}

/**
 * Fallback de build: derivado dos perfis congelados, na ordem do catálogo canônico.
 * Congelado em profundidade para que nenhuma tela o mute em runtime.
 */
export const FALLBACK_CATALOG: readonly AssistantOption[] = Object.freeze(
  listAssistantProfiles().map(toOption),
);

/**
 * Catálogo em uso.
 *
 * Começa no fallback e é **substituído** pela resposta da API quando ela chega. A identidade do
 * array é estável (`ASSISTANT_CATALOG` continua sendo a mesma referência) para que consumidores
 * possam importá-lo diretamente; o conteúdo é trocado in-place por `applyCatalogFromApi`.
 */
export const ASSISTANT_CATALOG: AssistantOption[] = [...FALLBACK_CATALOG];

let indexByKey = new Map<string, AssistantOption>(
  ASSISTANT_CATALOG.map((assistant) => [assistant.key, assistant]),
);
let indexById = new Map<string, AssistantOption>(
  ASSISTANT_CATALOG.map((assistant) => [assistant.id, assistant]),
);

function rebuildIndexes(): void {
  indexByKey = new Map(ASSISTANT_CATALOG.map((assistant) => [assistant.key, assistant]));
  indexById = new Map(ASSISTANT_CATALOG.map((assistant) => [assistant.id, assistant]));
}

/**
 * Substitui o catálogo pelo que veio da API.
 *
 * Ignora resposta inutilizável em vez de esvaziar a tela: um servidor desatualizado, uma resposta
 * parcial ou um payload corrompido não podem deixar o app sem catálogo. Chaves com forma
 * inválida e ids repetidos também são recusados — o servidor é confiável, o canal não.
 *
 * @returns `true` quando o catálogo foi substituído.
 */
export function applyCatalogFromApi(records: readonly AssistantApiRecord[]): boolean {
  if (!Array.isArray(records) || records.length === 0) return false;

  const uniqueKeys = new Set<string>();
  const uniqueIds = new Set<string>();
  const next: AssistantOption[] = [];

  for (const record of records) {
    if (!record || typeof record !== "object") return false;
    if (!assistantKeySchema.safeParse(record.key).success) return false;
    if (uniqueKeys.has(record.key) || uniqueIds.has(record.id)) return false;
    uniqueKeys.add(record.key);
    uniqueIds.add(record.id);
    next.push(
      Object.freeze({
        key: record.key,
        id: record.id,
        name: record.name,
        description: record.description ?? "",
        primaryRole: record.primaryRole,
        capabilities: Object.freeze([...(record.capabilities ?? [])]),
        status: record.status,
      }),
    );
  }

  ASSISTANT_CATALOG.length = 0;
  ASSISTANT_CATALOG.push(...next);
  rebuildIndexes();
  return true;
}

/** Volta ao fallback de build. Usado entre testes e ao trocar de sessão. */
export function resetAssistantCatalog(): void {
  ASSISTANT_CATALOG.length = 0;
  ASSISTANT_CATALOG.push(...FALLBACK_CATALOG);
  rebuildIndexes();
}

/** Resolves an assistant by its canonical key; `undefined` when not in the catalog. */
export function getAssistantByKey(key: string | null | undefined): AssistantOption | undefined {
  if (!key) return undefined;
  return indexByKey.get(key.toLowerCase());
}

/** Resolves an assistant by its canonical UUID; `undefined` for unknown ids. */
export function getAssistantById(id: string | null | undefined): AssistantOption | undefined {
  if (!id) return undefined;
  return indexById.get(id);
}

/**
 * Assistants that participate in a conversation, in the order the server returned them.
 *
 * Only these may be addressed in that conversation: the CORE rejects any other target with
 * `ASSISTANT_NOT_IN_CONVERSATION`, so the UI must not offer it. Conhecer um assistente pelo
 * catálogo não é o mesmo que poder usá-lo nesta conversa.
 */
export function getConversationAssistants(
  assistantIds: readonly string[],
): readonly AssistantOption[] {
  return assistantIds
    .map((id) => getAssistantById(id))
    .filter((assistant): assistant is AssistantOption => assistant !== undefined);
}

/**
 * Display label for a persisted assistant message.
 *
 * Prefers `metadata.assistantKey`, which the engine writes when it persists the reply, and
 * falls back to the canonical id. Returns `null` when the author is unknown, so the caller
 * can render a neutral label instead of guessing.
 */
export function resolveAssistantLabel(input: {
  readonly assistantId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): string | null {
  const metadataKey = input.metadata?.["assistantKey"];
  if (typeof metadataKey === "string") {
    const byMetadata = getAssistantByKey(metadataKey);
    if (byMetadata) return byMetadata.name;
  }
  return getAssistantById(input.assistantId)?.name ?? null;
}

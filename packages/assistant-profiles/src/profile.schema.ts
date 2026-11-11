import { z } from "zod";
import {
  assistantKeySchema,
  assistantSchema,
  modelCapabilitySchema,
  type AssistantKey,
} from "@nexus/shared";

const stableAssistantFieldsSchema = assistantSchema.pick({
  id: true,
  key: true,
  name: true,
  description: true,
  configVersion: true,
  status: true,
});

const capabilitySchema = z.string().regex(/^[a-z][a-z0-9_.-]*$/);

/**
 * Fase 3 (G2): política de coordenação declarada no próprio perfil.
 *
 * Antes desta fase a regra "YUI pode delegar para ALICE e SCHWI" existia em dois lugares no
 * servidor — um mapa em `delegation.ts` e um literal duplicado em `engine.ts` — e nenhum deles
 * era o perfil. O resultado é que uma quarta assistente não participaria de coordenação sem
 * edição de código de produção em dois arquivos.
 *
 * A validação é **estrita**, por decisão explícita:
 *
 * - `canCoordinate: true` exige `delegateTo` com pelo menos um alvo. Coordenar sem alvo é uma
 *   declaração sem efeito, e é o tipo de ambiguidade que produz fontes de verdade paralelas.
 * - `canCoordinate: false` proíbe `delegateTo`. Declarar alvos sem poder coordenar é uma
 *   contradição que falharia só em tempo de execução, longe de quem a escreveu.
 * - `.strict()` recusa campos desconhecidos, para que `canDelegateTo` (nome do plano §5.5) não
 *   passe silenciosamente como um segundo jeito de escrever o mesmo conceito.
 *
 * A existência dos alvos no catálogo e a ausência de ciclos são verificadas por
 * `createAssistantProfileCatalogSchema` — um perfil isolado não tem como saber do catálogo.
 */
export const assistantCoordinationSchema = z
  .object({
    canCoordinate: z.boolean(),
    /** Máximo de 10 alvos, conforme o plano (§7.2). */
    delegateTo: z.array(assistantKeySchema).max(10).optional(),
  })
  .strict()
  .superRefine((coordination, ctx) => {
    const targets = coordination.delegateTo ?? [];

    if (coordination.canCoordinate && targets.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["delegateTo"],
        message: "An assistant that coordinates must declare at least one delegation target",
      });
    }

    if (!coordination.canCoordinate && targets.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["delegateTo"],
        message: "An assistant that does not coordinate must not declare delegation targets",
      });
    }

    const seen = new Set<string>();
    targets.forEach((target, index) => {
      if (seen.has(target)) {
        ctx.addIssue({
          code: "custom",
          path: ["delegateTo", index],
          message: "Delegation targets must be unique",
        });
      }
      seen.add(target);
    });
  });

export type AssistantCoordination = z.infer<typeof assistantCoordinationSchema>;

export const toolPermissionSchema = z.object({
  toolId: z.string().trim().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  allowed: z.boolean(),
  requiresUserAuthorization: z.literal(true),
  enabledByDefault: z.literal(false),
  paidUseRequiresExplicitAuthorization: z.literal(true),
}).strict();

export const assistantProfileSchema = stableAssistantFieldsSchema.extend({
  profileVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected a semantic profile version"),
  primaryRole: z.string().trim().min(1),
  personality: z.array(z.string().trim().min(1)).min(1),
  behaviorInstructions: z.array(z.string().trim().min(1)).min(1),
  communicationPreferences: z.object({
    tone: z.string().trim().min(1),
    style: z.string().trim().min(1),
    verbosity: z.enum(["concise", "balanced", "detailed"]),
    structure: z.array(z.string().trim().min(1)),
  }).strict(),
  capabilities: z.array(capabilitySchema).min(1),
  tools: z.array(toolPermissionSchema),
  usageRestrictions: z.array(z.string().trim().min(1)).min(1),
  memoryPolicy: z.object({
    individual: z.literal("own_assistant_only"),
    shared: z.literal("explicit_item_grant_required"),
    permissionAuthority: z.literal("backend"),
  }).strict(),
  metadata: z.object({
    lifecycle: z.literal("initial"),
    tags: z.array(z.string().trim().min(1)),
    extensible: z.literal(true),
  }).strict(),
  configuration: z.object({
    instructions: z.array(z.string().trim().min(1)).min(1),
    profileSchemaVersion: z.literal(1),
  }).strict(),
  /**
   * Fase 4 (plano §5.6): o que o **modelo** precisa oferecer para atender este perfil.
   *
   * Distinção que importa: `capabilities` (campo acima) descrevem o que a *assistente* sabe
   * fazer e são texto do catálogo. `modelPreference.requiredCapabilities` descreve o que o
   * *modelo* precisa suportar e usa `modelCapabilitySchema` — o enum fechado de capabilities de
   * provedor (`chat`, `code`, `vision`…). Misturar os dois faria "ui_design" virar exigência de
   * modelo, o que não existe.
   *
   * Obrigatório e sempre presente, mesmo que vazio: um perfil que não declarasse nada ficaria
   * `undefined` e cada ponto de uso teria de inventar um padrão — o mesmo defeito que a Fase 3
   * removeu da coordenação.
   *
   * `.strict()` recusa nome de modelo fixo (`model: "openai/gpt"`): o plano proíbe acoplar a
   * seleção a um fornecedor; a exigência é por **capacidade**, não por produto.
   */
  modelPreference: z
    .object({
      requiredCapabilities: z.array(modelCapabilitySchema).default([]),
    })
    .strict(),

  /**
   * Fase 3 (G2). Obrigatório de propósito: um campo opcional deixaria perfis sem política e
   * reintroduziria o "não declarado, logo padrão implícito" que esta fase elimina.
   */
  coordination: assistantCoordinationSchema,
}).strict().superRefine((profile, ctx) => {
  if (profile.profileVersion !== profile.configVersion) {
    ctx.addIssue({
      code: "custom",
      path: ["configVersion"],
      message: "Profile and assistant configuration versions must match",
    });
  }
  // Ciclo de tamanho 1 é impossível por construção se um perfil não pode ser seu próprio alvo.
  // Verificar aqui evita que o validador de plano tenha de descobrir isso em execução.
  profile.coordination.delegateTo?.forEach((target, index) => {
    if (target === profile.key) {
      ctx.addIssue({
        code: "custom",
        path: ["coordination", "delegateTo", index],
        message: "An assistant cannot delegate to itself",
      });
    }
  });

  const seen = new Set<string>();
  profile.tools.forEach((tool, index) => {
    if (seen.has(tool.toolId)) {
      ctx.addIssue({ code: "custom", path: ["tools", index, "toolId"], message: "Tool IDs must be unique within a profile" });
    }
    seen.add(tool.toolId);
  });
});

/**
 * Fase 3 (G2): validação do catálogo, com as regras que **só** o conjunto pode verificar.
 *
 * Um perfil isolado não sabe se o alvo que declara existe, nem se a cadeia que começa nele volta
 * a si mesma. Essas duas checagens vivem aqui.
 *
 * `declaredKeys` permite validar um subconjunto cujos alvos apontam para perfis que existem no
 * catálogo completo (usado para testar composições parciais). Por padrão é o conjunto das
 * próprias chaves, que é o modo de produção.
 */
export function createAssistantProfileCatalogSchema(options: {
  /** Chaves consideradas existentes. Omitido -> as chaves do próprio catálogo. */
  readonly knownKeys?: readonly string[];
} = {}) {
  return z.array(assistantProfileSchema).superRefine((profiles, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    profiles.forEach((profile, index) => {
      if (ids.has(profile.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "Assistant profile IDs must be unique" });
      }
      if (keys.has(profile.key)) {
        ctx.addIssue({ code: "custom", path: [index, "key"], message: "Assistant profile keys must be unique" });
      }
      ids.add(profile.id);
      keys.add(profile.key);
    });

    const known = options.knownKeys ? new Set(options.knownKeys) : keys;

    // 1. Todo alvo declarado precisa existir. Um alvo inexistente é uma promessa que o validador
    //    de plano recusaria em execução — melhor recusar no carregamento do catálogo.
    profiles.forEach((profile, index) => {
      (profile.coordination.delegateTo ?? []).forEach((target, targetIndex) => {
        if (!known.has(target)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "coordination", "delegateTo", targetIndex],
            message: `Delegation target '${target}' is not a registered assistant`,
          });
        }
      });
    });

    // 2. Ciclos. A validação de plano já os rejeita em execução; aqui o erro aparece no boot, e
    //    não na conversa de um usuário.
    const edges = new Map<string, readonly string[]>(
      profiles.map((profile) => [profile.key, profile.coordination.delegateTo ?? []]),
    );

    const state = new Map<string, "visiting" | "done">();
    const findCycle = (key: string, path: readonly string[]): readonly string[] | null => {
      const current = state.get(key);
      if (current === "done") return null;
      if (current === "visiting") {
        // Recorta o ciclo completo a partir da primeira aparição da chave.
        const start = path.indexOf(key);
        return [...path.slice(start === -1 ? 0 : start), key];
      }
      state.set(key, "visiting");
      for (const target of edges.get(key) ?? []) {
        const cycle = findCycle(target, [...path, key]);
        if (cycle) return cycle;
      }
      state.set(key, "done");
      return null;
    };

    for (const profile of profiles) {
      const cycle = findCycle(profile.key, []);
      if (cycle) {
        ctx.addIssue({
          code: "custom",
          path: ["coordination"],
          message: `Delegation cycle detected: ${cycle.join(" -> ")}`,
        });
        // Um ciclo por catálogo é suficiente: repetir o mesmo caminho de trás para frente só
        // poluiria a mensagem de erro.
        return;
      }
    }
  });
}

/** Esquema padrão do catálogo: todos os alvos precisam estar no próprio catálogo. */
export const assistantProfileCatalogSchema = createAssistantProfileCatalogSchema();

export type ToolPermission = z.infer<typeof toolPermissionSchema>;
export type AssistantProfile = z.infer<typeof assistantProfileSchema>;
export type AssistantProfileCatalog = z.infer<typeof assistantProfileCatalogSchema>;

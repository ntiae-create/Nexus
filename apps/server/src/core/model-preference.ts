import type { AssistantProfile } from "@nexus/assistant-profiles";
import type { ModelCapability } from "@nexus/shared";

/**
 * Fase 4 (plano §5.6): capabilities de **modelo** exigidas por um perfil.
 *
 * O ponto de produção que isto resolve: antes desta fase o engine pedia `["chat"]` fixo nos dois
 * lugares que selecionam modelo (raiz e sub-execução delegada). Com isso a VIVY — que depende de um
 * modelo com `code` — receberia um modelo de chat qualquer, e o requisito ficaria só na prosa do
 * catálogo, sem efeito na seleção. Aqui a exigência vem do perfil, que é a fonte canônica.
 *
 * Regras, todas deliberadas:
 *
 * - `chat` sempre entra. Toda execução é uma conversa; um perfil que pedisse só `code` receberia um
 *   modelo que não conversa. O `["chat", ...]` preserva o comportamento das três assistentes
 *   anteriores (que declaram `requiredCapabilities: []`) e é a razão de o campo poder ser vazio sem
 *   significar "nenhuma capability".
 * - Deduplicado. Se um perfil declarar `chat` explicitamente, ele não deve virar exigência repetida;
 *   o array também é o que aparece em relatórios e comparações de seleção.
 * - Sem fallback. Se nenhum modelo `:free` declara a capability exigida, a seleção falha com
 *   `PROVIDER_MODEL_UNAVAILABLE` — não há degradação para um modelo sem `code`. Isso é o §5.6 do
 *   plano: `MODEL_UNAVAILABLE` honesto em vez de resposta de um modelo incompatível.
 *
 * A ordem devolvida é determinística (as do perfil, na ordem declarada), porque o resultado é
 * comparado e logado.
 */
export function resolveModelCapabilitiesFor(profile: AssistantProfile): ModelCapability[] {
  const required: ModelCapability[] = ["chat"];
  for (const capability of profile.modelPreference.requiredCapabilities) {
    if (!required.includes(capability)) required.push(capability);
  }
  return required;
}

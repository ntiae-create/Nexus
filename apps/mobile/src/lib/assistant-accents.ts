/**
 * Cor de destaque por assistente.
 *
 * Acento é decisão de apresentação do cliente — não existe no perfil do servidor e não deve
 * existir lá: o catálogo canônico descreve identidade e operação, não identidade visual.
 *
 * Por isso este é o **único** mapa por assistente que resta no mobile, e ele é deliberadamente
 * tolerante: uma chave ausente recebe `DEFAULT_ACCENT` em vez de quebrar a tela. Adicionar um
 * assistente no servidor o faz aparecer na interface com a cor padrão, sem edição de código.
 */
export const DEFAULT_ACCENT = "#94a3b8";

export const ASSISTANT_ACCENTS: Readonly<Record<string, string>> = Object.freeze({
  yui: "#a78bfa",
  alice: "#38bdf8",
  schwi: "#34d399",
});

export function accentFor(assistantKey: string): string {
  return ASSISTANT_ACCENTS[assistantKey] ?? DEFAULT_ACCENT;
}

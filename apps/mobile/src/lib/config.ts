export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem("nexus.apiBaseUrl");
    if (stored) return stored.replace(/\/$/, "");
  }
  return (
    (import.meta.env.VITE_NEXUS_API_URL as string | undefined)?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

export const ASSISTANTS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    key: "yui",
    name: "YUI",
    role: "Assistente pessoal",
    description: "Conversas, organização e planejamento do dia a dia.",
    accent: "#a78bfa",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    key: "alice",
    name: "ALICE",
    role: "Pesquisa e conhecimento",
    description: "Análise, referências e explicações técnicas.",
    accent: "#38bdf8",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    key: "schwi",
    name: "SCHWI",
    role: "Lógica e estratégia",
    description: "Planejamento, arquitetura e problemas complexos.",
    accent: "#34d399",
  },
] as const;

export type AssistantMeta = (typeof ASSISTANTS)[number];

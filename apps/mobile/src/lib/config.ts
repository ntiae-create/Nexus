import { Capacitor } from "@capacitor/core";

/**
 * Runtime override key. Preserved for compatibility: it can still be set from the
 * browser console or by a previous build, but it is no longer the recommended way
 * to point the APK at a backend.
 */
export const API_BASE_URL_STORAGE_KEY = "nexus.apiBaseUrl";

/**
 * Capacitor preference key holding the API base URL configured from inside the
 * app. It is a plain address, never a credential, so the (non-secret) native
 * `Preferences` store is enough and no secure-storage plugin is needed for it.
 */
export const API_BASE_URL_PREFERENCE_KEY = "nexus.apiBaseUrl";

/**
 * Fallback used by `vite dev` in the browser. A physical Android device can never
 * reach the development machine through `localhost` — that resolves to the device
 * itself — so this value is used only for a browser on the same machine.
 */
export const DEVELOPMENT_API_BASE_URL = "http://localhost:3000";

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/**
 * Validates and normalizes a user-supplied backend address.
 *
 * Only absolute `http`/`https` URLs are accepted: a relative or malformed value
 * would silently resolve against the WebView origin and produce confusing
 * network failures on the device.
 */
export function normalizeApiBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = trimTrailingSlashes(raw.trim());
  if (candidate.length === 0 || candidate.length > 2048) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  // Credentials in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;

  return trimTrailingSlashes(parsed.toString());
}

export interface ResolveApiBaseUrlInput {
  /** Value persisted by the app configuration screen. */
  readonly stored?: string | null;
  /** Value coming from `VITE_NEXUS_API_URL` at build time. */
  readonly fromEnv?: string | null;
  /** `Capacitor.isNativePlatform()`. */
  readonly native: boolean;
}

/**
 * Turns configuration values into the single base URL used by the HTTP client.
 *
 * The physical-device case never falls back to `localhost`: on Android that would
 * address the handset, not the development machine, so an unconfigured APK reports
 * the backend as unconfigured instead of failing with an obscure network error.
 */
export function resolveApiBaseUrl(input: ResolveApiBaseUrlInput): string | null {
  const stored = normalizeApiBaseUrl(input.stored);
  if (stored) return stored;

  const fromEnv = normalizeApiBaseUrl(input.fromEnv);
  if (fromEnv) return fromEnv;

  return input.native ? null : DEVELOPMENT_API_BASE_URL;
}

const isNativePlatform = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    // Outside Capacitor (plain browser, tests) the web platform applies.
    return false;
  }
};

const readStoredOverride = (): string | null => {
  try {
    return typeof window === "undefined"
      ? null
      : window.localStorage.getItem(API_BASE_URL_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, WebView restrictions).
    return null;
  }
};

let configuredBaseUrl: string | null | undefined;

/**
 * Sets the base URL resolved by the session bootstrap (which can await the native
 * preferences store). Passing `null` means "no backend configured".
 */
export function setApiBaseUrl(value: string | null): void {
  configuredBaseUrl = value ? normalizeApiBaseUrl(value) : null;
}

/**
 * Resolves the API base URL synchronously.
 *
 * Precedence: value configured during bootstrap > runtime override
 * (`nexus.apiBaseUrl` in localStorage) > `VITE_NEXUS_API_URL` > development default
 * (browser only).
 */
export function getApiBaseUrl(): string | null {
  if (configuredBaseUrl !== undefined) {
    return (
      configuredBaseUrl ??
      normalizeApiBaseUrl(readStoredOverride()) ??
      normalizeApiBaseUrl(import.meta.env.VITE_NEXUS_API_URL as string | undefined) ??
      (isNativePlatform() ? null : DEVELOPMENT_API_BASE_URL)
    );
  }
  return resolveApiBaseUrl({
    stored: readStoredOverride(),
    fromEnv: (import.meta.env.VITE_NEXUS_API_URL as string | undefined) ?? null,
    native: isNativePlatform(),
  });
}

/** True when the app is running inside the Capacitor Android/iOS shell. */
export function isNativeApp(): boolean {
  return isNativePlatform();
}

/** Test hook: restores the "not configured yet" state. */
export function resetApiBaseUrl(): void {
  configuredBaseUrl = undefined;
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

import { Preferences } from "@capacitor/preferences";
import { API_BASE_URL_PREFERENCE_KEY, isNativeApp, normalizeApiBaseUrl, resolveApiBaseUrl, setApiBaseUrl } from "../config.js";
import { createApiClient } from "../../services/api-client.js";
import { createAuthService } from "../../services/auth-service.js";
import { createSecureStorage, type SecureStorage } from "./secure-storage.js";
import { createSessionManager, type SessionManager } from "./session-manager.js";

export interface AppContainer {
  readonly sessionManager: SessionManager;
  readonly storage: SecureStorage;
  /** Base URL currently in effect, or `null` when none is configured. */
  readonly apiBaseUrl: string | null;
  /** Persists a new API base URL and applies it to the HTTP client. */
  readonly configureApiBaseUrl: (value: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Reads the API address saved through the in-app configuration.
 *
 * It lives in Capacitor `Preferences` (plain, unencrypted, non-secret) because an
 * address is configuration, not a credential. Secure storage is reserved for the
 * session token.
 */
async function readConfiguredApiBaseUrl(): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key: API_BASE_URL_PREFERENCE_KEY });
    return normalizeApiBaseUrl(value);
  } catch {
    return null;
  }
}

/**
 * Builds the application graph once, before React renders.
 *
 * Resolving the base URL here (instead of inside a render) keeps the HTTP client
 * synchronous and makes the "not configured on a physical device" state explicit
 * to the UI instead of a mysterious network failure.
 */
export async function bootstrapApp(): Promise<AppContainer> {
  const native = isNativeApp();
  const stored = native ? await readConfiguredApiBaseUrl() : null;

  const resolved = resolveApiBaseUrl({
    stored,
    fromEnv: (import.meta.env.VITE_NEXUS_API_URL as string | undefined) ?? null,
    native,
  });
  setApiBaseUrl(resolved);

  let currentBaseUrl = resolved;

  const storage = createSecureStorage();
  const client = createApiClient({ getBaseUrl: () => currentBaseUrl });
  const authService = createAuthService(client);
  const sessionManager = createSessionManager({ authService, storage });

  return {
    sessionManager,
    storage,
    get apiBaseUrl() {
      return currentBaseUrl;
    },
    async configureApiBaseUrl(value: string) {
      const normalized = normalizeApiBaseUrl(value);
      if (!normalized) {
        return {
          ok: false,
          message: "Informe um endereço completo, começando com http:// ou https://.",
        };
      }
      try {
        await Preferences.set({ key: API_BASE_URL_PREFERENCE_KEY, value: normalized });
      } catch {
        return { ok: false, message: "Não foi possível salvar o endereço neste dispositivo." };
      }
      currentBaseUrl = normalized;
      setApiBaseUrl(normalized);
      return { ok: true };
    },
  };
}

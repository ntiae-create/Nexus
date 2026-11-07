import { Preferences } from "@capacitor/preferences";
import {
  API_BASE_URL_PREFERENCE_KEY,
  isNativeApp,
  normalizeApiBaseUrl,
  readLegacyApiBaseUrl,
  resolveApiBaseUrl,
  setApiBaseUrl,
  shouldMigrateLegacyApiBaseUrl,
} from "../config.js";
import { createApiClient, type ApiClient } from "../../services/api-client.js";
import { createAuthService } from "../../services/auth-service.js";
import { createCoreService } from "../../services/core-service.js";
import { createConversationService } from "../../services/conversation-service.js";
import { createSecureStorage, type SecureStorage } from "./secure-storage.js";
import { createSessionManager, type SessionManager } from "./session-manager.js";

export interface AppContainer {
  readonly sessionManager: SessionManager;
  readonly storage: SecureStorage;
  /** Base URL currently in effect, or `null` when none is configured. */
  readonly apiBaseUrl: string | null;
  /** Persists a new API base URL and applies it to the HTTP client. */
  readonly configureApiBaseUrl: (value: string) => Promise<{ ok: boolean; message?: string }>;
  readonly apiClient: ApiClient;
  /**
   * Builds a conversation service bound to one session token.
   *
   * The token is passed in (never stored here) so the CORE calls always use the session the
   * manager currently considers valid, and a screen unmount cannot leave a token behind.
   */
  readonly createConversationService: (token: string) => ReturnType<typeof createConversationService>;
}

/**
 * Reads the API address saved through the in-app configuration.
 *
 * It lives in Capacitor `Preferences` (plain, unencrypted, non-secret) because an
 * address is configuration, not a credential. Secure storage is reserved for the
 * session token.
 *
 * Precedence, highest first:
 * 1. `Preferences` (set by this build's configuration screen);
 * 2. legacy `nexus.apiBaseUrl` from `localStorage` (previous builds), migrated
 *    into `Preferences` on Android without overwriting a newer value;
 * 3. `VITE_NEXUS_API_URL`;
 * 4. the browser-only development default.
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
 * Copies a legacy address into `Preferences` so the current build keeps working.
 *
 * The preference is only written when it holds no usable value, so a newer
 * configuration is never replaced by an older one. A failed write is not fatal:
 * the address still applies for this run and the next launch retries.
 */
async function migrateLegacyApiBaseUrl(
  configured: string | null,
  legacy: string | null,
): Promise<string | null> {
  if (!shouldMigrateLegacyApiBaseUrl({ stored: configured, legacy })) return configured;

  const normalized = normalizeApiBaseUrl(legacy);
  if (!normalized) return configured;

  try {
    await Preferences.set({ key: API_BASE_URL_PREFERENCE_KEY, value: normalized });
  } catch {
    // Keep using the legacy address in this session; nothing is lost.
  }
  return normalized;
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

  // `localStorage` is read for the endpoint only — never for a credential. On the
  // web it is the actual configuration source; on Android it is the legacy store
  // written by earlier builds, migrated into `Preferences` below.
  const legacy = readLegacyApiBaseUrl();
  const configured = native ? await readConfiguredApiBaseUrl() : null;
  const stored = native ? await migrateLegacyApiBaseUrl(configured, legacy) : legacy;

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
  const coreService = createCoreService(client);

  return {
    sessionManager,
    storage,
    apiClient: client,
    get apiBaseUrl() {
      return currentBaseUrl;
    },
    createConversationService(token: string) {
      return createConversationService({ service: coreService, token });
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

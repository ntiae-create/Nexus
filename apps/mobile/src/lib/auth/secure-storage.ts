import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Contract for the one value the app keeps at rest: the session token.
 *
 * Implementations must be able to fail loudly. A caller may never assume the
 * token was written — {@link save} resolves only after the backend confirmed it.
 */
export interface SecureStorage {
  /** Short name used in diagnostics (`native`, `web`). Never includes values. */
  readonly backend: "native" | "web";
  /** Returns the stored token, or `null` when absent or unreadable. */
  get(): Promise<string | null>;
  /** Persists the token. Rejects when the platform store could not confirm it. */
  save(token: string): Promise<void>;
  /** Removes the token. Rejects when the platform store could not confirm it. */
  clear(): Promise<void>;
}

export const SESSION_TOKEN_KEY = "nexus.session.token";

/** Thrown when the platform store cannot be trusted to hold a token. */
export class SecureStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
    this.name = "SecureStorageError";
  }
}

/* -------------------------------------------------------------------------- */
/* Native backend (Android / iOS)                                             */
/* -------------------------------------------------------------------------- */

interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/**
 * Native plugin access is declared through `registerPlugin`, exactly like any
 * Capacitor plugin. The Android module that implements it ships with the app
 * (`android/app/src/main/java/dev/nexus/mobile/SecureSessionPlugin.kt`), and its
 * backing store is Android Keystore-encrypted, so the token is not readable by
 * `adb`/backups the way plain SharedPreferences would be.
 *
 * On the web platform this proxy is never called: `createSecureStorage()` picks a
 * different backend before any method runs.
 */
const SecureSession = registerPlugin<SecureStoragePlugin>("SecureSession");

export function createNativeSecureStorage(): SecureStorage {
  return {
    backend: "native",
    async get() {
      try {
        const { value } = await SecureSession.get({ key: SESSION_TOKEN_KEY });
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch (error) {
        // A read failure is equivalent to "no usable session"; the caller will send
        // the user to the login screen instead of trusting an unknown state.
        throw new SecureStorageError("Não foi possível ler a sessão armazenada.", {
          cause: error,
        });
      }
    },
    async save(token: string) {
      try {
        await SecureSession.set({ key: SESSION_TOKEN_KEY, value: token });
      } catch (error) {
        throw new SecureStorageError("Não foi possível salvar a sessão neste dispositivo.", {
          cause: error,
        });
      }
    },
    async clear() {
      try {
        await SecureSession.remove({ key: SESSION_TOKEN_KEY });
      } catch (error) {
        throw new SecureStorageError("Não foi possível remover a sessão do dispositivo.", {
          cause: error,
        });
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Web backend (browser / development)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Browser backend: **memory only**.
 *
 * `localStorage` (and therefore Capacitor's `Preferences`, whose web
 * implementation is `window.localStorage`) is readable by any script on the origin
 * and survives the tab, so it is not a credential store. On the web the token is
 * kept in a module-scoped variable for the lifetime of the page and is never
 * written to any persistent store.
 *
 * Consequence, accepted deliberately: a browser reload requires signing in again.
 * The browser build exists for development and preview; the shipped product runs
 * inside Capacitor, where the Android Keystore backend is used.
 */
export function createWebSecureStorage(): SecureStorage {
  let memoryToken: string | null = null;

  return {
    backend: "web",
    async get() {
      return memoryToken;
    },
    async save(token: string) {
      // Nothing is persisted: there is no safe browser store for a credential.
      memoryToken = token;
    },
    async clear() {
      memoryToken = null;
    },
  };
}

const isNativePlatform = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** Chooses the storage backend for the current platform. */
export function createSecureStorage(): SecureStorage {
  return isNativePlatform() ? createNativeSecureStorage() : createWebSecureStorage();
}

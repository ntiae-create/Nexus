import { z } from "zod";
import type { ApiClient } from "./api-client.js";
import { ApiError } from "./api-client.js";

/**
 * Wire contracts for the existing backend auth routes. They mirror the JSON the
 * server already returns; no endpoint is added or changed by this stage.
 */
export const loginResponseSchema = z.object({
  token: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().min(1),
  owner: z.object({ userId: z.string().min(1) }),
});

export const sessionResponseSchema = z.object({
  owner: z.object({ userId: z.string().min(1) }),
  session: z.object({
    issuedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
});

export type LoginResult = {
  readonly token: string;
  readonly expiresAt: string;
  readonly ownerId: string;
};

export type SessionInfo = {
  readonly ownerId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
};

export const AUTH_ROUTES = {
  login: "/v1/auth/login",
  me: "/v1/auth/me",
  logout: "/v1/auth/logout",
} as const;

/**
 * Parses a successful body, converting a contract mismatch into an `invalid_response`
 * failure so the UI has a single error type to handle.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({
      kind: "invalid_response",
      message: `O servidor respondeu a ${what} em um formato inesperado.`,
    });
  }
  return parsed.data;
}

export interface AuthService {
  /** `POST /v1/auth/login`. Rejects with {@link ApiError} on any failure. */
  login(password: string, options?: { signal?: AbortSignal }): Promise<LoginResult>;
  /** `GET /v1/auth/me`. Authoritative check that the token is still valid. */
  currentSession(token: string, options?: { signal?: AbortSignal }): Promise<SessionInfo>;
  /** `POST /v1/auth/logout`. Revokes the session server-side. */
  logout(token: string, options?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Thin transport layer over the auth endpoints. It performs no storage and keeps
 * no state: session lifecycle belongs to the session manager.
 */
export function createAuthService(client: ApiClient): AuthService {
  return {
    async login(password, options = {}) {
      // The password is sent once, in the request body, and is never retained.
      const payload = await client.post<unknown>(
        AUTH_ROUTES.login,
        { password },
        { ...(options.signal ? { signal: options.signal } : {}) },
      );
      const parsed = parseOrThrow(loginResponseSchema, payload, "o login");
      return {
        token: parsed.token,
        expiresAt: parsed.expiresAt,
        ownerId: parsed.owner.userId,
      };
    },

    async currentSession(token, options = {}) {
      const payload = await client.get<unknown>(AUTH_ROUTES.me, {
        token,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const parsed = parseOrThrow(sessionResponseSchema, payload, "a validação da sessão");
      return {
        ownerId: parsed.owner.userId,
        issuedAt: parsed.session.issuedAt,
        expiresAt: parsed.session.expiresAt,
      };
    },

    async logout(token, options = {}) {
      await client.post<unknown>(
        AUTH_ROUTES.logout,
        undefined,
        { token, ...(options.signal ? { signal: options.signal } : {}) },
      );
    },
  };
}

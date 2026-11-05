export interface AuthStore {
  isRevoked(jti: string): Promise<boolean>;
  revoke(jti: string, expiresAt: number): Promise<void>;
  /** Atomically records a bad password and returns false when that attempt triggers/is under lock. */
  recordFailure(): Promise<boolean>;
  clearFailures(): Promise<void>;
}

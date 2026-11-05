export interface AuthStore {
  isRevoked(jti: string): Promise<boolean>;
  revoke(jti: string, expiresAt: number): Promise<void>;
  isLoginLocked(): Promise<boolean>;
  /** Returns true only while this failed attempt remains below the lock threshold. */
  recordFailure(): Promise<boolean>;
  clearFailures(): Promise<void>;
}

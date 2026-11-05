-- Shared authentication state for serverless instances. Migration 00001 is immutable.
CREATE TABLE nexus.auth_login_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE nexus.revoked_sessions (
  jti text PRIMARY KEY CHECK (length(jti) = 32),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revoked_sessions_expires_at_idx ON nexus.revoked_sessions (expires_at);

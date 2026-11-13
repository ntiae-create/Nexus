import { isIP } from "node:net";

const SUPPORTED_SSL_MODES = new Set([
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
  "no-verify",
]);

function lastQueryValue(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host.startsWith("/")) return true;
  const isLocalhostDomain =
    host === "localhost" ||
    host === "localhost." ||
    host.endsWith(".localhost") ||
    host.endsWith(".localhost.");
  if (isLocalhostDomain) return true;

  const family = isIP(host);
  if (family === 4) return host.split(".")[0] === "127";
  return family === 6 && host === "::1";
}

/**
 * Ensures application PostgreSQL URLs cannot silently use cleartext TCP.
 *
 * Local loopback and Unix-socket connections remain usable for isolated tests.
 * Remote hosts always use TLS with certificate and hostname validation
 * (`verify-full`); weaker modes are upgraded and explicit cleartext or
 * no-verification settings are rejected before opening a pool.
 *
 * The URL is never included in errors: it contains the database credentials.
 */
export function requirePostgresTls(connectionString: string): string {
  if (connectionString.startsWith("/")) return connectionString;

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("PostgreSQL connection string must be a valid postgres:// or postgresql:// URL");
  }

  if (url.protocol === "socket:") return connectionString;
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connection string must use postgres:// or postgresql://");
  }

  // node-postgres gives a query-string `host` precedence over the URL hostname.
  const urlHost = url.hostname.replace(/^\[|\]$/g, "");
  const configuredHost = lastQueryValue(url, "host");
  const effectiveHost = configuredHost || urlHost || process.env.PGHOST || "localhost";
  if (isLoopbackHost(effectiveHost)) return connectionString;

  const sslmode = lastQueryValue(url, "sslmode");
  let sslModeNormalized = false;
  if (sslmode) {
    const normalizedMode = sslmode.toLowerCase();
    if (!SUPPORTED_SSL_MODES.has(normalizedMode)) {
      throw new Error("Unsupported PostgreSQL sslmode; remote connections require verify-full");
    }
    if (normalizedMode === "disable") {
      throw new Error("TLS is required for remote PostgreSQL connections");
    }
    if (normalizedMode === "no-verify") {
      throw new Error("PostgreSQL sslmode=no-verify is not allowed for remote connections");
    }

    // `prefer`, `require`, and `verify-ca` can skip hostname verification or
    // allow cleartext fallback under libpq-compatible parsing. Normalize them
    // to the strict mode instead of relying on pg-connection-string defaults,
    // which change between major versions.
    if (sslmode !== "verify-full") {
      url.searchParams.set("sslmode", "verify-full");
      sslModeNormalized = true;
    }
  }

  const ssl = lastQueryValue(url, "ssl");
  if (ssl !== undefined) {
    if (ssl === "0" || ssl === "false") {
      throw new Error("TLS is required for remote PostgreSQL connections");
    }
    if (ssl === "no-verify") {
      throw new Error("PostgreSQL ssl=no-verify is not allowed for remote connections");
    }
    // pg-connection-string recognizes only these exact lowercase values.
    // In particular, accepting a case-insensitive `TRUE` here would be unsafe:
    // the driver would ignore it and could leave TLS disabled.
    if (ssl !== "1" && ssl !== "true") {
      throw new Error("Unsupported PostgreSQL ssl option for a remote connection");
    }
  }

  const hasCertificateOptions = ["sslcert", "sslkey", "sslrootcert"].some(
    (name) => Boolean(lastQueryValue(url, name)),
  );
  const directTls = lastQueryValue(url, "sslnegotiation") === "direct";
  const hasExplicitTls = Boolean(sslmode || ssl || hasCertificateOptions || directTls);
  if (!hasExplicitTls) {
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  }

  return sslModeNormalized ? url.toString() : connectionString;
}

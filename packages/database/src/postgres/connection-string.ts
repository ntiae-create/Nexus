import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";

const SUPPORTED_SSL_MODES = new Set([
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
  "no-verify",
]);

const CONNECTION_STRING_SSL_OPTIONS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
  "sslnegotiation",
  "uselibpqcompat",
] as const;

const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[\s\S]*?-----END CERTIFICATE-----/g;

export interface PostgresPrivateCaOptions extends ConnectionOptions {
  ca: string;
  servername: string;
  rejectUnauthorized: true;
}

export interface ResolvedPostgresTlsConfiguration {
  connectionString: string;
  /** Present only when the paired private-CA environment variables are set. */
  ssl?: PostgresPrivateCaOptions;
}

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

function readPrivateCaOptions(): PostgresPrivateCaOptions | undefined {
  const caValue = process.env.NEXUS_DATABASE_SSL_CA;
  const servernameValue = process.env.NEXUS_DATABASE_SSL_SERVERNAME;
  if (caValue === undefined && servernameValue === undefined) return undefined;

  const ca = caValue?.trim();
  const servername = servernameValue?.trim();
  if (!ca || !servername) {
    throw new Error(
      "NEXUS_DATABASE_SSL_CA and NEXUS_DATABASE_SSL_SERVERNAME must be configured together and non-empty",
    );
  }
  if (
    /[\u0000-\u0020\u007f/\\?#@]/.test(servername) ||
    (servername.includes(":") && isIP(servername) === 0)
  ) {
    throw new Error("NEXUS_DATABASE_SSL_SERVERNAME must be a hostname without a URL or port");
  }

  const certificateBlocks = [...ca.matchAll(PEM_CERTIFICATE_BLOCK)].map(([block]) => block);
  const remainingText = ca.replace(PEM_CERTIFICATE_BLOCK, "").trim();
  if (certificateBlocks.length === 0 || remainingText.length > 0) {
    throw new Error("NEXUS_DATABASE_SSL_CA must contain a PEM CA certificate or bundle");
  }

  try {
    for (const certificatePem of certificateBlocks) {
      if (!new X509Certificate(certificatePem).ca) {
        throw new Error("Certificate is not a CA");
      }
    }
  } catch {
    // Do not include certificate contents or OpenSSL parser details in errors.
    throw new Error("NEXUS_DATABASE_SSL_CA must contain structurally valid PEM CA certificate(s)");
  }

  return {
    ca,
    servername,
    rejectUnauthorized: true,
  };
}

function removeConnectionStringSslOptions(connectionString: string): string {
  // Keep raw Unix-socket paths untouched. The top-level TLS object still applies
  // if an operator explicitly configures it for such a connection.
  if (connectionString.startsWith("/")) return connectionString;

  const url = new URL(connectionString);
  for (const option of CONNECTION_STRING_SSL_OPTIONS) {
    url.searchParams.delete(option);
  }
  return url.toString();
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

/**
 * Resolves the verified TLS options shared by the data and authentication pools.
 * With no private-CA variables, this preserves the existing URL-based behavior.
 * When the pair is configured, the URL host/port remain the TCP target while
 * TLS validates against the explicitly supplied servername, not that target.
 */
export function resolvePostgresTlsConfiguration(
  connectionString: string,
): ResolvedPostgresTlsConfiguration {
  const ssl = readPrivateCaOptions();
  const tlsConnectionString = requirePostgresTls(connectionString);
  if (!ssl) return { connectionString: tlsConnectionString };

  // node-postgres parses connectionString after merging pool options, so any
  // sslmode/ssl* query parameter would replace the explicit CA configuration.
  // TLS remains mandatory through `ssl` with rejectUnauthorized=true.
  return {
    connectionString: removeConnectionStringSslOptions(tlsConnectionString),
    ssl,
  };
}

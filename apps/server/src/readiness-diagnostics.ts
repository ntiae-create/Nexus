import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export interface ReadinessConnectionEnvironment {
  readonly NEXUS_DATABASE_URL?: string;
  readonly NEXUS_DATABASE_SSL_CA?: string;
  readonly NEXUS_DATABASE_SSL_SERVERNAME?: string;
}

export type SafeReadinessDatabaseMetadata =
  | {
      databaseUrlStatus: "missing" | "invalid" | "unavailable";
    }
  | {
      databaseUrlStatus: "parsed";
      databaseHost: string;
      databasePort: number;
      databaseName: string;
      databaseUser: string;
      /** Validated hostname, or a safe marker: "unset", "empty", or "invalid". */
      databaseSni: string;
      /** True only when the environment key is defined; CA contents are never returned. */
      databaseSslCaPresent: boolean;
      /** True only when the environment key is defined. */
      databaseSslServernamePresent: boolean;
    };

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const SAFE_DATABASE_IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

function hasNonBlankValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalizes a URL hostname without ever returning URL syntax, credentials,
 * path, query, or fragment data. IP literals are supported for diagnostics.
 */
function safeHostname(rawHostname: string): string | undefined {
  const hostname = rawHostname.replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname.length > 253 ||
    /[\u0000-\u0020\u007f/\\?#@]/.test(hostname)
  ) {
    return undefined;
  }

  if (isIP(hostname) !== 0) return hostname.toLowerCase();
  if (hostname.includes(":")) return undefined;

  const asciiHostname = domainToASCII(hostname);
  const normalizedHostname = asciiHostname.toLowerCase().replace(/\.$/, "");
  if (!normalizedHostname || normalizedHostname.length > 253) return undefined;

  const labels = normalizedHostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return undefined;
  }

  return normalizedHostname;
}

function safeDatabaseIdentifier(encodedValue: string): string | undefined {
  if (encodedValue.length === 0) return "unset";

  let decodedValue: string;
  try {
    decodedValue = decodeURIComponent(encodedValue);
  } catch {
    return undefined;
  }

  if (decodedValue.length === 0) return "unset";
  return SAFE_DATABASE_IDENTIFIER.test(decodedValue) ? decodedValue : undefined;
}

/**
 * Builds the temporary, allowlisted metadata attached only to a failed
 * readiness log. Raw URLs, credentials, query strings, CA contents, and
 * unvalidated SNI strings are never returned.
 */
export function getSafeReadinessDatabaseMetadata(
  env: ReadinessConnectionEnvironment | undefined,
): SafeReadinessDatabaseMetadata {
  if (!env) return { databaseUrlStatus: "unavailable" };

  try {
    const rawConnectionString = env.NEXUS_DATABASE_URL;
    if (!hasNonBlankValue(rawConnectionString)) {
      return { databaseUrlStatus: "missing" };
    }

    let connectionUrl: URL;
    try {
      connectionUrl = new URL(rawConnectionString.trim());
    } catch {
      return { databaseUrlStatus: "invalid" };
    }

    if (!POSTGRES_PROTOCOLS.has(connectionUrl.protocol)) {
      return { databaseUrlStatus: "invalid" };
    }

    const databaseHost = safeHostname(connectionUrl.hostname);
    const databasePort = connectionUrl.port.length > 0
      ? Number(connectionUrl.port)
      : 5432;
    const databasePath = connectionUrl.pathname.startsWith("/")
      ? connectionUrl.pathname.slice(1)
      : connectionUrl.pathname;
    const databaseName = safeDatabaseIdentifier(databasePath);
    const databaseUser = safeDatabaseIdentifier(connectionUrl.username);

    if (
      !databaseHost ||
      !Number.isInteger(databasePort) ||
      databasePort < 1 ||
      databasePort > 65_535 ||
      !databaseName ||
      !databaseUser
    ) {
      return { databaseUrlStatus: "invalid" };
    }

    const rawSni = env.NEXUS_DATABASE_SSL_SERVERNAME;
    const databaseSslServernamePresent = typeof rawSni === "string";
    const databaseSslCaPresent = typeof env.NEXUS_DATABASE_SSL_CA === "string";
    const trimmedSni = rawSni?.trim() ?? "";
    const databaseSni = !databaseSslServernamePresent
      ? "unset"
      : trimmedSni.length === 0
        ? "empty"
        : safeHostname(trimmedSni) ?? "invalid";

    return {
      databaseUrlStatus: "parsed",
      databaseHost,
      databasePort,
      databaseName,
      databaseUser,
      databaseSni,
      databaseSslCaPresent,
      databaseSslServernamePresent,
    };
  } catch {
    // Do not expose parser errors or unexpected environment values in logs.
    return { databaseUrlStatus: "unavailable" };
  }
}

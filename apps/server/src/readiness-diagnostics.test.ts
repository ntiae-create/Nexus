import { describe, expect, it } from "vitest";
import { getSafeReadinessDatabaseMetadata } from "./readiness-diagnostics.js";

describe("safe readiness database metadata", () => {
  it("extracts only the allowlisted PostgreSQL fields and ignores query secrets", () => {
    const connectionString =
      "postgresql://nexus_app:connection-password-secret@db.prod.example:6432/nexus_core?sslmode=verify-full&sslpassword=query-password-secret&token=query-token-secret#fragment-secret";
    const caContent =
      "-----BEGIN CERTIFICATE-----\\nprivate-ca-content-secret\\n-----END CERTIFICATE-----";
    const metadata = getSafeReadinessDatabaseMetadata({
      NEXUS_DATABASE_URL: connectionString,
      NEXUS_DATABASE_SSL_CA: caContent,
      NEXUS_DATABASE_SSL_SERVERNAME: "postgres.prod.example",
    });
    const serialized = JSON.stringify(metadata);

    expect(metadata).toEqual({
      databaseUrlStatus: "parsed",
      databaseHost: "db.prod.example",
      databasePort: 6432,
      databaseName: "nexus_core",
      databaseUser: "nexus_app",
      databaseSni: "postgres.prod.example",
      databaseSslCaPresent: true,
      databaseSslServernamePresent: true,
    });
    for (const forbidden of [
      connectionString,
      "postgresql://",
      "connection-password-secret",
      "sslpassword",
      "query-password-secret",
      "query-token-secret",
      "fragment-secret",
      caContent,
      "private-ca-content-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns only a sanitized missing state when the URL is absent or blank", () => {
    for (const connectionString of [undefined, "  "]) {
      const metadata = getSafeReadinessDatabaseMetadata({
        NEXUS_DATABASE_URL: connectionString,
        NEXUS_DATABASE_SSL_CA: "private-ca-secret",
        NEXUS_DATABASE_SSL_SERVERNAME: "private-sni-secret.internal",
      });

      expect(metadata).toEqual({ databaseUrlStatus: "missing" });
      expect(JSON.stringify(metadata)).not.toContain("private-ca-secret");
      expect(JSON.stringify(metadata)).not.toContain("private-sni-secret");
      expect(metadata).not.toHaveProperty("databaseSslCaPresent");
      expect(metadata).not.toHaveProperty("databaseSslServernamePresent");
    }
  });

  it("returns only a sanitized invalid state for malformed or non-PostgreSQL URLs", () => {
    const invalidUrls = [
      "not-a-url?password=url-secret&token=query-secret",
      "https://url-user:url-password-secret@db.prod.example/nexus?token=query-secret",
      "postgresql://url-user:url-password-secret@[bad-host/nexus?token=query-secret",
    ];

    for (const connectionString of invalidUrls) {
      const metadata = getSafeReadinessDatabaseMetadata({
        NEXUS_DATABASE_URL: connectionString,
        NEXUS_DATABASE_SSL_CA: "private-ca-secret",
        NEXUS_DATABASE_SSL_SERVERNAME: "private-sni-secret.internal",
      });

      expect(metadata).toEqual({ databaseUrlStatus: "invalid" });
      const serialized = JSON.stringify(metadata);
      for (const forbidden of [
        connectionString,
        "url-secret",
        "url-password-secret",
        "query-secret",
        "private-ca-secret",
        "private-sni-secret",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(metadata).not.toHaveProperty("databaseHost");
      expect(metadata).not.toHaveProperty("databaseUser");
      expect(metadata).not.toHaveProperty("databaseSni");
    }
  });

  it("records only a safe invalid marker for a malformed SNI value", () => {
    const rawSni = "sni-secret.internal?token=sni-query-secret";
    const metadata = getSafeReadinessDatabaseMetadata({
      NEXUS_DATABASE_URL: "postgresql://nexus_app:password-secret@db.prod.example/nexus_core",
      NEXUS_DATABASE_SSL_CA: "private-ca-secret",
      NEXUS_DATABASE_SSL_SERVERNAME: rawSni,
    });
    const serialized = JSON.stringify(metadata);

    expect(metadata).toMatchObject({
      databaseUrlStatus: "parsed",
      databaseSni: "invalid",
      databaseSslCaPresent: true,
      databaseSslServernamePresent: true,
    });
    for (const forbidden of [
      rawSni,
      "sni-secret.internal",
      "sni-query-secret",
      "password-secret",
      "private-ca-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("uses the PostgreSQL default port and distinguishes empty TLS variables", () => {
    const metadata = getSafeReadinessDatabaseMetadata({
      NEXUS_DATABASE_URL: "postgres://db.prod.example/",
      NEXUS_DATABASE_SSL_CA: "   ",
      NEXUS_DATABASE_SSL_SERVERNAME: "",
    });

    expect(metadata).toEqual({
      databaseUrlStatus: "parsed",
      databaseHost: "db.prod.example",
      databasePort: 5432,
      databaseName: "unset",
      databaseUser: "unset",
      databaseSni: "empty",
      databaseSslCaPresent: true,
      databaseSslServernamePresent: true,
    });
  });

  it("marks TLS variables absent only when their environment keys are undefined", () => {
    const metadata = getSafeReadinessDatabaseMetadata({
      NEXUS_DATABASE_URL: "postgres://db.prod.example/nexus",
    });

    expect(metadata).toMatchObject({
      databaseUrlStatus: "parsed",
      databaseSni: "unset",
      databaseSslCaPresent: false,
      databaseSslServernamePresent: false,
    });
  });
});

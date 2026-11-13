import pg from "pg";
import { describe, expect, it } from "vitest";
import { requirePostgresTls } from "./connection-string.js";
import { closePool, createPool } from "./pool.js";

const remoteUrl = "postgresql://nexus_app:do-not-print@db.example.com:5432/nexus";

describe("requirePostgresTls", () => {
  it("defaults remote PostgreSQL URLs to TLS with hostname verification", () => {
    const result = new URL(requirePostgresTls(`${remoteUrl}?application_name=nexus-test`));

    expect(result.searchParams.get("sslmode")).toBe("verify-full");
    expect(result.searchParams.get("application_name")).toBe("nexus-test");
    expect(result.username).toBe("nexus_app");
    expect(result.password).toBe("do-not-print");
  });

  it("applies the TLS default to the repository database pool", async () => {
    const pool = createPool({ connectionString: remoteUrl });
    try {
      const options = (pool as unknown as { options: { connectionString: string } }).options;
      expect(new URL(options.connectionString).searchParams.get("sslmode")).toBe("verify-full");
    } finally {
      await closePool(pool);
    }
  });

  it.each(["prefer", "require", "verify-ca"])(
    "upgrades the weaker explicit TLS mode (%s) to verified TLS",
    (sslmode) => {
      const result = new URL(requirePostgresTls(`${remoteUrl}?sslmode=${sslmode}`));
      expect(result.searchParams.get("sslmode")).toBe("verify-full");
    },
  );

  it("preserves an explicit verify-full mode", () => {
    const url = `${remoteUrl}?sslmode=verify-full`;
    expect(requirePostgresTls(url)).toBe(url);
  });

  it("still enforces certificate verification with libpq-compatible parsing", () => {
    const result = new URL(
      requirePostgresTls(
        `${remoteUrl}?sslmode=disable&sslmode=prefer&uselibpqcompat=true`,
      ),
    );

    expect(result.searchParams.getAll("sslmode")).toEqual(["verify-full"]);
    const client = new pg.Client({ connectionString: result.toString() });
    const ssl = (client as unknown as {
      connectionParameters: { ssl: false | { rejectUnauthorized?: boolean } };
    }).connectionParameters.ssl;
    expect(ssl).not.toBe(false);
    if (typeof ssl === "object") expect(ssl.rejectUnauthorized).not.toBe(false);
  });

  it("makes the driver use verified TLS for remote URLs without SSL options", () => {
    const client = new pg.Client({ connectionString: requirePostgresTls(remoteUrl) });
    const ssl = (client as unknown as {
      connectionParameters: { ssl: false | { rejectUnauthorized?: boolean } };
    }).connectionParameters.ssl;

    expect(ssl).not.toBe(false);
    if (typeof ssl === "object") expect(ssl.rejectUnauthorized).not.toBe(false);
  });

  it("preserves explicit TLS and certificate settings", () => {
    const sslFlag = `${remoteUrl}?ssl=1`;
    const caPath = `${remoteUrl}?sslrootcert=%2Ftmp%2Ftest-ca.pem`;

    expect(requirePostgresTls(sslFlag)).toBe(sslFlag);
    expect(requirePostgresTls(caPath)).toBe(caPath);
  });

  it.each([
    `${remoteUrl}?sslmode=disable`,
    `${remoteUrl}?ssl=0`,
    `${remoteUrl}?ssl=false`,
  ])("rejects a remote cleartext configuration without exposing credentials", (url) => {
    let error: Error | undefined;
    try {
      requirePostgresTls(url);
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/TLS is required/);
    expect(error?.message).not.toContain("do-not-print");
  });

  it("rejects unsupported remote SSL modes instead of falling back to driver defaults", () => {
    expect(() => requirePostgresTls(`${remoteUrl}?sslmode=unknown`)).toThrow(
      /Unsupported PostgreSQL sslmode/,
    );
    expect(() => requirePostgresTls(`${remoteUrl}?sslmode=no-verify`)).toThrow(
      /no-verify is not allowed/,
    );
  });

  it("fails closed on SSL options the driver would ignore or use without verification", () => {
    expect(() => requirePostgresTls(`${remoteUrl}?ssl=no-verify`)).toThrow(
      /ssl=no-verify is not allowed/,
    );
    expect(() => requirePostgresTls(`${remoteUrl}?ssl=TRUE`)).toThrow(
      /Unsupported PostgreSQL ssl option/,
    );
  });

  it.each([
    "postgresql://nexus_app@localhost/nexus?sslmode=disable",
    "postgresql://nexus_app@localhost./nexus?sslmode=disable",
    "postgresql://nexus_app@127.0.0.1/nexus?sslmode=disable",
    "postgresql://nexus_app@[::1]/nexus?sslmode=disable",
    "postgresql:///nexus?host=%2Ftmp%2Fpostgresql",
  ])("keeps isolated loopback/socket connection settings (%s)", (url) => {
    expect(requirePostgresTls(url)).toBe(url);
  });

  it("does not mistake a host that merely starts with 127. for loopback", () => {
    const url = "postgresql://nexus_app@127.0.0.1.evil.example/nexus";
    const result = new URL(requirePostgresTls(url));

    expect(result.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("honors node-postgres host overrides when deciding whether TLS is required", () => {
    const url = "postgresql://nexus_app@localhost/nexus?host=db.example.com";
    const result = new URL(requirePostgresTls(url));

    expect(result.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("uses PGHOST when a URL leaves the host blank", () => {
    const previousHost = process.env.PGHOST;
    process.env.PGHOST = "db.example.com";
    try {
      const result = new URL(requirePostgresTls("postgresql:///nexus"));
      expect(result.searchParams.get("sslmode")).toBe("verify-full");
    } finally {
      if (previousHost === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = previousHost;
    }
  });

  it("fails closed on malformed or non-PostgreSQL URLs without echoing their contents", () => {
    expect(() => requirePostgresTls("postgresql://secret@bad host/db")).toThrow(
      /valid postgres/,
    );
    expect(() => requirePostgresTls("mysql://secret@db.example.com/db")).toThrow(
      /use postgres/,
    );
  });
});

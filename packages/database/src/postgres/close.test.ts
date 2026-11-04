
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPostgresDatabase, INTERNAL_POOL } from "./index.js";
import { createPool } from "./pool.js";

vi.mock("./pool.js", () => ({
  createPool: vi.fn(),
  closePool: vi.fn(async (pool: { end: () => Promise<void> }) => {
    await pool.end();
  }),
}));

function makePool(end: () => Promise<void>): Pool {
  return {
    end: vi.fn(end),
    connect: vi.fn(),
    on: vi.fn(),
  } as unknown as Pool;
}

describe("PostgreSQL database close()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("concurrent close() calls await the same real pool shutdown", async () => {
    let release!: () => void;

    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pool = makePool(() => barrier);

    vi.mocked(createPool).mockReturnValue(pool);

    const db = createPostgresDatabase({
      connectionString: "postgres://test:test@localhost:5432/test",
    });

    const first = db.close();
    const second = db.close();

    expect(pool.end).toHaveBeenCalledTimes(1);

    release();

    await Promise.all([first, second]);

    expect(pool.end).toHaveBeenCalledTimes(1);

    await db.close();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("allows retry when the real pool shutdown fails", async () => {
    const pool = makePool(
      vi.fn()
        .mockRejectedValueOnce(new Error("end failed"))
        .mockResolvedValueOnce(undefined),
    );

    vi.mocked(createPool).mockReturnValue(pool);

    const db = createPostgresDatabase({
      connectionString: "postgres://test:test@localhost:5432/test",
    });

    await expect(db.close()).rejects.toThrow("end failed");

    expect(pool.end).toHaveBeenCalledTimes(1);

    await db.close();

    expect(pool.end).toHaveBeenCalledTimes(2);

    await db.close();

    expect(pool.end).toHaveBeenCalledTimes(2);
  });

  it("uses the actual pool instance created by the database factory", () => {
    const pool = makePool(async () => {});

    vi.mocked(createPool).mockReturnValue(pool);

    const db = createPostgresDatabase({
      connectionString: "postgres://test:test@localhost:5432/test",
    });

    expect(db[INTERNAL_POOL]).toBe(pool);
  });
});

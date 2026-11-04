import { describe, expect, it, vi } from "vitest";

// Test close() single-flight and failure retry without a real PostgreSQL.
// We exercise the same control-flow pattern used by createPostgresDatabase.

function createCloseable(endImpl: () => Promise<void>) {
  let closedSuccessfully = false;
  let closeInFlight: Promise<void> | undefined;
  let endCalls = 0;

  const end = async () => {
    endCalls += 1;
    await endImpl();
  };

  const close = async (): Promise<void> => {
    if (closedSuccessfully) return;
    if (closeInFlight) return closeInFlight;

    closeInFlight = (async () => {
      try {
        await end();
        closedSuccessfully = true;
      } catch (error) {
        closeInFlight = undefined;
        throw error;
      }
    })();

    return closeInFlight;
  };

  return {
    close,
    get endCalls() {
      return endCalls;
    },
    get closedSuccessfully() {
      return closedSuccessfully;
    },
  };
}

describe("postgres close semantics", () => {
  it("concurrent close() calls await the same in-flight end", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = createCloseable(async () => {
      await barrier;
    });

    const first = handle.close();
    const second = handle.close();
    expect(handle.endCalls).toBe(1);

    release();
    await Promise.all([first, second]);
    expect(handle.endCalls).toBe(1);
    expect(handle.closedSuccessfully).toBe(true);

    await handle.close();
    expect(handle.endCalls).toBe(1);
  });

  it("does not mark closed when end fails and allows retry", async () => {
    let shouldFail = true;
    const handle = createCloseable(async () => {
      if (shouldFail) throw new Error("end failed");
    });

    await expect(handle.close()).rejects.toThrow("end failed");
    expect(handle.closedSuccessfully).toBe(false);
    expect(handle.endCalls).toBe(1);

    shouldFail = false;
    await handle.close();
    expect(handle.closedSuccessfully).toBe(true);
    expect(handle.endCalls).toBe(2);
  });
});

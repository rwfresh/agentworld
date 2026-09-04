import type { Database } from "@agentworld/db";
import type { Transaction } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  isRetryableTransactionError,
  retryDelayMs,
  runSerializable,
  type SerializableTransactionStarter,
} from "./transaction.ts";

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`sqlstate ${code}`), { code });
}

/** A fake Kysely surface that records isolation levels and hands each attempt a distinct handle. */
function fakeDatabase() {
  const isolationLevels: string[] = [];
  const handles: Array<Transaction<Database>> = [];
  const database: SerializableTransactionStarter<Database> = {
    transaction: () => ({
      setIsolationLevel: (level) => {
        isolationLevels.push(level);
        return {
          async execute(callback) {
            const handle = { attempt: handles.length + 1 } as unknown as Transaction<Database>;
            handles.push(handle);
            return callback(handle);
          },
        };
      },
    }),
  };
  return { database, isolationLevels, handles };
}

describe("runSerializable", () => {
  it("runs the work once inside a serializable transaction when it succeeds", async () => {
    const { database, isolationLevels, handles } = fakeDatabase();
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const work = vi.fn(async (transaction: Transaction<Database>) => ({ transaction, ok: true }));

    const result = await runSerializable(database, work, { sleep });

    expect(result).toEqual({ transaction: handles[0], ok: true });
    expect(isolationLevels).toEqual(["serializable"]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries serialization failures and deadlocks with growing jittered backoff", async () => {
    const { database, handles } = fakeDatabase();
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const outcomes = [pgError("40001"), pgError("40P01")];
    const work = vi.fn(async (transaction: Transaction<Database>) => {
      const failure = outcomes.shift();
      if (failure) throw failure;
      return transaction;
    });

    const result = await runSerializable(database, work, { sleep, random: () => 0.5 });

    // The third attempt received a fresh transaction handle, so the callback is re-entered cleanly.
    expect(result).toBe(handles[2]);
    expect(work).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([15, 30]);
  });

  it("rethrows the last retryable error once the attempts are exhausted", async () => {
    const { database } = fakeDatabase();
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const errors = [pgError("40001"), pgError("40001"), pgError("40P01"), pgError("40001")];
    const work = vi.fn(async () => {
      throw errors[work.mock.calls.length - 1];
    });

    await expect(runSerializable(database, work, { sleep })).rejects.toBe(errors[3]);
    expect(work).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry rule violations, unique violations, or errors without a SQLSTATE", async () => {
    for (const failure of [
      Object.assign(new Error("cooldown"), { code: "COOLDOWN_ACTIVE", status: 409 }),
      pgError("23505"),
      new Error("plain failure"),
    ]) {
      const { database } = fakeDatabase();
      const sleep = vi.fn(async (_milliseconds: number) => {});
      const work = vi.fn(async () => {
        throw failure;
      });

      await expect(runSerializable(database, work, { sleep })).rejects.toBe(failure);
      expect(work).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("honors a custom attempt budget and rejects an invalid one", async () => {
    const { database } = fakeDatabase();
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const work = vi.fn(async () => {
      throw pgError("40001");
    });

    await expect(runSerializable(database, work, { sleep, attempts: 2 })).rejects.toMatchObject({
      code: "40001",
    });
    expect(work).toHaveBeenCalledTimes(2);
    await expect(runSerializable(database, work, { sleep, attempts: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("retryDelayMs", () => {
  it("doubles the ceiling per failure, jitters within its upper half, and caps at the maximum", () => {
    expect(retryDelayMs(1, { random: () => 0 })).toBe(10);
    expect(retryDelayMs(1, { random: () => 0.999 })).toBeLessThan(20);
    expect(retryDelayMs(2, { random: () => 0 })).toBe(20);
    expect(retryDelayMs(3, { random: () => 0 })).toBe(40);
    expect(retryDelayMs(3, { random: () => 0.999 })).toBeLessThan(80);
    expect(retryDelayMs(10, { random: () => 0.999 })).toBeLessThanOrEqual(100);
    expect(retryDelayMs(1, { baseDelayMs: 50, maxDelayMs: 60, random: () => 1 })).toBe(60);
  });
});

describe("isRetryableTransactionError", () => {
  it("recognizes only PostgreSQL serialization and deadlock SQLSTATEs", () => {
    expect(isRetryableTransactionError(pgError("40001"))).toBe(true);
    expect(isRetryableTransactionError(pgError("40P01"))).toBe(true);
    expect(isRetryableTransactionError(pgError("23505"))).toBe(false);
    expect(isRetryableTransactionError({ code: 40001 })).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
    expect(isRetryableTransactionError("40001")).toBe(false);
  });
});

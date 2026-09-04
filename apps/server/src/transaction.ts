import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "@agentworld/db";
import type { Transaction } from "kysely";

/**
 * The slice of Kysely needed to start a serializable transaction. Consumers depend on this
 * narrow shape so the retry policy can be unit-tested against a fake without a database.
 */
export interface SerializableTransactionStarter<DB = Database> {
  transaction(): {
    setIsolationLevel(level: "serializable"): {
      execute<T>(callback: (transaction: Transaction<DB>) => Promise<T>): Promise<T>;
    };
  };
}

export interface SerializableRetryOptions {
  /** Total attempts including the first one. Defaults to 4. */
  readonly attempts?: number;
  /** Backoff ceiling in milliseconds before the first retry; it doubles per retry. Defaults to 10. */
  readonly baseDelayMs?: number;
  /** Upper bound for the backoff ceiling in milliseconds. Defaults to 100. */
  readonly maxDelayMs?: number;
  /** Injection point for tests; defaults to a real timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Injection point for tests; defaults to Math.random. */
  readonly random?: () => number;
}

/** PostgreSQL SQLSTATEs that mean "nothing committed; the same work may succeed if repeated". */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Jittered exponential backoff: after `failedAttempts` failures the delay is drawn from the upper
 * half of `[0, ceiling]`, where the ceiling doubles per failure and is capped at `maxDelayMs`.
 * Defaults yield roughly 10–20 ms, 20–40 ms, and 40–80 ms between the four default attempts.
 */
export function retryDelayMs(
  failedAttempts: number,
  options: Pick<SerializableRetryOptions, "baseDelayMs" | "maxDelayMs" | "random"> = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? 10;
  const maxDelayMs = options.maxDelayMs ?? 100;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** failedAttempts);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Run `work` in a SERIALIZABLE transaction, retrying whole-transaction serialization failures and
 * deadlocks a bounded number of times. `work` must be re-entrant: generate fresh identifiers per
 * attempt and keep every side effect inside the transaction. Any other error, including rule
 * violations surfaced as `HttpProblem`, is rethrown immediately; the last retryable error is
 * rethrown once the attempts are exhausted so the HTTP layer can report it honestly.
 */
export async function runSerializable<T, DB = Database>(
  database: SerializableTransactionStarter<DB>,
  work: (transaction: Transaction<DB>) => Promise<T>,
  options: SerializableRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("transaction attempts must be a positive integer");
  }
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await database.transaction().setIsolationLevel("serializable").execute(work);
    } catch (error) {
      if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
      await sleep(retryDelayMs(attempt, options));
    }
  }
}

import type { Database } from "@agentworld/db";
import type { Transaction } from "kysely";

/**
 * Allocates the next aggregate version for an event under the
 * `events_emitter_aggregate_version_unique` index. Every writer of the same aggregate must use
 * this allocator inside a transaction that already holds the aggregate's row lock; deriving a
 * version from another table (for example `structures.version`) collides with events the API
 * already appended for that aggregate.
 */
export async function nextAggregateVersion(
  transaction: Transaction<Database>,
  emittingServerId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const row = await transaction
    .selectFrom("events")
    .select(({ fn }) => fn.max("aggregateVersion").as("version"))
    .where("emittingServerId", "=", emittingServerId)
    .where("aggregateType", "=", aggregateType)
    .where("aggregateId", "=", aggregateId)
    .executeTakeFirstOrThrow();
  const version = Number(row.version ?? 0) + 1;
  if (!Number.isSafeInteger(version)) throw new RangeError("event aggregate version overflow");
  return version;
}

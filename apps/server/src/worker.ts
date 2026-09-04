import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createDatabase, type Database, type Json } from "@agentworld/db";
import type { Ruleset, StructureType } from "@agentworld/game-rules";
import type { Transaction } from "kysely";

import { readConfig } from "./config.ts";
import { nextAggregateVersion } from "./event-versions.ts";
import {
  checkedAdd,
  type FinalizedWorld,
  finalizeDueWorlds,
  parseTradeResources,
} from "./season-finalization.ts";
import { seedBetaWorld } from "./seed.ts";

type ServerDatabase = ReturnType<typeof createDatabase>;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;
/** Longest pause between polls while consecutive polls keep failing. */
export const MAX_BACKOFF_MS = 60_000;

export type WorkerJobKind =
  | "construction"
  | "trade-expiry"
  | "season-finalization"
  | "season-seeding";

/** A due row one poll could not process. It stays due and is retried by a later poll. */
export interface SkippedRow {
  readonly job: "construction" | "trade-expiry";
  readonly id: string;
  readonly error: unknown;
}

export type RowFailureHandler = (skipped: SkippedRow) => void;

/** Logger surface the worker needs. Messages carry job kinds and row ids, never player text. */
export interface WorkerLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string, error: unknown) => void;
}

export interface WorkerJobs {
  readonly completeDueConstructions: (
    now: Date,
    batchSize: number,
    onRowFailure: RowFailureHandler,
  ) => Promise<number>;
  readonly expireDueTrades: (
    now: Date,
    batchSize: number,
    onRowFailure: RowFailureHandler,
  ) => Promise<number>;
  readonly finalizeDueWorlds: (now: Date, batchSize: number) => Promise<readonly FinalizedWorld[]>;
  readonly seedCurrentSeason: () => Promise<{ readonly worldId: string }>;
}

export interface WorkerIterationDeps {
  readonly jobs: WorkerJobs;
  readonly logger: WorkerLogger;
  readonly capturedAt: Date;
  readonly batchSize: number;
  /** True while a finalized world still needs its successor season seeded. */
  readonly seasonCreationPending: boolean;
}

export interface WorkerIterationOutcome {
  /** Job kinds whose whole poll threw, in execution order. */
  readonly failedJobs: readonly WorkerJobKind[];
  /** Due rows that were logged and left for a later poll. */
  readonly skippedRows: number;
  readonly seasonCreationPending: boolean;
}

export interface WorkerLoopDeps {
  readonly signal: AbortSignal;
  readonly jobs: WorkerJobs;
  readonly logger: WorkerLogger;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const consoleLogger: WorkerLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

const jobLabels: Readonly<Record<WorkerJobKind, string>> = {
  construction: "Construction completion",
  "trade-expiry": "Trade expiry",
  "season-finalization": "Season finalization",
  "season-seeding": "Season seeding",
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function assertBatchSize(batchSize: number, job: string): void {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`${job} batch size must be a positive integer`);
  }
}

function structureType(kind: string): StructureType {
  if (kind === "command_node") return "command-node";
  if (kind === "compute_node") return "compute-node";
  if (kind === "defense_node") return "defense-node";
  if (kind === "generator" || kind === "extractor") return kind;
  throw new Error(`unknown structure kind: ${kind}`);
}

function deterministicId(kind: string, id: string): string {
  const hex = createHash("sha256").update(`agentworld:${kind}:${id}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Direct callers get the failure; only the worker loop opts into skipping rows. */
const rethrowRowFailure: RowFailureHandler = (skipped) => {
  throw skipped.error;
};

async function expireTrade(
  transaction: Transaction<Database>,
  tradeId: string,
  now: Date,
): Promise<boolean> {
  const trade = await transaction
    .selectFrom("trades")
    .select(["id", "worldId", "senderPlayerId", "offered"])
    .where("id", "=", tradeId)
    .where("state", "=", "open")
    .where("expiresAt", "<=", now)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  // Another worker claimed or resolved the offer since the candidate scan.
  if (trade === undefined) return false;

  const offered = parseTradeResources(trade.offered);
  const inventory = await transaction
    .selectFrom("inventories")
    .selectAll()
    .where("worldId", "=", trade.worldId)
    .where("playerId", "=", trade.senderPlayerId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    inventory.escrowEnergy < offered.energy ||
    inventory.escrowMaterials < offered.materials ||
    inventory.escrowInference < offered.inference
  ) {
    throw new Error(`trade escrow is inconsistent: ${trade.id}`);
  }
  await transaction
    .updateTable("inventories")
    .set({
      energy: checkedAdd(inventory.energy, offered.energy, "energy refund"),
      materials: checkedAdd(inventory.materials, offered.materials, "materials refund"),
      inference: checkedAdd(inventory.inference, offered.inference, "inference refund"),
      escrowEnergy: inventory.escrowEnergy - offered.energy,
      escrowMaterials: inventory.escrowMaterials - offered.materials,
      escrowInference: inventory.escrowInference - offered.inference,
      version: inventory.version + 1,
    })
    .where("worldId", "=", trade.worldId)
    .where("playerId", "=", trade.senderPlayerId)
    .execute();
  await transaction
    .updateTable("trades")
    .set({ state: "expired", resolvedAt: now })
    .where("id", "=", trade.id)
    .where("state", "=", "open")
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("resourceLedger")
    .values({
      id: deterministicId("trade-expired", trade.id),
      worldId: trade.worldId,
      playerId: trade.senderPlayerId,
      actionId: null,
      reason: "trade_expired",
      energyDelta: offered.energy,
      materialsDelta: offered.materials,
      inferenceDelta: offered.inference,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
  return true;
}

/**
 * Expires due offers and releases their escrow, one offer per transaction so a corrupt row
 * cannot roll back its neighbours. Competing workers claim disjoint rows with SKIP LOCKED.
 */
export async function expireDueTrades(
  database: ServerDatabase,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  onRowFailure: RowFailureHandler = rethrowRowFailure,
): Promise<number> {
  assertBatchSize(batchSize, "trade expiry");
  const due = await database
    .selectFrom("trades")
    .select("id")
    .where("state", "=", "open")
    .where("expiresAt", "<=", now)
    .orderBy("expiresAt")
    .orderBy("id")
    .limit(batchSize)
    .execute();
  let expired = 0;
  for (const { id } of due) {
    try {
      const done = await database
        .transaction()
        .execute((transaction) => expireTrade(transaction, id, now));
      if (done) expired += 1;
    } catch (error: unknown) {
      onRowFailure({ job: "trade-expiry", id, error });
    }
  }
  return expired;
}

async function completeConstruction(
  transaction: Transaction<Database>,
  structureIdValue: string,
  now: Date,
): Promise<boolean> {
  const structure = await transaction
    .selectFrom("structures")
    .innerJoin("worlds", "worlds.id", "structures.worldId")
    .innerJoin("tiles", (join) =>
      join
        .onRef("tiles.id", "=", "structures.tileId")
        .onRef("tiles.worldId", "=", "structures.worldId"),
    )
    .innerJoin("players", (join) =>
      join
        .onRef("players.id", "=", "structures.ownerPlayerId")
        .onRef("players.worldId", "=", "structures.worldId"),
    )
    .select([
      "structures.id",
      "structures.worldId",
      "structures.ownerPlayerId",
      "structures.kind",
      "structures.completesAt",
      "structures.maxHitPoints",
      "structures.version",
      "worlds.startsAt as worldStartsAt",
      "worlds.homeServerId",
      "worlds.rulesetHash",
      "worlds.ruleset",
      "tiles.zone",
      "players.allianceId",
    ])
    .where("structures.id", "=", structureIdValue)
    .where("structures.status", "=", "constructing")
    .where("structures.completesAt", "is not", null)
    .where("structures.completesAt", "<=", now)
    .whereRef("structures.completesAt", "<=", "worlds.endsAt")
    .where("worlds.state", "=", "active")
    .forUpdate(["worlds", "players", "structures"])
    .skipLocked()
    .executeTakeFirst();
  // Another worker holds the row, finalization holds the world, or the row is no longer due.
  if (structure === undefined || structure.completesAt === null) return false;

  const completionTime = new Date(structure.completesAt);
  const transitioned = await transaction
    .updateTable("structures")
    .set({
      status: "active",
      hitPoints: structure.maxHitPoints,
      activatedAt: completionTime,
      lastProductionAt: completionTime,
      productionRemainderTicks: 0,
      // The row's own optimistic counter; the event version is allocated from the journal below.
      version: structure.version + 1,
    })
    .where("id", "=", structure.id)
    .where("status", "=", "constructing")
    .returning("id")
    .executeTakeFirst();
  if (transitioned === undefined) return false;

  const ruleset = structure.ruleset as unknown as Ruleset;
  const rule = ruleset.structures[structureType(structure.kind)];
  const territoryInfluence =
    structure.zone === "contested"
      ? ruleset.scoring.contestedTile
      : structure.zone === "frontier"
        ? ruleset.scoring.frontierTile
        : 0;
  const scoreDelta = rule.influence + territoryInfluence;
  await transaction
    .updateTable("players")
    .set((expression) => ({
      completedStructures: expression("completedStructures", "+", 1),
      influence: expression("influence", "+", scoreDelta),
    }))
    .where("id", "=", structure.ownerPlayerId)
    .where("worldId", "=", structure.worldId)
    .executeTakeFirstOrThrow();
  if (structure.allianceId) {
    const members = await transaction
      .selectFrom("players")
      .select("influence")
      .where("worldId", "=", structure.worldId)
      .where("allianceId", "=", structure.allianceId)
      .execute();
    const influence = members.reduce((sum, member) => sum + member.influence, 0);
    if (!Number.isSafeInteger(influence)) throw new RangeError("alliance influence overflow");
    await transaction
      .updateTable("alliances")
      .set({ influence })
      .where("worldId", "=", structure.worldId)
      .where("id", "=", structure.allianceId)
      .execute();
  }

  const tick = Math.max(
    0,
    Math.floor(
      ((completionTime.getTime() - new Date(structure.worldStartsAt).getTime()) / 1_000) *
        ruleset.ticksPerSecond,
    ),
  );
  const payload: Json = {
    structureId: structure.id,
    structureType: structure.kind,
    ownerPlayerId: structure.ownerPlayerId,
    completedAt: completionTime.toISOString(),
  };
  await transaction
    .insertInto("events")
    .values({
      id: deterministicId("construction-completed", structure.id),
      worldId: structure.worldId,
      emittingServerId: structure.homeServerId,
      actionId: null,
      actorPlayerId: structure.ownerPlayerId,
      type: "CONSTRUCTION_COMPLETED",
      aggregateType: "structure",
      aggregateId: structure.id,
      aggregateVersion: await nextAggregateVersion(
        transaction,
        structure.homeServerId,
        "structure",
        structure.id,
      ),
      tick,
      rulesetHash: structure.rulesetHash,
      payloadVersion: 1,
      visibility: "player",
      payload,
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
  return true;
}

/**
 * Activates due structures one per transaction: each row is re-checked and locked with SKIP
 * LOCKED, then its state change, player progress, and audit event commit together. A failing row
 * is reported to `onRowFailure` and left due; the rest of the batch still completes.
 */
export async function completeDueConstructions(
  database: ServerDatabase,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  onRowFailure: RowFailureHandler = rethrowRowFailure,
): Promise<number> {
  assertBatchSize(batchSize, "construction");
  const due = await database
    .selectFrom("structures")
    .innerJoin("worlds", "worlds.id", "structures.worldId")
    .select("structures.id")
    .where("structures.status", "=", "constructing")
    .where("structures.completesAt", "is not", null)
    .where("structures.completesAt", "<=", now)
    .whereRef("structures.completesAt", "<=", "worlds.endsAt")
    .where("worlds.state", "=", "active")
    .orderBy("structures.completesAt", "asc")
    .orderBy("structures.id", "asc")
    .limit(batchSize)
    .execute();
  let completed = 0;
  for (const { id } of due) {
    try {
      const done = await database
        .transaction()
        .execute((transaction) => completeConstruction(transaction, id, now));
      if (done) completed += 1;
    } catch (error: unknown) {
      onRowFailure({ job: "construction", id, error });
    }
  }
  return completed;
}

/**
 * Runs one poll. Every job kind gets its own failure boundary so a failing construction row
 * cannot starve trade expiry or season finalization, and a failed seeding stays pending.
 */
export async function runWorkerIteration(
  deps: WorkerIterationDeps,
): Promise<WorkerIterationOutcome> {
  const { jobs, logger, capturedAt, batchSize } = deps;
  const failedJobs: WorkerJobKind[] = [];
  let skippedRows = 0;
  const onRowFailure: RowFailureHandler = ({ job, id, error }) => {
    skippedRows += 1;
    logger.error(`${jobLabels[job]} skipped row ${id}; it stays due for a later poll`, error);
  };
  const attempt = async <Result>(
    job: WorkerJobKind,
    run: () => Promise<Result>,
  ): Promise<Result | undefined> => {
    try {
      return await run();
    } catch (error: unknown) {
      failedJobs.push(job);
      logger.error(`${jobLabels[job]} failed for this poll`, error);
      return undefined;
    }
  };

  // Complete and expire ordinary work before taking the coarser world finalization lock.
  // The ordering also prevents a single process from racing completion against cutoff.
  const completed = await attempt("construction", () =>
    jobs.completeDueConstructions(capturedAt, batchSize, onRowFailure),
  );
  if (completed !== undefined && completed > 0) {
    logger.info(`Completed ${completed} construction job(s)`);
  }
  const expired = await attempt("trade-expiry", () =>
    jobs.expireDueTrades(capturedAt, batchSize, onRowFailure),
  );
  if (expired !== undefined && expired > 0) logger.info(`Expired ${expired} trade offer(s)`);
  const finalized = await attempt("season-finalization", () =>
    jobs.finalizeDueWorlds(capturedAt, batchSize),
  );
  for (const world of finalized ?? []) {
    logger.info(
      `Finalized world ${world.worldId} with ${world.playerCount} player(s) and ${world.allianceCount} alliance(s)`,
    );
  }

  let seasonCreationPending =
    deps.seasonCreationPending || (finalized !== undefined && finalized.length > 0);
  if (seasonCreationPending) {
    const next = await attempt("season-seeding", () => jobs.seedCurrentSeason());
    if (next !== undefined) {
      seasonCreationPending = false;
      logger.info(`Ensured current season world ${next.worldId}`);
    }
  }
  return { failedJobs, skippedRows, seasonCreationPending };
}

/** Delay before the next poll: the poll interval doubles per consecutive failing poll, capped. */
export function backoffDelay(
  pollIntervalMs: number,
  consecutiveFailures: number,
  maxDelayMs = MAX_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return pollIntervalMs;
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.max(pollIntervalMs, Math.min(pollIntervalMs * 2 ** exponent, maxDelayMs));
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
  }
}

/** Polls until aborted. A poll with any failed job kind or skipped row counts as a failure. */
export async function runWorkerLoop(deps: WorkerLoopDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? abortableDelay;
  let seasonCreationPending = false;
  let consecutiveFailures = 0;
  while (!deps.signal.aborted) {
    const outcome = await runWorkerIteration({
      jobs: deps.jobs,
      logger: deps.logger,
      capturedAt: now(),
      batchSize: deps.batchSize,
      seasonCreationPending,
    });
    if (deps.signal.aborted) break;
    seasonCreationPending = outcome.seasonCreationPending;
    const failed = outcome.failedJobs.length > 0 || outcome.skippedRows > 0;
    consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
    const wait = backoffDelay(deps.pollIntervalMs, consecutiveFailures);
    if (failed) {
      deps.logger.warn(
        `Worker poll had ${outcome.failedJobs.length} failed job kind(s) and ${outcome.skippedRows} skipped row(s) (${consecutiveFailures} consecutive failing poll(s)); next poll in ${wait} ms`,
      );
    }
    await sleep(wait, deps.signal);
  }
}

export async function runWorker(
  signal: AbortSignal,
  logger: WorkerLogger = consoleLogger,
): Promise<void> {
  const config = readConfig();
  const pollIntervalMs = positiveInteger(
    process.env.WORKER_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    "WORKER_POLL_INTERVAL_MS",
  );
  const batchSize = positiveInteger(
    process.env.WORKER_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    "WORKER_BATCH_SIZE",
  );
  const database = createDatabase(config.databaseUrl);
  const jobs: WorkerJobs = {
    completeDueConstructions: (now, size, onRowFailure) =>
      completeDueConstructions(database, now, size, onRowFailure),
    expireDueTrades: (now, size, onRowFailure) =>
      expireDueTrades(database, now, size, onRowFailure),
    finalizeDueWorlds: (now, size) => finalizeDueWorlds(database, now, size),
    seedCurrentSeason: () => seedBetaWorld(config),
  };
  try {
    await runWorkerLoop({ signal, jobs, logger, pollIntervalMs, batchSize });
  } finally {
    await database.destroy();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  runWorker(controller.signal)
    .catch((error: unknown) => {
      console.error("Durable worker stopped unexpectedly", error);
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    });
}

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createDatabase, type Json } from "@agentworld/db";
import type { Ruleset, StructureType } from "@agentworld/game-rules";

import { readConfig } from "./config.ts";
import { seedBetaWorld } from "./seed.ts";
import { finalizeDueWorlds } from "./season-finalization.ts";

type ServerDatabase = ReturnType<typeof createDatabase>;
interface TradeResources {
  readonly energy: number;
  readonly materials: number;
  readonly inference: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function completionEventId(structureId: string): string {
  const hex = createHash("sha256")
    .update(`agentworld:construction-completed:${structureId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

function tradeResources(value: Json): TradeResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trade has an invalid offered resource vector");
  }
  const energy = value.energy;
  const materials = value.materials;
  const inference = value.inference;
  if (
    !Number.isSafeInteger(energy) ||
    !Number.isSafeInteger(materials) ||
    !Number.isSafeInteger(inference)
  ) {
    throw new Error("trade has an invalid offered resource vector");
  }
  return {
    energy: energy as number,
    materials: materials as number,
    inference: inference as number,
  };
}

/** Atomically expires offers and releases their escrow. Competing workers claim disjoint rows. */
export async function expireDueTrades(
  database: ServerDatabase,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("trade expiry batch size must be a positive integer");
  }
  return database.transaction().execute(async (transaction): Promise<number> => {
    const due = await transaction
      .selectFrom("trades")
      .select(["id", "worldId", "senderPlayerId", "offered"])
      .where("state", "=", "open")
      .where("expiresAt", "<=", now)
      .orderBy("expiresAt")
      .orderBy("id")
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const trade of due) {
      const offered = tradeResources(trade.offered);
      const inventory = await transaction
        .selectFrom("inventories")
        .selectAll()
        .where("worldId", "=", trade.worldId)
        .where("playerId", "=", trade.senderPlayerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("inventories")
        .set({
          energy: inventory.energy + offered.energy,
          materials: inventory.materials + offered.materials,
          inference: inventory.inference + offered.inference,
          escrowEnergy: inventory.escrowEnergy - offered.energy,
          escrowMaterials: inventory.escrowMaterials - offered.materials,
          escrowInference: inventory.escrowInference - offered.inference,
          version: inventory.version + 1,
        })
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
    }
    return due.length;
  });
}

/**
 * Claims due rows with SKIP LOCKED, then activates each structure and writes its audit event in
 * the same transaction. A second worker can safely process a disjoint batch.
 */
export async function completeDueConstructions(
  database: ServerDatabase,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("construction batch size must be a positive integer");
  }
  return database.transaction().execute(async (transaction): Promise<number> => {
    const due = await transaction
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
      .where("structures.status", "=", "constructing")
      .where("structures.completesAt", "is not", null)
      .where("structures.completesAt", "<=", now)
      .whereRef("structures.completesAt", "<=", "worlds.endsAt")
      .where("worlds.state", "=", "active")
      .orderBy("structures.completesAt", "asc")
      .orderBy("structures.id", "asc")
      .limit(batchSize)
      .forUpdate(["worlds", "players", "structures"])
      .skipLocked()
      .execute();

    let completed = 0;
    for (const structure of due) {
      if (structure.completesAt === null) continue;
      const completionTime = new Date(structure.completesAt);
      const nextVersion = structure.version + 1;
      const transitioned = await transaction
        .updateTable("structures")
        .set({
          status: "active",
          hitPoints: structure.maxHitPoints,
          activatedAt: completionTime,
          lastProductionAt: completionTime,
          productionRemainderTicks: 0,
          version: nextVersion,
        })
        .where("id", "=", structure.id)
        .where("status", "=", "constructing")
        .returning("id")
        .executeTakeFirst();
      if (transitioned === undefined) continue;

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
          id: completionEventId(structure.id),
          worldId: structure.worldId,
          emittingServerId: structure.homeServerId,
          actionId: null,
          actorPlayerId: structure.ownerPlayerId,
          type: "CONSTRUCTION_COMPLETED",
          aggregateType: "structure",
          aggregateId: structure.id,
          aggregateVersion: nextVersion,
          tick,
          rulesetHash: structure.rulesetHash,
          payloadVersion: 1,
          visibility: "player",
          payload,
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .execute();
      completed += 1;
    }
    return completed;
  });
}

export async function runWorker(signal: AbortSignal): Promise<void> {
  const config = readConfig();
  const pollInterval = positiveInteger(
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
  let seasonCreationPending = false;
  try {
    while (!signal.aborted) {
      try {
        const capturedAt = new Date();
        // Complete and expire ordinary work before taking the coarser world finalization lock.
        // The ordering also prevents a single process from racing completion against cutoff.
        const completed = await completeDueConstructions(database, capturedAt, batchSize);
        const expired = await expireDueTrades(database, capturedAt, batchSize);
        const finalized = await finalizeDueWorlds(database, capturedAt, batchSize);
        seasonCreationPending ||= finalized.length > 0;
        if (completed > 0) console.info(`Completed ${completed} construction job(s)`);
        if (expired > 0) console.info(`Expired ${expired} trade offer(s)`);
        for (const world of finalized) {
          console.info(
            `Finalized world ${world.worldId} with ${world.playerCount} player(s) and ${world.allianceCount} alliance(s)`,
          );
        }
        if (seasonCreationPending) {
          const next = await seedBetaWorld(config);
          seasonCreationPending = false;
          console.info(`Ensured current season world ${next.worldId}`);
        }
      } catch (error: unknown) {
        if (signal.aborted) break;
        console.error("Durable worker iteration failed; retrying", error);
      }
      try {
        await delay(pollInterval, undefined, { signal });
      } catch (error: unknown) {
        if (!signal.aborted) throw error;
      }
    }
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

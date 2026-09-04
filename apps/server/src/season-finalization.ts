import { createHash } from "node:crypto";

import type { Database, Json } from "@agentworld/db";
import {
  addResources,
  assertValidRuleset,
  type CivilizationState,
  coordinate,
  createWorldDescriptor,
  emptyResources,
  type GameSnapshot,
  type InfluenceBreakdown,
  playerId,
  type ResourceVector,
  type Ruleset,
  resources,
  type StructureState,
  type StructureType,
  scorePlayer,
  settlePassiveProduction,
  structureId,
  type Tick,
  tick,
  worldId,
} from "@agentworld/game-rules";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

import { nextAggregateVersion } from "./event-versions.ts";

type ServerDatabase = Kysely<Database>;

export interface TradeResources {
  readonly energy: number;
  readonly materials: number;
  readonly inference: number;
}

interface ProductionSweep {
  readonly snapshot: GameSnapshot;
  readonly producedByPlayer: ReadonlyMap<string, ResourceVector>;
}

interface RankedPlayer {
  readonly playerId: string;
  readonly allianceId: string | null;
  readonly influence: InfluenceBreakdown;
  readonly scoreReachedAt: Date;
}

interface RankedAlliance {
  readonly allianceId: string;
  readonly totalInfluence: number;
  readonly memberCount: number;
  readonly scoreReachedAt: Date;
}

export interface FinalizedWorld {
  readonly worldId: string;
  readonly playerCount: number;
  readonly allianceCount: number;
}

function deterministicId(kind: string, id: string): string {
  const hex = createHash("sha256").update(`agentworld:${kind}:${id}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Parses a persisted escrow vector. Trades are player-authored rows, so a negative or
 * non-integer component must fail closed instead of silently moving resources backwards.
 */
export function parseTradeResources(value: Json): TradeResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trade has an invalid offered resource vector");
  }
  const energy = value.energy;
  const materials = value.materials;
  const inference = value.inference;
  if (
    !Number.isSafeInteger(energy) ||
    !Number.isSafeInteger(materials) ||
    !Number.isSafeInteger(inference) ||
    (energy as number) < 0 ||
    (materials as number) < 0 ||
    (inference as number) < 0
  ) {
    throw new Error("trade has an invalid offered resource vector");
  }
  return {
    energy: energy as number,
    materials: materials as number,
    inference: inference as number,
  };
}

export function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} exceeds safe integer bounds`);
  }
  return result;
}

function rulesetFrom(value: Json): Ruleset {
  return assertValidRuleset(value as unknown as Ruleset);
}

function structureType(value: string): StructureType {
  switch (value) {
    case "command_node":
      return "command-node";
    case "generator":
    case "extractor":
      return value;
    case "compute_node":
      return "compute-node";
    case "defense_node":
      return "defense-node";
    default:
      throw new Error(`unknown persisted structure kind: ${value}`);
  }
}

function tickAt(startsAt: Date, endsAt: Date, capturedAt: Date, ruleset: Ruleset): Tick {
  const milliseconds =
    Math.min(Math.max(capturedAt.getTime(), startsAt.getTime()), endsAt.getTime()) -
    startsAt.getTime();
  return tick(Math.floor((milliseconds * ruleset.ticksPerSecond) / 1_000));
}

/**
 * Applies the core settlement rule repeatedly so its offline cap bounds each chunk without
 * discarding older production at season cutoff.
 */
export function settleProductionThroughTick(
  snapshot: GameSnapshot,
  finalTick: Tick,
  ruleset: Ruleset,
): ProductionSweep {
  const players = new Map(snapshot.players.map((player) => [player.id, player]));
  const producedByPlayer = new Map<string, ResourceVector>();
  const structures: StructureState[] = [];

  for (const initialStructure of [...snapshot.structures].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const production = ruleset.structures[initialStructure.type].production;
    if (initialStructure.status !== "active" || production === undefined) {
      structures.push(initialStructure);
      continue;
    }
    if (initialStructure.lastProductionTick > finalTick) {
      throw new RangeError("production cursor is beyond the season cutoff");
    }
    let currentStructure = initialStructure;
    let currentPlayer = players.get(initialStructure.ownerId);
    if (currentPlayer === undefined) throw new Error("structure owner is missing");
    while (currentStructure.lastProductionTick < finalTick) {
      const target = tick(
        Math.min(
          finalTick,
          currentStructure.lastProductionTick + ruleset.production.offlineCapTicks,
        ),
      );
      const partial = settlePassiveProduction(
        {
          world: snapshot.world,
          players: [currentPlayer],
          structures: [currentStructure],
          hostilities: [],
        },
        currentPlayer.id,
        target,
        ruleset,
      );
      const settledPlayer = partial.state.players[0];
      const settledStructure = partial.state.structures[0];
      if (settledPlayer === undefined || settledStructure === undefined) {
        throw new Error("production settlement returned an incomplete aggregate");
      }
      currentPlayer = settledPlayer;
      currentStructure = settledStructure;
      producedByPlayer.set(
        currentPlayer.id,
        addResources(producedByPlayer.get(currentPlayer.id) ?? emptyResources(), partial.produced),
      );
    }
    players.set(currentPlayer.id, currentPlayer);
    structures.push(currentStructure);
  }

  return {
    snapshot: {
      ...snapshot,
      players: snapshot.players.map((player) => players.get(player.id) ?? player),
      structures,
    },
    producedByPlayer,
  };
}

function compareRanked<T extends { readonly scoreReachedAt: Date }>(
  left: T,
  right: T,
  score: (value: T) => number,
  id: (value: T) => string,
): number {
  return (
    score(right) - score(left) ||
    left.scoreReachedAt.getTime() - right.scoreReachedAt.getTime() ||
    id(left).localeCompare(id(right))
  );
}

async function finalizeClaimedWorld(
  transaction: Transaction<Database>,
  world: Awaited<ReturnType<typeof claimDueWorld>> & object,
  finalizedAt: Date,
): Promise<FinalizedWorld> {
  const ruleset = rulesetFrom(world.ruleset);
  const startsAt = new Date(world.startsAt);
  const cutoffAt = new Date(world.endsAt);
  const finalTick = tickAt(startsAt, cutoffAt, cutoffAt, ruleset);
  const descriptor = createWorldDescriptor(worldId(world.id), world.seed, ruleset);
  if (world.width !== descriptor.width || world.height !== descriptor.height) {
    throw new Error(`world ${world.id} dimensions do not match its persisted ruleset`);
  }

  if (world.state === "active") {
    await transaction
      .updateTable("worlds")
      .set({ state: "finalizing" })
      .where("id", "=", world.id)
      .where("state", "=", "active")
      .executeTakeFirstOrThrow();
  }

  const existingFinalization = await transaction
    .selectFrom("seasonFinalizations")
    .select(["worldId", "finalizedAt"])
    .where("worldId", "=", world.id)
    .executeTakeFirst();
  if (existingFinalization !== undefined) {
    await transaction
      .updateTable("worlds")
      .set({ state: "archived", archivedAt: existingFinalization.finalizedAt })
      .where("id", "=", world.id)
      .where("state", "=", "finalizing")
      .execute();
    const [players, alliances] = await Promise.all([
      transaction
        .selectFrom("seasonPlayerRankings")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("worldId", "=", world.id)
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("seasonAllianceRankings")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("worldId", "=", world.id)
        .executeTakeFirstOrThrow(),
    ]);
    return { worldId: world.id, playerCount: players.count, allianceCount: alliances.count };
  }

  // Lock every player before subordinate aggregates. All mutation paths lock their actor first.
  const playerRows = await transaction
    .selectFrom("players")
    .selectAll()
    .where("worldId", "=", world.id)
    .orderBy("id")
    .forUpdate()
    .execute();
  const openTrades = await transaction
    .selectFrom("trades")
    .selectAll()
    .where("worldId", "=", world.id)
    .where("state", "=", "open")
    .orderBy("id")
    .forUpdate()
    .execute();
  const inventoryRows = await transaction
    .selectFrom("inventories")
    .selectAll()
    .where("worldId", "=", world.id)
    .orderBy("playerId")
    .forUpdate()
    .execute();
  const inventoryByPlayer = new Map(
    inventoryRows.map((inventory) => [inventory.playerId, inventory]),
  );

  for (const trade of openTrades) {
    const offered = parseTradeResources(trade.offered);
    const current = inventoryByPlayer.get(trade.senderPlayerId);
    if (current === undefined) throw new Error(`trade sender inventory is missing: ${trade.id}`);
    if (
      current.escrowEnergy < offered.energy ||
      current.escrowMaterials < offered.materials ||
      current.escrowInference < offered.inference
    ) {
      throw new Error(`trade escrow is inconsistent: ${trade.id}`);
    }
    inventoryByPlayer.set(trade.senderPlayerId, {
      ...current,
      energy: checkedAdd(current.energy, offered.energy, "energy refund"),
      materials: checkedAdd(current.materials, offered.materials, "materials refund"),
      inference: checkedAdd(current.inference, offered.inference, "inference refund"),
      escrowEnergy: current.escrowEnergy - offered.energy,
      escrowMaterials: current.escrowMaterials - offered.materials,
      escrowInference: current.escrowInference - offered.inference,
    });
    await transaction
      .updateTable("trades")
      .set({ state: "expired", resolvedAt: cutoffAt })
      .where("id", "=", trade.id)
      .where("worldId", "=", world.id)
      .where("state", "=", "open")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("resourceLedger")
      .values({
        id: deterministicId("season-trade-refund", trade.id),
        worldId: world.id,
        playerId: trade.senderPlayerId,
        actionId: null,
        reason: "season_trade_refund",
        energyDelta: offered.energy,
        materialsDelta: offered.materials,
        inferenceDelta: offered.inference,
        createdAt: cutoffAt,
      })
      .execute();
  }

  const structureRows = await transaction
    .selectFrom("structures")
    .innerJoin("tiles", (join) =>
      join
        .onRef("tiles.id", "=", "structures.tileId")
        .onRef("tiles.worldId", "=", "structures.worldId"),
    )
    .selectAll("structures")
    .select(["tiles.x as tileX", "tiles.y as tileY"])
    .where("structures.worldId", "=", world.id)
    .orderBy("structures.id")
    .forUpdate("structures")
    .execute();
  const completedByPlayer = new Map<string, number>();
  const normalizedStructures = [] as Array<(typeof structureRows)[number]>;
  for (const structure of structureRows) {
    if (
      structure.status === "constructing" &&
      structure.completesAt !== null &&
      new Date(structure.completesAt).getTime() <= cutoffAt.getTime()
    ) {
      const completionAt = new Date(structure.completesAt);
      // The row version is the structure's own optimistic counter; the event version comes from
      // the event journal so it never collides with CONSTRUCTION_STARTED appended by the API.
      const nextVersion = structure.version + 1;
      await transaction
        .updateTable("structures")
        .set({
          status: "active",
          hitPoints: structure.maxHitPoints,
          activatedAt: completionAt,
          lastProductionAt: completionAt,
          productionRemainderTicks: 0,
          version: nextVersion,
        })
        .where("id", "=", structure.id)
        .where("worldId", "=", world.id)
        .where("status", "=", "constructing")
        .executeTakeFirstOrThrow();
      completedByPlayer.set(
        structure.ownerPlayerId,
        (completedByPlayer.get(structure.ownerPlayerId) ?? 0) + 1,
      );
      await transaction
        .insertInto("events")
        .values({
          id: deterministicId("construction-completed", structure.id),
          worldId: world.id,
          emittingServerId: world.homeServerId,
          actionId: null,
          actorPlayerId: structure.ownerPlayerId,
          type: "CONSTRUCTION_COMPLETED",
          aggregateType: "structure",
          aggregateId: structure.id,
          aggregateVersion: await nextAggregateVersion(
            transaction,
            world.homeServerId,
            "structure",
            structure.id,
          ),
          tick: tickAt(startsAt, cutoffAt, completionAt, ruleset),
          rulesetHash: world.rulesetHash,
          payloadVersion: 1,
          visibility: "player",
          payload: {
            structureId: structure.id,
            structureType: structure.kind,
            ownerPlayerId: structure.ownerPlayerId,
            completedAt: completionAt.toISOString(),
          },
          occurredAt: completionAt,
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .execute();
      normalizedStructures.push({
        ...structure,
        status: "active",
        hitPoints: structure.maxHitPoints,
        activatedAt: completionAt,
        lastProductionAt: completionAt,
        productionRemainderTicks: 0,
        version: nextVersion,
      });
    } else {
      normalizedStructures.push(structure);
    }
  }

  const playerStates: CivilizationState[] = playerRows.map((row) => {
    const inventory = inventoryByPlayer.get(row.id);
    if (inventory === undefined) throw new Error(`player inventory is missing: ${row.id}`);
    return {
      id: playerId(row.id),
      position: coordinate(row.positionX, row.positionY),
      homePlot: [],
      inventory: {
        bound: resources(inventory.boundEnergy, inventory.boundMaterials, inventory.boundInference),
        transferable: resources(inventory.energy, inventory.materials, inventory.inference),
      },
      discoveredTileKeys: [],
      cooldowns: {},
      joinedAtTick: tickAt(startsAt, cutoffAt, new Date(row.spawnedAt), ruleset),
      successfulMutations: row.successfulMutations,
      completedStructures: row.completedStructures + (completedByPlayer.get(row.id) ?? 0),
      earnedResources: resources(row.earnedEnergy, row.earnedMaterials, row.earnedInference),
      combatInfluence: row.combatInfluence,
      combatAwardWindows: [],
      persistentTrustTier: 0,
    };
  });
  for (const row of normalizedStructures) {
    if (
      row.status === "active" &&
      ruleset.structures[structureType(row.kind)].production !== undefined &&
      new Date(row.lastProductionAt).getTime() > cutoffAt.getTime()
    ) {
      throw new Error(`structure production cursor is beyond season cutoff: ${row.id}`);
    }
  }
  const structureStates: StructureState[] = normalizedStructures.map((row) => ({
    id: structureId(row.id),
    ownerId: playerId(row.ownerPlayerId),
    type: structureType(row.kind),
    coordinate: coordinate(row.tileX, row.tileY),
    status: row.status,
    hp: row.hitPoints,
    ...(row.completesAt === null
      ? {}
      : {
          constructionCompleteTick: tickAt(startsAt, cutoffAt, new Date(row.completesAt), ruleset),
        }),
    lastProductionTick: tickAt(startsAt, cutoffAt, new Date(row.lastProductionAt), ruleset),
    productionRemainderTicks: row.productionRemainderTicks,
  }));
  const swept = settleProductionThroughTick(
    { world: descriptor, players: playerStates, structures: structureStates, hostilities: [] },
    finalTick,
    ruleset,
  );
  const settledPlayers = new Map<string, CivilizationState>(
    swept.snapshot.players.map((player) => [player.id, player]),
  );
  const settledStructures = new Map<string, StructureState>(
    swept.snapshot.structures.map((structure) => [structure.id, structure]),
  );

  for (const row of playerRows) {
    const settled = settledPlayers.get(row.id);
    const inventory = inventoryByPlayer.get(row.id);
    if (settled === undefined || inventory === undefined)
      throw new Error("settled player is missing");
    const produced = swept.producedByPlayer.get(row.id) ?? emptyResources();
    await transaction
      .updateTable("players")
      .set({
        completedStructures: settled.completedStructures,
        earnedEnergy: settled.earnedResources.energy,
        earnedMaterials: settled.earnedResources.materials,
        earnedInference: settled.earnedResources.inference,
      })
      .where("id", "=", row.id)
      .where("worldId", "=", world.id)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("inventories")
      .set({
        energy: settled.inventory.transferable.energy,
        materials: settled.inventory.transferable.materials,
        inference: settled.inventory.transferable.inference,
        escrowEnergy: inventory.escrowEnergy,
        escrowMaterials: inventory.escrowMaterials,
        escrowInference: inventory.escrowInference,
        lastSettledAt: cutoffAt,
        producedEnergy: settled.earnedResources.energy,
        producedMaterials: settled.earnedResources.materials,
        producedInference: settled.earnedResources.inference,
        version: sql`version + 1`,
      })
      .where("playerId", "=", row.id)
      .where("worldId", "=", world.id)
      .executeTakeFirstOrThrow();
    if (produced.energy + produced.materials + produced.inference > 0) {
      await transaction
        .insertInto("resourceLedger")
        .values({
          id: deterministicId("season-production", `${world.id}:${row.id}`),
          worldId: world.id,
          playerId: row.id,
          actionId: null,
          reason: "season_final_production",
          energyDelta: produced.energy,
          materialsDelta: produced.materials,
          inferenceDelta: produced.inference,
          createdAt: cutoffAt,
        })
        .execute();
      await transaction
        .insertInto("events")
        .values({
          id: deterministicId("season-production-event", `${world.id}:${row.id}`),
          worldId: world.id,
          emittingServerId: world.homeServerId,
          actionId: null,
          actorPlayerId: row.id,
          type: "RESOURCES_PRODUCED",
          aggregateType: "player",
          aggregateId: row.id,
          aggregateVersion: await nextAggregateVersion(
            transaction,
            world.homeServerId,
            "player",
            row.id,
          ),
          tick: finalTick,
          rulesetHash: world.rulesetHash,
          payloadVersion: 1,
          visibility: "player",
          payload: {
            resources: {
              energy: produced.energy,
              materials: produced.materials,
              inference: produced.inference,
            },
          },
          occurredAt: cutoffAt,
        })
        .execute();
    }
  }
  for (const row of normalizedStructures) {
    const settled = settledStructures.get(row.id);
    if (
      settled === undefined ||
      settled.status !== "active" ||
      ruleset.structures[settled.type].production === undefined
    ) {
      continue;
    }
    await transaction
      .updateTable("structures")
      .set({
        lastProductionAt: cutoffAt,
        productionRemainderTicks: settled.productionRemainderTicks,
        version: sql`version + 1`,
      })
      .where("id", "=", row.id)
      .where("worldId", "=", world.id)
      .executeTakeFirstOrThrow();
  }

  const allianceRows = await transaction
    .selectFrom("alliances")
    .selectAll()
    .where("worldId", "=", world.id)
    .where((expression) =>
      expression.or([
        expression("disbandedAt", "is", null),
        expression("disbandedAt", ">", cutoffAt),
      ]),
    )
    .orderBy("id")
    .forUpdate()
    .execute();
  const allianceIds = new Set(allianceRows.map((alliance) => alliance.id));
  const membershipRows = await transaction
    .selectFrom("allianceMembers")
    .selectAll()
    .where("worldId", "=", world.id)
    .where("joinedAt", "<=", cutoffAt)
    .where((expression) =>
      expression.or([expression("leftAt", "is", null), expression("leftAt", ">", cutoffAt)]),
    )
    .orderBy("allianceId")
    .orderBy("playerId")
    .forUpdate()
    .execute();
  const allianceByPlayer = new Map<string, string>();
  const membersByAlliance = new Map<string, string[]>();
  for (const membership of membershipRows) {
    if (!allianceIds.has(membership.allianceId)) continue;
    if (allianceByPlayer.has(membership.playerId)) {
      throw new Error(
        `player has overlapping alliance membership at cutoff: ${membership.playerId}`,
      );
    }
    allianceByPlayer.set(membership.playerId, membership.allianceId);
    const members = membersByAlliance.get(membership.allianceId) ?? [];
    members.push(membership.playerId);
    membersByAlliance.set(membership.allianceId, members);
  }

  const rankedPlayers: RankedPlayer[] = playerRows
    .map((row) => {
      const influence = scorePlayer(swept.snapshot, playerId(row.id), ruleset);
      return {
        playerId: row.id,
        allianceId: allianceByPlayer.get(row.id) ?? null,
        influence,
        // Beta resolves equal scores by UUID. A common cutoff value keeps the snapshot schema
        // stable without treating lazy-settlement timestamps as exact score-crossing evidence.
        scoreReachedAt: cutoffAt,
      };
    })
    .sort((left, right) =>
      compareRanked(
        left,
        right,
        (value) => value.influence.total,
        (value) => value.playerId,
      ),
    );
  for (const player of rankedPlayers) {
    await transaction
      .updateTable("players")
      .set({ influence: player.influence.total })
      .where("id", "=", player.playerId)
      .where("worldId", "=", world.id)
      .executeTakeFirstOrThrow();
  }
  if (rankedPlayers.length > 0) {
    await transaction
      .insertInto("seasonPlayerRankings")
      .values(
        rankedPlayers.map((player, index) => ({
          worldId: world.id,
          playerId: player.playerId,
          allianceId: player.allianceId,
          rank: index + 1,
          territoryInfluence: player.influence.territory,
          structureInfluence: player.influence.structures,
          economyInfluence: player.influence.economy,
          combatInfluence: player.influence.combat,
          totalInfluence: player.influence.total,
          scoreReachedAt: player.scoreReachedAt,
          finalizedAt,
          rulesetHash: world.rulesetHash,
        })),
      )
      .execute();
  }

  const rankedPlayerById = new Map(rankedPlayers.map((player) => [player.playerId, player]));
  const rankedAlliances: RankedAlliance[] = allianceRows
    .flatMap((alliance): RankedAlliance[] => {
      const members = (membersByAlliance.get(alliance.id) ?? [])
        .map((id) => rankedPlayerById.get(id))
        .filter((player): player is RankedPlayer => player !== undefined);
      if (members.length === 0) return [];
      return [
        {
          allianceId: alliance.id,
          totalInfluence: members.reduce((total, player) => {
            return checkedAdd(total, player.influence.total, "alliance influence");
          }, 0),
          memberCount: members.length,
          scoreReachedAt: cutoffAt,
        },
      ];
    })
    .sort((left, right) =>
      compareRanked(
        left,
        right,
        (value) => value.totalInfluence,
        (value) => value.allianceId,
      ),
    );
  for (const alliance of allianceRows) {
    const score = rankedAlliances.find((candidate) => candidate.allianceId === alliance.id);
    await transaction
      .updateTable("alliances")
      .set({ influence: score?.totalInfluence ?? 0 })
      .where("id", "=", alliance.id)
      .where("worldId", "=", world.id)
      .executeTakeFirstOrThrow();
  }
  if (rankedAlliances.length > 0) {
    await transaction
      .insertInto("seasonAllianceRankings")
      .values(
        rankedAlliances.map((alliance, index) => ({
          worldId: world.id,
          allianceId: alliance.allianceId,
          rank: index + 1,
          totalInfluence: alliance.totalInfluence,
          memberCount: alliance.memberCount,
          scoreReachedAt: alliance.scoreReachedAt,
          finalizedAt,
          rulesetHash: world.rulesetHash,
        })),
      )
      .execute();
  }

  await transaction
    .insertInto("seasonFinalizations")
    .values({
      worldId: world.id,
      finalTick,
      cutoffAt,
      rulesetHash: world.rulesetHash,
      finalizedAt,
    })
    .execute();
  await transaction
    .insertInto("events")
    .values({
      id: deterministicId("season-finalized", world.id),
      worldId: world.id,
      emittingServerId: world.homeServerId,
      actionId: null,
      actorPlayerId: null,
      type: "SEASON_FINALIZED",
      aggregateType: "world",
      aggregateId: world.id,
      aggregateVersion: await nextAggregateVersion(
        transaction,
        world.homeServerId,
        "world",
        world.id,
      ),
      tick: finalTick,
      rulesetHash: world.rulesetHash,
      payloadVersion: 1,
      visibility: "public",
      payload: {
        seasonNumber: world.seasonNumber,
        playerCount: rankedPlayers.length,
        allianceCount: rankedAlliances.length,
      },
      occurredAt: cutoffAt,
    })
    .execute();
  await transaction
    .updateTable("worlds")
    .set({ state: "archived", archivedAt: finalizedAt })
    .where("id", "=", world.id)
    .where("state", "=", "finalizing")
    .executeTakeFirstOrThrow();
  return {
    worldId: world.id,
    playerCount: rankedPlayers.length,
    allianceCount: rankedAlliances.length,
  };
}

async function claimDueWorld(transaction: Transaction<Database>, now: Date) {
  return transaction
    .selectFrom("worlds")
    .selectAll()
    .where("state", "in", ["active", "finalizing"])
    .where("endsAt", "<=", now)
    .orderBy("endsAt")
    .orderBy("id")
    .limit(1)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
}

/** Claims and atomically finalizes up to batchSize worlds. Competing workers skip claimed worlds. */
export async function finalizeDueWorlds(
  database: ServerDatabase,
  now = new Date(),
  batchSize = 1,
): Promise<readonly FinalizedWorld[]> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("season finalization batch size must be a positive integer");
  }
  const finalized: FinalizedWorld[] = [];
  for (let index = 0; index < batchSize; index += 1) {
    const result = await database.transaction().execute(async (transaction) => {
      const world = await claimDueWorld(transaction, now);
      return world === undefined ? undefined : finalizeClaimedWorld(transaction, world, now);
    });
    if (result === undefined) break;
    finalized.push(result);
  }
  return finalized;
}

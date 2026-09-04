import { createHash } from "node:crypto";
import type {
  ActionReceipt,
  EventSummary,
  LookResponse,
  PlayerStatus,
  PlayerSummary,
  StructureKind,
  StructureView,
  TileView,
  Resources as WireResources,
  WorldSummary,
} from "@agentworld/api-contract";
import type { Database, Json } from "@agentworld/db";
import {
  type AllianceId,
  assertValidRuleset,
  type CivilizationState,
  coordinate,
  coordinateKey,
  createStarterStructures,
  createStartingCivilization,
  createWorldDescriptor,
  type Direction,
  type DomainEvent,
  decide,
  type GameCommand,
  type GameSnapshot,
  type HostilityState,
  inventoryTotal,
  look,
  playerId,
  projectPlayerAt,
  type ResourceKind,
  type Ruleset,
  resources,
  type StructureState,
  type StructureType,
  scorePlayer,
  settlePassiveProduction,
  starterPlotForSlot,
  structureId,
  type Tick,
  tick,
  tileAt,
  trustTierAt,
  type ViolationCode,
  type WorldDescriptor,
  worldId,
} from "@agentworld/game-rules";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { v7 as uuidv7 } from "uuid";
import type { AppConfig } from "./config.ts";
import { HttpProblem } from "./problem.ts";
import { runSerializable } from "./transaction.ts";

type Db = Kysely<Database> | Transaction<Database>;

interface LoadedGame {
  readonly dbWorld: Awaited<ReturnType<GameService["requireWorld"]>>;
  readonly ruleset: Ruleset;
  readonly descriptor: WorldDescriptor;
  readonly snapshot: GameSnapshot;
  readonly names: ReadonlyMap<string, string>;
  readonly civilizationIds: ReadonlyMap<string, string>;
  readonly playerInfluences: ReadonlyMap<string, number>;
}

export interface MutationInput {
  readonly userId: string;
  readonly worldId: string;
  readonly idempotencyKey: string;
  readonly actionType: string;
  readonly body: unknown;
  readonly command: (actorId: string, generatedId: string) => GameCommand;
}

const structureToWire: Readonly<Record<StructureType, StructureKind>> = {
  "command-node": "command_node",
  generator: "generator",
  extractor: "extractor",
  "compute-node": "compute_node",
  "defense-node": "defense_node",
};

const wireToStructure: Readonly<Record<StructureKind, StructureType>> = {
  command_node: "command-node",
  generator: "generator",
  extractor: "extractor",
  compute_node: "compute-node",
  defense_node: "defense-node",
};

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function requestHash(actionType: string, body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ actionType, body: stableValue(body) }))
    .digest("hex");
}

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function untrusted(content: string) {
  return { content, trust: "untrusted_player_input" as const };
}

async function nextAggregateVersion(
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

type TickRate = Pick<Ruleset, "ticksPerSecond">;

/** Clamp an instant into the season window and convert it to the whole tick it falls in. */
function tickAt(startsAt: Date | string, endsAt: Date | string, rate: TickRate, now: Date): Tick {
  const start = date(startsAt).getTime();
  const end = date(endsAt).getTime();
  const captured = Math.min(Math.max(now.getTime(), start), end);
  return tick(Math.floor(((captured - start) * rate.ticksPerSecond) / 1_000));
}

/**
 * Inverse of tickAt. Rounding up keeps tickAt(dateAtTick(t)) === t for every integer rate and is
 * exact whenever a tick spans whole milliseconds, as in beta-v1's one tick per second.
 */
function dateAtTick(startsAt: Date | string, rate: TickRate, value: number): Date {
  return new Date(date(startsAt).getTime() + Math.ceil((value * 1_000) / rate.ticksPerSecond));
}

/** Worlds persist their normalized ruleset; a corrupted row must fail loudly, never fall back. */
function storedRuleset(world: { readonly ruleset: Json }): Ruleset {
  return assertValidRuleset(world.ruleset as unknown as Ruleset);
}

/** One HTTP status per engine violation code; TRUST_REQUIRED matches the requireTrustTier pre-check. */
const violationStatuses: Readonly<Partial<Record<ViolationCode, number>>> = {
  TRUST_REQUIRED: 403,
  PLAYER_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
};

function violationStatus(code: ViolationCode): number {
  return violationStatuses[code] ?? 409;
}

function resourcesWire(value: {
  energy: number;
  materials: number;
  inference: number;
}): WireResources {
  return { energy: value.energy, materials: value.materials, inference: value.inference };
}

function domainStructureKind(value: StructureKind): StructureType {
  return wireToStructure[value];
}

export class GameService {
  public constructor(
    private readonly database: Kysely<Database>,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = uuidv7,
  ) {}

  public async discovery() {
    const [installation, world] = await Promise.all([
      this.database.selectFrom("installations").selectAll().orderBy("createdAt").executeTakeFirst(),
      this.database
        .selectFrom("worlds")
        .select("id")
        .where("state", "=", "active")
        .orderBy("startsAt")
        .executeTakeFirst(),
    ]);
    return {
      installationId: installation?.id ?? "00000000-0000-7000-8000-000000000000",
      name: installation?.name ?? this.config.installationName,
      apiVersions: ["v1"] as const,
      authIssuer:
        this.config.authMode === "better-auth"
          ? `${this.config.baseUrl}/api/auth`
          : this.config.baseUrl,
      registration: this.config.registrationMode,
      ...(world ? { defaultWorldId: world.id } : {}),
      device_authorization_endpoint: `${this.config.baseUrl}/api/auth/device/code`,
      token_endpoint:
        this.config.authMode === "development"
          ? `${this.config.baseUrl}/api/auth/device/token`
          : `${this.config.baseUrl}/api/auth/oauth2/token`,
    };
  }

  public async worlds(): Promise<{ items: WorldSummary[] }> {
    const rows = await this.database
      .selectFrom("worlds")
      .selectAll()
      .where("state", "in", ["scheduled", "active"])
      .orderBy("startsAt")
      .execute();
    return {
      items: rows.map((world) => ({
        id: world.id,
        name: world.name,
        seasonNumber: world.seasonNumber,
        state: world.state,
        startsAt: date(world.startsAt).toISOString(),
        endsAt: date(world.endsAt).toISOString(),
        width: world.width,
        height: world.height,
        rulesetHash: world.rulesetHash,
      })),
    };
  }

  public async spawn(
    userIdValue: string,
    worldIdValue: string,
    nameValue: string,
    idempotencyKey: string,
  ): Promise<PlayerSummary> {
    const name = nameValue.normalize("NFKC").trim();
    if (idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      throw new HttpProblem(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A 1 to 128 character Idempotency-Key is required",
      );
    }
    const hash = requestHash("spawn", { name });
    if (name.length < 2 || name.length > 40) {
      throw new HttpProblem(
        400,
        "INVALID_PLAYER_NAME",
        "Player name must contain 2 to 40 characters",
      );
    }
    // Re-entrant under retry: identifiers are generated per attempt and every write is transactional.
    return runSerializable(this.database, async (transaction) => {
      const world = await this.requireMutableWorld(transaction, worldIdValue);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${userIdValue}:spawn`}, 0))`.execute(
        transaction,
      );
      let civilization = await transaction
        .selectFrom("civilizations")
        .selectAll()
        .where("userId", "=", userIdValue)
        .executeTakeFirst();
      if (civilization?.suspendedAt) {
        throw new HttpProblem(403, "ACCOUNT_SUSPENDED", "This civilization is suspended");
      }
      const existing = civilization
        ? await transaction
            .selectFrom("players")
            .selectAll()
            .where("worldId", "=", world.id)
            .where("civilizationId", "=", civilization.id)
            .executeTakeFirst()
        : undefined;
      if (existing && civilization) {
        const replay = await transaction
          .selectFrom("actions")
          .select(["actionType", "requestHash", "state", "response"])
          .where("worldId", "=", world.id)
          .where("playerId", "=", existing.id)
          .where("idempotencyKey", "=", idempotencyKey)
          .executeTakeFirst();
        if (replay) {
          if (replay.actionType !== "spawn" || replay.requestHash !== hash) {
            throw new HttpProblem(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This idempotency key was used for different input",
            );
          }
          if (replay.state === "completed" && replay.response) {
            return replay.response as PlayerSummary;
          }
          throw new HttpProblem(409, "ACTION_IN_PROGRESS", "Spawn is still processing", true, 1);
        }
        throw new HttpProblem(
          409,
          "PLAYER_ALREADY_EXISTS",
          "This account already has a player in the world",
        );
      }
      if (!civilization) {
        const civilizationId = this.newId();
        civilization = await transaction
          .insertInto("civilizations")
          .values({
            id: civilizationId,
            userId: userIdValue,
            name,
            suspendedAt: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      // Skip plots whose tiles already carry a live or constructing structure so one poisoned
      // plot can never block every later registration; the unique index stays the last defense.
      const plot = await transaction
        .selectFrom("starterPlots")
        .selectAll()
        .where("worldId", "=", world.id)
        .where("playerId", "is", null)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("tiles")
                .innerJoin("structures", "structures.tileId", "tiles.id")
                .select("tiles.id")
                .whereRef("tiles.starterPlotId", "=", "starterPlots.id")
                .where("structures.worldId", "=", world.id)
                .where("structures.status", "in", ["constructing", "active"]),
            ),
          ),
        )
        .orderBy("plotIndex")
        // LIMIT 1 is load-bearing: without it FOR UPDATE locks every free plot in the world, and a
        // concurrent spawn skipping locked rows sees none and reports WORLD_FULL.
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!plot) throw new HttpProblem(409, "WORLD_FULL", "No starter plots remain in this world");

      const ruleset = storedRuleset(world);
      const descriptor = createWorldDescriptor(worldId(world.id), world.seed, ruleset);
      const id = playerId(this.newId());
      const effectiveTick = tickAt(world.startsAt, world.endsAt, ruleset, this.now());
      const starterPlot = starterPlotForSlot(descriptor, plot.plotIndex, ruleset, id);
      const player = createStartingCivilization(
        id,
        starterPlot,
        effectiveTick,
        ruleset.startingResources,
        civilization.trustTier as 0 | 1 | 2,
      );
      const structureIds = {
        commandNode: structureId(this.newId()),
        generator: structureId(this.newId()),
        extractor: structureId(this.newId()),
      };
      const starterStructures = createStarterStructures(
        id,
        starterPlot,
        structureIds,
        effectiveTick,
        ruleset,
      );
      const spawnedSnapshot: GameSnapshot = {
        world: descriptor,
        players: [player],
        structures: starterStructures,
        hostilities: [],
      };
      const initialInfluence = scorePlayer(spawnedSnapshot, id, ruleset).total;
      await transaction
        .insertInto("players")
        .values({
          id,
          worldId: world.id,
          civilizationId: civilization.id,
          name,
          positionX: player.position.x,
          positionY: player.position.y,
          starterPlotId: plot.id,
          allianceId: null,
          influence: initialInfluence,
        })
        .execute();
      const capturedAt = this.now();
      await transaction
        .insertInto("inventories")
        .values({
          playerId: id,
          worldId: world.id,
          boundEnergy: player.inventory.bound.energy,
          boundMaterials: player.inventory.bound.materials,
          boundInference: player.inventory.bound.inference,
          energy: 0,
          materials: 0,
          inference: 0,
          lastSettledAt: capturedAt,
        })
        .execute();
      await transaction
        .updateTable("starterPlots")
        .set({ playerId: id, allocatedAt: capturedAt })
        .where("id", "=", plot.id)
        .execute();
      const tileRows = await transaction
        .selectFrom("tiles")
        .select(["id", "x", "y"])
        .where("worldId", "=", world.id)
        .where(
          sql<boolean>`(${sql.ref("x")}, ${sql.ref("y")}) in (${sql.join(
            starterPlot.tiles.map((tile) => sql`(${tile.x}, ${tile.y})`),
          )})`,
        )
        .execute();
      const tilesByCoordinate = new Map(tileRows.map((tile) => [coordinateKey(tile), tile.id]));
      if (tilesByCoordinate.size !== starterPlot.tiles.length) {
        throw new Error("seeded starter tiles are missing");
      }
      await transaction
        .insertInto("discoveredTiles")
        .values(
          starterPlot.tiles.map((tile) => ({
            worldId: world.id,
            playerId: id,
            tileId: tilesByCoordinate.get(coordinateKey(tile)) as string,
          })),
        )
        .execute();
      try {
        await transaction
          .insertInto("structures")
          .values(
            starterStructures.map((structure) => ({
              id: structure.id,
              worldId: world.id,
              tileId: tilesByCoordinate.get(coordinateKey(structure.coordinate)) as string,
              ownerPlayerId: id,
              kind: structureToWire[structure.type],
              status: structure.status,
              hitPoints: structure.hp,
              maxHitPoints: ruleset.structures[structure.type].maxHp,
              completesAt: null,
              activatedAt: capturedAt,
              destroyedAt: null,
              lastProductionAt: capturedAt,
            })),
          )
          .execute();
      } catch (error) {
        if ((error as { readonly code?: unknown }).code !== "23505") throw error;
        // The plot gained a live structure between selection and insert; a retry is handed a
        // different plot because the selection above now excludes this one.
        throw new HttpProblem(
          409,
          "STARTER_PLOT_UNAVAILABLE",
          "The selected starter plot is occupied; retry to be assigned another plot",
          true,
          1,
        );
      }
      const actionId = this.newId();
      const response = this.playerSummary(
        player,
        civilization.id,
        name,
        effectiveTick,
        ruleset,
        spawnedSnapshot,
      );
      await transaction
        .insertInto("actions")
        .values({
          id: actionId,
          worldId: world.id,
          playerId: id,
          idempotencyKey,
          requestHash: hash,
          actionType: "spawn",
          state: "completed",
          response: json(response),
          completedAt: capturedAt,
        })
        .execute();
      await transaction
        .insertInto("resourceLedger")
        .values({
          id: this.newId(),
          worldId: world.id,
          playerId: id,
          actionId,
          reason: "starter_grant_bound",
          energyDelta: player.inventory.bound.energy,
          materialsDelta: player.inventory.bound.materials,
          inferenceDelta: player.inventory.bound.inference,
        })
        .execute();
      await this.recordPlayerEvent(transaction, world.id, id, actionId, "PLAYER_SPAWNED");
      return response;
    });
  }

  public async status(userIdValue: string, worldIdValue: string): Promise<PlayerStatus> {
    const actor = await this.requireActor(this.database, userIdValue, worldIdValue);
    const loaded = await this.loadGame(this.database, worldIdValue, actor.id);
    const effectiveTick = tickAt(
      loaded.dbWorld.startsAt,
      loaded.dbWorld.endsAt,
      loaded.ruleset,
      this.now(),
    );
    const projected = projectPlayerAt(
      loaded.snapshot,
      playerId(actor.id),
      effectiveTick,
      loaded.ruleset,
    );
    if (!("inventory" in projected)) throw new HttpProblem(404, projected.code, projected.message);
    const projectedSnapshot: GameSnapshot = {
      ...loaded.snapshot,
      players: loaded.snapshot.players.map((player) =>
        player.id === projected.id ? projected : player,
      ),
    };
    const total = inventoryTotal(projected.inventory);
    const cooldownRows = await this.database
      .selectFrom("cooldowns")
      .select(["action", "availableAt"])
      .where("worldId", "=", worldIdValue)
      .where("playerId", "=", actor.id)
      .execute();
    return {
      player: this.playerSummary(
        projected,
        loaded.civilizationIds.get(actor.id) as string,
        loaded.names.get(actor.id) as string,
        effectiveTick,
        loaded.ruleset,
        projectedSnapshot,
      ),
      resources: resourcesWire(total),
      transferable: resourcesWire(projected.inventory.transferable),
      tick: effectiveTick,
      cooldowns: Object.fromEntries(
        cooldownRows
          .filter((row) => date(row.availableAt) > this.now())
          .map((row) => [row.action, date(row.availableAt).toISOString()]),
      ),
      activeConstructions: loaded.snapshot.structures.filter(
        (structure) => structure.ownerId === projected.id && structure.status === "constructing",
      ).length,
    };
  }

  public async inventory(userIdValue: string, worldIdValue: string) {
    const status = await this.status(userIdValue, worldIdValue);
    const actor = await this.requireActor(this.database, userIdValue, worldIdValue);
    const inventory = await this.database
      .selectFrom("inventories")
      .select(["escrowEnergy", "escrowMaterials", "escrowInference"])
      .where("worldId", "=", worldIdValue)
      .where("playerId", "=", actor.id)
      .executeTakeFirstOrThrow();
    const escrowed = {
      energy: inventory.escrowEnergy,
      materials: inventory.escrowMaterials,
      inference: inventory.escrowInference,
    };
    return {
      total: {
        energy: status.resources.energy + escrowed.energy,
        materials: status.resources.materials + escrowed.materials,
        inference: status.resources.inference + escrowed.inference,
      },
      transferable: status.transferable,
      bound: {
        energy: status.resources.energy - status.transferable.energy,
        materials: status.resources.materials - status.transferable.materials,
        inference: status.resources.inference - status.transferable.inference,
      },
      escrowed,
      tick: status.tick,
    };
  }

  public async look(userIdValue: string, worldIdValue: string): Promise<LookResponse> {
    const actor = await this.requireActor(this.database, userIdValue, worldIdValue);
    const loaded = await this.loadGame(this.database, worldIdValue, actor.id);
    const effectiveTick = tickAt(
      loaded.dbWorld.startsAt,
      loaded.dbWorld.endsAt,
      loaded.ruleset,
      this.now(),
    );
    const result = look(loaded.snapshot, playerId(actor.id), loaded.ruleset);
    if (!("tiles" in result)) throw new HttpProblem(404, result.code, result.message);
    const domainActor = loaded.snapshot.players.find((candidate) => candidate.id === actor.id);
    if (!domainActor) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Player not found");
    const visibleKeys = new Set(result.tiles.map((tile) => coordinateKey(tile.coordinate)));
    return {
      origin: result.center,
      radius: loaded.ruleset.look.radius,
      tick: effectiveTick,
      tiles: result.tiles.map((tile) =>
        this.tileView(tile.coordinate, loaded, domainActor, visibleKeys, effectiveTick),
      ),
    };
  }

  public async map(userIdValue: string, worldIdValue: string, cursor?: string, limit = 100) {
    const actor = await this.requireActor(this.database, userIdValue, worldIdValue);
    const loaded = await this.loadGame(this.database, worldIdValue, actor.id);
    const domainActor = loaded.snapshot.players.find((candidate) => candidate.id === actor.id);
    if (!domainActor) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Player not found");
    const offset = cursor
      ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10)
      : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new HttpProblem(400, "INVALID_CURSOR", "Invalid cursor");
    const effectiveTick = tickAt(
      loaded.dbWorld.startsAt,
      loaded.dbWorld.endsAt,
      loaded.ruleset,
      this.now(),
    );
    const all = [...domainActor.discoveredTileKeys].sort((left, right) => {
      const [lx, ly] = left.split(",").map(Number);
      const [rx, ry] = right.split(",").map(Number);
      return (ly ?? 0) - (ry ?? 0) || (lx ?? 0) - (rx ?? 0);
    });
    const keys = all.slice(offset, offset + Math.min(Math.max(limit, 1), 200));
    const currentView = look(loaded.snapshot, playerId(actor.id), loaded.ruleset);
    if (!("tiles" in currentView)) {
      throw new HttpProblem(404, currentView.code, currentView.message);
    }
    const visible = new Set(currentView.tiles.map((tile) => coordinateKey(tile.coordinate)));
    return {
      items: keys.map((key) => {
        const [x, y] = key.split(",").map(Number);
        return this.tileView(
          coordinate(x ?? 0, y ?? 0),
          loaded,
          domainActor,
          visible,
          effectiveTick,
        );
      }),
      ...(offset + keys.length < all.length
        ? { nextCursor: Buffer.from(String(offset + keys.length)).toString("base64url") }
        : {}),
    };
  }

  public async players(userIdValue: string, worldIdValue: string) {
    const actor = await this.requireActor(this.database, userIdValue, worldIdValue);
    const loaded = await this.loadGame(this.database, worldIdValue, actor.id);
    const effectiveTick = tickAt(
      loaded.dbWorld.startsAt,
      loaded.dbWorld.endsAt,
      loaded.ruleset,
      this.now(),
    );
    const visible = look(loaded.snapshot, playerId(actor.id), loaded.ruleset);
    if (!("tiles" in visible)) throw new HttpProblem(404, visible.code, visible.message);
    const visibleKeys = new Set(visible.tiles.map((tile) => coordinateKey(tile.coordinate)));
    return {
      items: loaded.snapshot.players
        .filter(
          (player) => player.id === actor.id || visibleKeys.has(coordinateKey(player.position)),
        )
        .map((player) =>
          this.playerSummary(
            player,
            loaded.civilizationIds.get(player.id) as string,
            loaded.names.get(player.id) as string,
            effectiveTick,
            loaded.ruleset,
            loaded.snapshot,
          ),
        ),
    };
  }

  public async events(userIdValue: string, worldIdValue: string, cursor?: string, limit = 50) {
    const actor = await this.requireActor(this.database, userIdValue, worldIdValue);
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new HttpProblem(400, "INVALID_CURSOR", "Invalid cursor");
    const rows = await this.database
      .selectFrom("events")
      .selectAll()
      .where("worldId", "=", worldIdValue)
      .where("offset", ">", offset)
      .where((expression) =>
        expression.or([
          expression("visibility", "=", "public"),
          expression.and([
            expression("visibility", "=", "player"),
            expression("actorPlayerId", "=", actor.id),
          ]),
          ...(actor.allianceId
            ? [
                expression.and([
                  expression("visibility", "=", "alliance"),
                  expression("aggregateId", "=", actor.allianceId),
                ]),
              ]
            : []),
        ]),
      )
      .orderBy("offset")
      .limit(Math.min(Math.max(limit, 1), 100))
      .execute();
    return {
      items: rows.map(
        (row): EventSummary => ({
          id: row.id,
          offset: row.offset,
          type: row.type,
          tick: row.tick,
          occurredAt: date(row.occurredAt).toISOString(),
          ...(row.actorPlayerId ? { actorPlayerId: row.actorPlayerId } : {}),
          payload: row.payload as Record<string, unknown>,
        }),
      ),
      ...(rows.length === Math.min(Math.max(limit, 1), 100)
        ? { nextCursor: String(rows.at(-1)?.offset ?? offset) }
        : {}),
    };
  }

  public async leaderboard(userIdValue: string, worldIdValue: string) {
    await this.requireActor(this.database, userIdValue, worldIdValue);
    const world = await this.requireWorld(this.database, worldIdValue);
    if (world.state === "archived") {
      const rankings = await this.database
        .selectFrom("seasonPlayerRankings")
        .innerJoin("players", (join) =>
          join
            .onRef("players.id", "=", "seasonPlayerRankings.playerId")
            .onRef("players.worldId", "=", "seasonPlayerRankings.worldId"),
        )
        .select([
          "seasonPlayerRankings.rank",
          "seasonPlayerRankings.playerId",
          "seasonPlayerRankings.allianceId",
          "seasonPlayerRankings.territoryInfluence",
          "seasonPlayerRankings.structureInfluence",
          "seasonPlayerRankings.economyInfluence",
          "seasonPlayerRankings.combatInfluence",
          "seasonPlayerRankings.totalInfluence",
          "players.name",
        ])
        .where("seasonPlayerRankings.worldId", "=", worldIdValue)
        .orderBy("seasonPlayerRankings.rank")
        .execute();
      return {
        items: rankings.map((ranking) => ({
          rank: ranking.rank,
          playerId: ranking.playerId,
          name: untrusted(ranking.name),
          ...(ranking.allianceId === null ? {} : { allianceId: ranking.allianceId }),
          influence: {
            territory: ranking.territoryInfluence,
            structures: ranking.structureInfluence,
            economy: ranking.economyInfluence,
            combat: ranking.combatInfluence,
            total: ranking.totalInfluence,
          },
        })),
      };
    }
    const loaded = await this.loadGame(this.database, worldIdValue);
    return {
      items: loaded.snapshot.players
        .map((player) => ({
          playerId: player.id,
          name: untrusted(loaded.names.get(player.id) ?? "Unknown"),
          allianceId: player.allianceId,
          influence: scorePlayer(loaded.snapshot, player.id, loaded.ruleset),
        }))
        // Same tie-break as season finalization: total descending, then player id ascending.
        .sort(
          (left, right) =>
            right.influence.total - left.influence.total ||
            left.playerId.localeCompare(right.playerId),
        )
        .map((entry, index) => ({ rank: index + 1, ...entry })),
    };
  }

  public async mutate(input: MutationInput): Promise<ActionReceipt> {
    if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
      throw new HttpProblem(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A 1 to 128 character Idempotency-Key is required",
      );
    }
    const hash = requestHash(input.actionType, input.body);
    // Re-entrant under retry: identifiers are generated per attempt and every write is transactional.
    return runSerializable(this.database, async (transaction) => {
      const actor = await this.requireActor(transaction, input.userId, input.worldId, true);
      await this.requireMutableWorld(transaction, input.worldId);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.id}:${input.idempotencyKey}`}, 0))`.execute(
        transaction,
      );
      const replay = await transaction
        .selectFrom("actions")
        .selectAll()
        .where("worldId", "=", input.worldId)
        .where("playerId", "=", actor.id)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (replay) {
        if (replay.requestHash !== hash || replay.actionType !== input.actionType) {
          throw new HttpProblem(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was used for different input",
          );
        }
        if (replay.state === "completed" && replay.response)
          return replay.response as ActionReceipt;
        throw new HttpProblem(
          409,
          "ACTION_IN_PROGRESS",
          "An action with this key is still processing",
          true,
          1,
        );
      }
      const actionId = this.newId();
      await transaction
        .insertInto("actions")
        .values({
          id: actionId,
          worldId: input.worldId,
          playerId: actor.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          actionType: input.actionType,
          state: "processing",
          response: null,
          completedAt: null,
        })
        .execute();
      const loaded = await this.loadGame(transaction, input.worldId, actor.id);
      if (loaded.dbWorld.state !== "active") {
        throw new HttpProblem(409, "WORLD_NOT_ACTIVE", "The world is not active");
      }
      const effectiveTick = tickAt(
        loaded.dbWorld.startsAt,
        loaded.dbWorld.endsAt,
        loaded.ruleset,
        this.now(),
      );
      const generatedId = this.newId();
      const command = input.command(actor.id, generatedId);
      const decision = decide(command, loaded.snapshot, loaded.ruleset, effectiveTick);
      if (!decision.ok) {
        const { violation } = decision;
        throw new HttpProblem(
          violationStatus(violation.code),
          violation.code,
          violation.message,
          violation.code === "COOLDOWN_ACTIVE",
          violation.retryAtTick === undefined
            ? undefined
            : Math.max(
                0,
                Math.ceil((violation.retryAtTick - effectiveTick) / loaded.ruleset.ticksPerSecond),
              ),
        );
      }
      const capturedAt = this.now();
      const persistedEvents = await this.persistDecision(
        transaction,
        loaded,
        decision.state,
        decision.events,
        actor.id,
        actionId,
        effectiveTick,
        capturedAt,
      );
      const resultActor = decision.state.players.find((candidate) => candidate.id === actor.id);
      if (!resultActor) throw new Error("decision removed its actor");
      const total = inventoryTotal(resultActor.inventory);
      const scanEvent = decision.events.find(
        (event): event is Extract<DomainEvent, { type: "AREA_SCANNED" }> =>
          event.type === "AREA_SCANNED",
      );
      const scanResult =
        scanEvent === undefined
          ? undefined
          : {
              origin: scanEvent.center,
              radius: scanEvent.radius,
              tick: effectiveTick,
              tiles: scanEvent.revealedTileKeys.map((key) => {
                const [x, y] = key.split(",").map(Number);
                return this.tileView(
                  coordinate(x ?? 0, y ?? 0),
                  { ...loaded, snapshot: decision.state },
                  resultActor,
                  new Set(scanEvent.revealedTileKeys),
                  effectiveTick,
                );
              }),
            };
      const receipt: ActionReceipt = {
        actionId,
        idempotencyKey: input.idempotencyKey,
        status: decision.completionTick === undefined ? "completed" : "scheduled",
        effectiveTick,
        ...(decision.completionTick === undefined
          ? {}
          : {
              completesAt: dateAtTick(
                loaded.dbWorld.startsAt,
                loaded.ruleset,
                decision.completionTick,
              ).toISOString(),
            }),
        resources: resourcesWire(total),
        ...(scanResult === undefined ? {} : { result: scanResult }),
        events: persistedEvents,
      };
      await transaction
        .updateTable("actions")
        .set({ state: "completed", response: json(receipt), completedAt: capturedAt })
        .where("id", "=", actionId)
        .execute();
      return receipt;
    });
  }

  /**
   * Materialize one player's lazy production inside a caller-owned transaction. Social resource
   * mutations use this before reading transferable balances so every subsystem observes the same
   * authoritative inventory.
   */
  public async settlePlayerProduction(
    transaction: Transaction<Database>,
    actorId: string,
    worldIdValue: string,
    actionId: string,
  ): Promise<void> {
    const capturedAt = this.now();
    const loaded = await this.loadGame(transaction, worldIdValue, actorId);
    const effectiveTick = tickAt(
      loaded.dbWorld.startsAt,
      loaded.dbWorld.endsAt,
      loaded.ruleset,
      capturedAt,
    );
    const settlement = settlePassiveProduction(
      loaded.snapshot,
      playerId(actorId),
      effectiveTick,
      loaded.ruleset,
    );
    if (settlement.state === loaded.snapshot) return;
    await this.persistDecision(
      transaction,
      loaded,
      settlement.state,
      settlement.events,
      actorId,
      actionId,
      effectiveTick,
      capturedAt,
      "passive_production",
    );
  }

  /** Append a privacy-safe event for application-layer mutations outside the rules reducer. */
  public async recordPlayerEvent(
    transaction: Transaction<Database>,
    worldIdValue: string,
    actorId: string,
    actionId: string,
    type: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const world = await this.requireWorld(transaction, worldIdValue);
    const ruleset = storedRuleset(world);
    const aggregateVersion = await nextAggregateVersion(
      transaction,
      world.homeServerId,
      "action",
      actionId,
    );
    await transaction
      .insertInto("events")
      .values({
        id: this.newId(),
        worldId: world.id,
        emittingServerId: world.homeServerId,
        actionId,
        actorPlayerId: actorId,
        type,
        aggregateType: "action",
        aggregateId: actionId,
        aggregateVersion,
        tick: tickAt(world.startsAt, world.endsAt, ruleset, this.now()),
        rulesetHash: world.rulesetHash,
        payloadVersion: 1,
        visibility: "player",
        payload: json(payload),
      })
      .execute();
  }

  public move(userIdValue: string, worldIdValue: string, key: string, direction: Direction) {
    return this.mutate({
      userId: userIdValue,
      worldId: worldIdValue,
      idempotencyKey: key,
      actionType: "move",
      body: { direction },
      command: (actorId) => ({ type: "move", actorId: playerId(actorId), direction }),
    });
  }

  public build(userIdValue: string, worldIdValue: string, key: string, structure: StructureKind) {
    return this.mutate({
      userId: userIdValue,
      worldId: worldIdValue,
      idempotencyKey: key,
      actionType: "build",
      body: { structure },
      command: (actorId, generatedId) => ({
        type: "build",
        actorId: playerId(actorId),
        structureId: structureId(generatedId),
        structureType: domainStructureKind(structure),
      }),
    });
  }

  public harvest(userIdValue: string, worldIdValue: string, key: string, resource?: ResourceKind) {
    return this.mutate({
      userId: userIdValue,
      worldId: worldIdValue,
      idempotencyKey: key,
      actionType: "harvest",
      body: resource ? { resource } : {},
      command: (actorId) => ({
        type: "harvest",
        actorId: playerId(actorId),
        ...(resource ? { resource } : {}),
      }),
    });
  }

  public scan(userIdValue: string, worldIdValue: string, key: string) {
    return this.mutate({
      userId: userIdValue,
      worldId: worldIdValue,
      idempotencyKey: key,
      actionType: "scan",
      body: {},
      command: (actorId) => ({ type: "scan", actorId: playerId(actorId) }),
    });
  }

  public attack(
    userIdValue: string,
    worldIdValue: string,
    key: string,
    targetStructureId: string,
    bonusInference?: number,
  ) {
    return this.mutate({
      userId: userIdValue,
      worldId: worldIdValue,
      idempotencyKey: key,
      actionType: "attack",
      body: { targetStructureId, ...(bonusInference === undefined ? {} : { bonusInference }) },
      command: (actorId) => ({
        type: "attack",
        actorId: playerId(actorId),
        targetStructureId: structureId(targetStructureId),
        ...(bonusInference === undefined ? {} : { bonusInference }),
      }),
    });
  }

  public hostility(
    userIdValue: string,
    worldIdValue: string,
    key: string,
    defenderId: string,
    withdraw: boolean,
  ) {
    return this.mutate({
      userId: userIdValue,
      worldId: worldIdValue,
      idempotencyKey: key,
      actionType: withdraw ? "withdraw-hostility" : "declare-hostility",
      body: { defenderId },
      command: (actorId) => ({
        type: withdraw ? "withdraw-hostility" : "declare-hostility",
        actorId: playerId(actorId),
        defenderId: playerId(defenderId),
      }),
    });
  }

  public async requireWorld(db: Db, id: string) {
    const world = await db.selectFrom("worlds").selectAll().where("id", "=", id).executeTakeFirst();
    if (!world) throw new HttpProblem(404, "WORLD_NOT_FOUND", "World not found");
    return world;
  }

  public async requireMutableWorld(db: Db, id: string) {
    const world = await this.requireWorld(db, id);
    if (world.state !== "active") {
      throw new HttpProblem(409, "WORLD_NOT_ACTIVE", "The world is not active");
    }
    if (this.now().getTime() >= date(world.endsAt).getTime()) {
      // Not retryable: the next season is a different world id, so resending the same request here
      // can never succeed. Clients must rediscover the current world first.
      throw new HttpProblem(
        409,
        "SEASON_TRANSITION",
        "The season cutoff has passed and this world is read-only; rediscover the current world",
      );
    }
    return world;
  }

  public async requireActor(db: Db, userIdValue: string, worldIdValue: string, lock = false) {
    let query = db
      .selectFrom("players")
      .innerJoin("civilizations", "civilizations.id", "players.civilizationId")
      .selectAll("players")
      .select("civilizations.suspendedAt as civilizationSuspendedAt")
      .where("players.worldId", "=", worldIdValue)
      .where("civilizations.userId", "=", userIdValue);
    if (lock) query = query.forUpdate();
    const actor = await query.executeTakeFirst();
    if (!actor) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Spawn in this world first");
    if (actor.civilizationSuspendedAt) {
      throw new HttpProblem(403, "ACCOUNT_SUSPENDED", "This civilization is suspended");
    }
    return actor;
  }

  /**
   * Enforce a trust tier from durable progress. Mutation paths persist a newly earned tier; read
   * paths pass `persist: false` so a GET never writes.
   */
  public async requireTrustTier(
    db: Db,
    actorId: string,
    worldIdValue: string,
    requiredTier: 1 | 2,
    options: { readonly persist: boolean } = { persist: true },
  ): Promise<1 | 2> {
    const [progress, dbWorld] = await Promise.all([
      db
        .selectFrom("players")
        .innerJoin("civilizations", "civilizations.id", "players.civilizationId")
        .select([
          "players.civilizationId",
          "players.spawnedAt",
          "players.successfulMutations",
          "players.completedStructures",
          "players.earnedEnergy",
          "players.earnedMaterials",
          "players.earnedInference",
          "civilizations.trustTier as persistentTrustTier",
          "civilizations.suspendedAt",
        ])
        .where("players.id", "=", actorId)
        .where("players.worldId", "=", worldIdValue)
        .executeTakeFirst(),
      this.requireWorld(db, worldIdValue),
    ]);
    if (!progress) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Player not found");
    if (progress.suspendedAt) {
      throw new HttpProblem(403, "ACCOUNT_SUSPENDED", "This civilization is suspended");
    }
    const ruleset = storedRuleset(dbWorld);
    const effectiveTick = tickAt(dbWorld.startsAt, dbWorld.endsAt, ruleset, this.now());
    const currentTier = trustTierAt(
      {
        joinedAtTick: tickAt(dbWorld.startsAt, dbWorld.endsAt, ruleset, date(progress.spawnedAt)),
        successfulMutations: progress.successfulMutations,
        completedStructures: progress.completedStructures,
        earnedResources: resources(
          progress.earnedEnergy,
          progress.earnedMaterials,
          progress.earnedInference,
        ),
        persistentTrustTier: progress.persistentTrustTier as 0 | 1 | 2,
      },
      effectiveTick,
      ruleset,
    );
    if (currentTier < requiredTier) {
      throw new HttpProblem(
        403,
        "TRUST_REQUIRED",
        `Trust tier ${requiredTier} is required for this action`,
      );
    }
    if (options.persist && currentTier > progress.persistentTrustTier) {
      await db
        .updateTable("civilizations")
        .set({ trustTier: currentTier })
        .where("id", "=", progress.civilizationId)
        .execute();
    }
    return currentTier as 1 | 2;
  }

  public async assertAllianceChangesAllowed(db: Db, worldIdValue: string): Promise<void> {
    const dbWorld = await this.requireMutableWorld(db, worldIdValue);
    const ruleset = storedRuleset(dbWorld);
    const freezeAt =
      date(dbWorld.endsAt).getTime() -
      (ruleset.season.allianceFreezeTicks / ruleset.ticksPerSecond) * 1_000;
    if (this.now().getTime() >= freezeAt) {
      throw new HttpProblem(
        409,
        "ALLIANCE_CHANGES_FROZEN",
        "Alliance membership changes are frozen near the season cutoff",
      );
    }
  }

  private async loadGame(
    db: Db,
    worldIdValue: string,
    discoveryPlayerId?: string,
  ): Promise<LoadedGame> {
    const dbWorld = await this.requireWorld(db, worldIdValue);
    const ruleset = storedRuleset(dbWorld);
    const descriptor = createWorldDescriptor(worldId(dbWorld.id), dbWorld.seed, ruleset);
    const playerRows = await db
      .selectFrom("players")
      .selectAll()
      .where("worldId", "=", dbWorld.id)
      .execute();
    const civilizationRows = await db
      .selectFrom("civilizations")
      .innerJoin("players", "players.civilizationId", "civilizations.id")
      .selectAll("civilizations")
      .where("players.worldId", "=", dbWorld.id)
      .execute();
    const inventoryRows = await db
      .selectFrom("inventories")
      .selectAll()
      .where("worldId", "=", dbWorld.id)
      .execute();
    const plotRows = await db
      .selectFrom("starterPlots")
      .selectAll()
      .where("worldId", "=", dbWorld.id)
      .execute();
    let discoveredQuery = db
      .selectFrom("discoveredTiles")
      .innerJoin("tiles", "tiles.id", "discoveredTiles.tileId")
      .select(["discoveredTiles.playerId", "tiles.x", "tiles.y"])
      .where("discoveredTiles.worldId", "=", dbWorld.id);
    discoveredQuery = discoveryPlayerId
      ? discoveredQuery.where("discoveredTiles.playerId", "=", discoveryPlayerId)
      : discoveredQuery.where(sql<boolean>`false`);
    const discoveredRows = await discoveredQuery.execute();
    const cooldownRows = await db
      .selectFrom("cooldowns")
      .selectAll()
      .where("worldId", "=", dbWorld.id)
      .execute();
    const structureRows = await db
      .selectFrom("structures")
      .innerJoin("tiles", "tiles.id", "structures.tileId")
      .selectAll("structures")
      .select(["tiles.x as tileX", "tiles.y as tileY"])
      .where("structures.worldId", "=", dbWorld.id)
      .execute();
    const hostilityRows = await db
      .selectFrom("hostilities")
      .selectAll()
      .where("worldId", "=", dbWorld.id)
      .execute();
    const combatRows = await db
      .selectFrom("combatAwardWindows")
      .selectAll()
      .where("worldId", "=", dbWorld.id)
      .execute();

    const civilizations = new Map(civilizationRows.map((value) => [value.id, value]));
    const inventories = new Map(inventoryRows.map((value) => [value.playerId, value]));
    const plots = new Map(plotRows.map((value) => [value.id, value]));
    const discoveries = new Map<string, string[]>();
    for (const row of discoveredRows) {
      const current = discoveries.get(row.playerId) ?? [];
      current.push(`${row.x},${row.y}`);
      discoveries.set(row.playerId, current);
    }
    const cooldowns = new Map<string, Record<string, Tick>>();
    for (const row of cooldownRows) {
      const duration = this.cooldownDuration(row.action, ruleset);
      const availableTick = tickAt(
        dbWorld.startsAt,
        dbWorld.endsAt,
        ruleset,
        date(row.availableAt),
      );
      const current = cooldowns.get(row.playerId) ?? {};
      current[row.action] = tick(Math.max(0, availableTick - duration));
      cooldowns.set(row.playerId, current);
    }
    const windows = new Map<string, typeof combatRows>();
    for (const row of combatRows) {
      const current = windows.get(row.playerId) ?? [];
      current.push(row);
      windows.set(row.playerId, current);
    }
    const players: CivilizationState[] = playerRows.map((row) => {
      const civilization = civilizations.get(row.civilizationId);
      const inventory = inventories.get(row.id);
      const plot = plots.get(row.starterPlotId);
      if (!civilization || !inventory || !plot)
        throw new Error(`incomplete player aggregate: ${row.id}`);
      const cooldown = cooldowns.get(row.id) ?? {};
      return {
        id: playerId(row.id),
        position: coordinate(row.positionX, row.positionY),
        homePlot: starterPlotForSlot(descriptor, plot.plotIndex, ruleset).tiles,
        inventory: {
          bound: resources(
            inventory.boundEnergy,
            inventory.boundMaterials,
            inventory.boundInference,
          ),
          transferable: resources(inventory.energy, inventory.materials, inventory.inference),
        },
        discoveredTileKeys: discoveries.get(row.id) ?? [],
        cooldowns: {
          ...(cooldown.move === undefined ? {} : { movedAtTick: cooldown.move }),
          ...(cooldown.scan === undefined ? {} : { scannedAtTick: cooldown.scan }),
          ...(cooldown.harvest === undefined ? {} : { harvestedAtTick: cooldown.harvest }),
          ...(cooldown.attack === undefined ? {} : { attackedAtTick: cooldown.attack }),
        },
        joinedAtTick: tickAt(dbWorld.startsAt, dbWorld.endsAt, ruleset, date(row.spawnedAt)),
        successfulMutations: row.successfulMutations,
        completedStructures: row.completedStructures,
        earnedResources: resources(row.earnedEnergy, row.earnedMaterials, row.earnedInference),
        combatInfluence: row.combatInfluence,
        combatAwardWindows: (windows.get(row.id) ?? []).map((window) => ({
          opponentId: playerId(window.opponentPlayerId),
          startedAtTick: tickAt(dbWorld.startsAt, dbWorld.endsAt, ruleset, date(window.startedAt)),
          influence: window.influence,
        })),
        persistentTrustTier: civilization.trustTier as 0 | 1 | 2,
        ...(row.allianceId ? { allianceId: row.allianceId as AllianceId } : {}),
      };
    });
    const structures: StructureState[] = structureRows.map((row) => ({
      id: structureId(row.id),
      ownerId: playerId(row.ownerPlayerId),
      type: domainStructureKind(row.kind),
      coordinate: coordinate(row.tileX, row.tileY),
      status: row.status,
      hp: row.hitPoints,
      ...(row.completesAt
        ? {
            constructionCompleteTick: tickAt(
              dbWorld.startsAt,
              dbWorld.endsAt,
              ruleset,
              date(row.completesAt),
            ),
          }
        : {}),
      lastProductionTick: tickAt(
        dbWorld.startsAt,
        dbWorld.endsAt,
        ruleset,
        date(row.lastProductionAt),
      ),
      productionRemainderTicks: row.productionRemainderTicks,
    }));
    const hostilities: HostilityState[] = hostilityRows.map((row) => ({
      aggressorId: playerId(row.aggressorPlayerId),
      defenderId: playerId(row.defenderPlayerId),
      declaredAtTick: tickAt(dbWorld.startsAt, dbWorld.endsAt, ruleset, date(row.declaredAt)),
      ...(row.withdrawnAt
        ? {
            withdrawnAtTick: tickAt(
              dbWorld.startsAt,
              dbWorld.endsAt,
              ruleset,
              date(row.withdrawnAt),
            ),
          }
        : {}),
    }));
    return {
      dbWorld,
      ruleset,
      descriptor,
      snapshot: { world: descriptor, players, structures, hostilities },
      names: new Map(playerRows.map((row) => [row.id, row.name])),
      civilizationIds: new Map(playerRows.map((row) => [row.id, row.civilizationId])),
      playerInfluences: new Map(playerRows.map((row) => [row.id, row.influence])),
    };
  }

  private cooldownDuration(action: string, ruleset: Ruleset): number {
    if (action === "move") return ruleset.movement.cooldownTicks;
    if (action === "scan") return ruleset.scan.cooldownTicks;
    if (action === "harvest") return ruleset.harvest.cooldownTicks;
    if (action === "attack") return ruleset.combat.attackCooldownTicks;
    return 0;
  }

  private playerSummary(
    player: CivilizationState,
    civilizationId: string,
    name: string,
    effectiveTick: Tick,
    ruleset: Ruleset,
    snapshot: GameSnapshot,
  ): PlayerSummary {
    return {
      id: player.id,
      civilizationId,
      name: untrusted(name),
      position: player.position,
      trustTier: trustTierAt(player, effectiveTick, ruleset),
      influence: scorePlayer(snapshot, player.id, ruleset).total,
      ...(player.allianceId ? { allianceId: player.allianceId } : {}),
    };
  }

  private structureView(structure: StructureState, loaded: LoadedGame): StructureView {
    return {
      id: structure.id,
      ownerPlayerId: structure.ownerId,
      kind: structureToWire[structure.type],
      status: structure.status,
      hitPoints: structure.hp,
      maxHitPoints: loaded.ruleset.structures[structure.type].maxHp,
      ...(structure.constructionCompleteTick === undefined
        ? {}
        : {
            completesAt: dateAtTick(
              loaded.dbWorld.startsAt,
              loaded.ruleset,
              structure.constructionCompleteTick,
            ).toISOString(),
          }),
    };
  }

  private tileView(
    target: { x: number; y: number },
    loaded: LoadedGame,
    actor: CivilizationState,
    visibleKeys: ReadonlySet<string>,
    effectiveTick: Tick,
  ): TileView {
    const key = coordinateKey(target);
    const tile = tileAt(loaded.descriptor, target, loaded.ruleset);
    const structure = loaded.snapshot.structures.find(
      (candidate) =>
        candidate.status !== "destroyed" && coordinateKey(candidate.coordinate) === key,
    );
    return {
      coordinates: tile.coordinate,
      terrain: tile.terrain,
      zone: tile.zone === "starter" ? "safe" : tile.zone,
      richness: resourcesWire(tile.richness),
      discovered: actor.discoveredTileKeys.includes(key),
      visible: visibleKeys.has(key),
      ...(visibleKeys.has(key) && structure
        ? { structure: this.structureView(structure, loaded) }
        : {}),
      players: visibleKeys.has(key)
        ? loaded.snapshot.players
            .filter((player) => coordinateKey(player.position) === key)
            .map((player) =>
              this.playerSummary(
                player,
                loaded.civilizationIds.get(player.id) as string,
                loaded.names.get(player.id) as string,
                effectiveTick,
                loaded.ruleset,
                loaded.snapshot,
              ),
            )
        : [],
    };
  }

  private async persistDecision(
    transaction: Transaction<Database>,
    loaded: LoadedGame,
    next: GameSnapshot,
    events: readonly DomainEvent[],
    actorId: string,
    actionId: string,
    effectiveTick: Tick,
    capturedAt: Date,
    actorLedgerReason = "game_action",
  ): Promise<EventSummary[]> {
    const player = next.players.find((candidate) => candidate.id === actorId);
    if (!player) throw new Error("decision actor is missing");
    const previousPlayers = new Map(
      loaded.snapshot.players.map((candidate) => [candidate.id, candidate]),
    );
    const affectedAlliances = new Set<string>();
    for (const changedPlayer of next.players) {
      const previous = previousPlayers.get(changedPlayer.id);
      if (!previous) continue;
      const stateChanged = JSON.stringify(previous) !== JSON.stringify(changedPlayer);
      const influence = scorePlayer(next, changedPlayer.id, loaded.ruleset).total;
      const influenceChanged = loaded.playerInfluences.get(changedPlayer.id) !== influence;
      if (!stateChanged && !influenceChanged) continue;
      await transaction
        .updateTable("players")
        .set({
          influence,
          ...(stateChanged
            ? {
                positionX: changedPlayer.position.x,
                positionY: changedPlayer.position.y,
                successfulMutations: changedPlayer.successfulMutations,
                completedStructures: changedPlayer.completedStructures,
                earnedEnergy: changedPlayer.earnedResources.energy,
                earnedMaterials: changedPlayer.earnedResources.materials,
                earnedInference: changedPlayer.earnedResources.inference,
                combatInfluence: changedPlayer.combatInfluence,
                ...(changedPlayer.id === actorId ? { lastSeenAt: capturedAt } : {}),
              }
            : {}),
        })
        .where("id", "=", changedPlayer.id)
        .execute();
      if (influenceChanged && changedPlayer.allianceId) {
        affectedAlliances.add(changedPlayer.allianceId);
      }
      if (!stateChanged) continue;
      await transaction
        .updateTable("inventories")
        .set({
          boundEnergy: changedPlayer.inventory.bound.energy,
          boundMaterials: changedPlayer.inventory.bound.materials,
          boundInference: changedPlayer.inventory.bound.inference,
          energy: changedPlayer.inventory.transferable.energy,
          materials: changedPlayer.inventory.transferable.materials,
          inference: changedPlayer.inventory.transferable.inference,
          lastSettledAt: capturedAt,
          producedEnergy: changedPlayer.earnedResources.energy,
          producedMaterials: changedPlayer.earnedResources.materials,
          producedInference: changedPlayer.earnedResources.inference,
          version: sql`version + 1`,
        })
        .where("playerId", "=", changedPlayer.id)
        .execute();
      const beforeTotal = inventoryTotal(previous.inventory);
      const afterTotal = inventoryTotal(changedPlayer.inventory);
      const delta = {
        energy: afterTotal.energy - beforeTotal.energy,
        materials: afterTotal.materials - beforeTotal.materials,
        inference: afterTotal.inference - beforeTotal.inference,
      };
      if (delta.energy || delta.materials || delta.inference) {
        await transaction
          .insertInto("resourceLedger")
          .values({
            id: this.newId(),
            worldId: loaded.dbWorld.id,
            playerId: changedPlayer.id,
            actionId,
            reason: changedPlayer.id === actorId ? actorLedgerReason : "passive_production",
            energyDelta: delta.energy,
            materialsDelta: delta.materials,
            inferenceDelta: delta.inference,
          })
          .execute();
      }
    }
    // Game actions earn trust too; persist a promotion so social paths and later seasons see it.
    const earnedTier = trustTierAt(player, effectiveTick, loaded.ruleset);
    if (earnedTier > player.persistentTrustTier) {
      const civilizationId = loaded.civilizationIds.get(actorId);
      if (civilizationId === undefined) throw new Error("decision actor has no civilization");
      await transaction
        .updateTable("civilizations")
        .set({ trustTier: earnedTier })
        .where("id", "=", civilizationId)
        .where("trustTier", "<", earnedTier)
        .execute();
    }
    for (const allianceId of affectedAlliances) {
      const members = await transaction
        .selectFrom("players")
        .select("influence")
        .where("worldId", "=", loaded.dbWorld.id)
        .where("allianceId", "=", allianceId)
        .execute();
      const influence = members.reduce((sum, member) => sum + member.influence, 0);
      if (!Number.isSafeInteger(influence)) throw new RangeError("alliance influence overflow");
      await transaction
        .updateTable("alliances")
        .set({ influence })
        .where("worldId", "=", loaded.dbWorld.id)
        .where("id", "=", allianceId)
        .execute();
    }

    const cooldownEntries: Array<readonly [string, Tick | undefined]> = [
      ["move", player.cooldowns.movedAtTick],
      ["scan", player.cooldowns.scannedAtTick],
      ["harvest", player.cooldowns.harvestedAtTick],
      ["attack", player.cooldowns.attackedAtTick],
    ];
    for (const [action, lastTick] of cooldownEntries) {
      if (lastTick === undefined) continue;
      await transaction
        .insertInto("cooldowns")
        .values({
          worldId: loaded.dbWorld.id,
          playerId: actorId,
          action,
          availableAt: dateAtTick(
            loaded.dbWorld.startsAt,
            loaded.ruleset,
            lastTick + this.cooldownDuration(action, loaded.ruleset),
          ),
        })
        .onConflict((conflict) =>
          conflict.columns(["worldId", "playerId", "action"]).doUpdateSet((excluded) => ({
            availableAt: excluded.ref("excluded.availableAt"),
          })),
        )
        .execute();
    }

    const originalActor = loaded.snapshot.players.find((candidate) => candidate.id === actorId);
    const originalDiscovery = new Set(originalActor?.discoveredTileKeys ?? []);
    const addedKeys = player.discoveredTileKeys.filter((key) => !originalDiscovery.has(key));
    if (addedKeys.length > 0) {
      const values = addedKeys.map((key) => {
        const [x, y] = key.split(",").map(Number);
        return sql`(${x}, ${y})`;
      });
      const discoveredTiles = await transaction
        .selectFrom("tiles")
        .select("id")
        .where("worldId", "=", loaded.dbWorld.id)
        .where(sql<boolean>`(${sql.ref("x")}, ${sql.ref("y")}) in (${sql.join(values)})`)
        .execute();
      if (discoveredTiles.length > 0) {
        await transaction
          .insertInto("discoveredTiles")
          .values(
            discoveredTiles.map((tile) => ({
              worldId: loaded.dbWorld.id,
              playerId: actorId,
              tileId: tile.id,
            })),
          )
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      }
    }

    const beforeStructures = new Map(
      loaded.snapshot.structures.map((structure) => [structure.id, structure]),
    );
    for (const structure of next.structures) {
      const before = beforeStructures.get(structure.id);
      if (before && JSON.stringify(before) === JSON.stringify(structure)) continue;
      const tile = await transaction
        .selectFrom("tiles")
        .select("id")
        .where("worldId", "=", loaded.dbWorld.id)
        .where("x", "=", structure.coordinate.x)
        .where("y", "=", structure.coordinate.y)
        .executeTakeFirstOrThrow();
      const completesAt =
        structure.constructionCompleteTick === undefined
          ? null
          : dateAtTick(loaded.dbWorld.startsAt, loaded.ruleset, structure.constructionCompleteTick);
      if (!before) {
        await transaction
          .insertInto("structures")
          .values({
            id: structure.id,
            worldId: loaded.dbWorld.id,
            tileId: tile.id,
            ownerPlayerId: structure.ownerId,
            kind: structureToWire[structure.type],
            status: structure.status,
            hitPoints: structure.hp,
            maxHitPoints: loaded.ruleset.structures[structure.type].maxHp,
            completesAt,
            activatedAt: structure.status === "active" ? capturedAt : null,
            destroyedAt: structure.status === "destroyed" ? capturedAt : null,
            lastProductionAt: dateAtTick(
              loaded.dbWorld.startsAt,
              loaded.ruleset,
              structure.lastProductionTick,
            ),
            productionRemainderTicks: structure.productionRemainderTicks,
          })
          .execute();
      } else {
        await transaction
          .updateTable("structures")
          .set({
            status: structure.status,
            hitPoints: structure.hp,
            completesAt,
            activatedAt:
              before.status !== "active" && structure.status === "active" ? capturedAt : undefined,
            destroyedAt:
              before.status !== "destroyed" && structure.status === "destroyed"
                ? capturedAt
                : undefined,
            lastProductionAt: dateAtTick(
              loaded.dbWorld.startsAt,
              loaded.ruleset,
              structure.lastProductionTick,
            ),
            productionRemainderTicks: structure.productionRemainderTicks,
            version: sql`version + 1`,
          })
          .where("id", "=", structure.id)
          .execute();
      }
    }

    // Only new or changed pairs are written: rewriting every hostility in the world on every action
    // turned unrelated concurrent mutations into serialization conflicts.
    const previousHostilities = new Map(
      loaded.snapshot.hostilities.map((hostility) => [
        `${hostility.aggressorId}:${hostility.defenderId}`,
        hostility,
      ]),
    );
    for (const hostility of next.hostilities) {
      const before = previousHostilities.get(`${hostility.aggressorId}:${hostility.defenderId}`);
      if (
        before !== undefined &&
        before.declaredAtTick === hostility.declaredAtTick &&
        before.withdrawnAtTick === hostility.withdrawnAtTick
      ) {
        continue;
      }
      await transaction
        .insertInto("hostilities")
        .values({
          worldId: loaded.dbWorld.id,
          aggressorPlayerId: hostility.aggressorId,
          defenderPlayerId: hostility.defenderId,
          declaredAt: dateAtTick(loaded.dbWorld.startsAt, loaded.ruleset, hostility.declaredAtTick),
          activeAt: dateAtTick(
            loaded.dbWorld.startsAt,
            loaded.ruleset,
            hostility.declaredAtTick + loaded.ruleset.combat.hostilityWarmupTicks,
          ),
          withdrawnAt:
            hostility.withdrawnAtTick === undefined
              ? null
              : dateAtTick(loaded.dbWorld.startsAt, loaded.ruleset, hostility.withdrawnAtTick),
          retaliationEndsAt:
            hostility.withdrawnAtTick === undefined
              ? null
              : dateAtTick(
                  loaded.dbWorld.startsAt,
                  loaded.ruleset,
                  hostility.withdrawnAtTick + loaded.ruleset.combat.retaliationAfterWithdrawalTicks,
                ),
        })
        .onConflict((conflict) =>
          conflict
            .columns(["worldId", "aggressorPlayerId", "defenderPlayerId"])
            .doUpdateSet((excluded) => ({
              declaredAt: excluded.ref("excluded.declaredAt"),
              activeAt: excluded.ref("excluded.activeAt"),
              withdrawnAt: excluded.ref("excluded.withdrawnAt"),
              retaliationEndsAt: excluded.ref("excluded.retaliationEndsAt"),
            })),
        )
        .execute();
    }
    for (const window of player.combatAwardWindows) {
      await transaction
        .insertInto("combatAwardWindows")
        .values({
          worldId: loaded.dbWorld.id,
          playerId: actorId,
          opponentPlayerId: window.opponentId,
          startedAt: dateAtTick(loaded.dbWorld.startsAt, loaded.ruleset, window.startedAtTick),
          influence: window.influence,
        })
        .onConflict((conflict) =>
          conflict.columns(["worldId", "playerId", "opponentPlayerId"]).doUpdateSet((excluded) => ({
            startedAt: excluded.ref("excluded.startedAt"),
            influence: excluded.ref("excluded.influence"),
          })),
        )
        .execute();
    }
    const summaries: EventSummary[] = [];
    for (const event of events) {
      const { actorId: eventActorId, tick: eventTick, type, ...payload } = event;
      const eventId = this.newId();
      const aggregateId =
        "structureId" in event
          ? event.structureId
          : "targetStructureId" in event
            ? event.targetStructureId
            : eventActorId;
      const aggregateType =
        "structureId" in event || "targetStructureId" in event ? "structure" : "player";
      const aggregateVersion = await nextAggregateVersion(
        transaction,
        loaded.dbWorld.homeServerId,
        aggregateType,
        aggregateId,
      );
      const inserted = await transaction
        .insertInto("events")
        .values({
          id: eventId,
          worldId: loaded.dbWorld.id,
          emittingServerId: loaded.dbWorld.homeServerId,
          actionId,
          actorPlayerId: eventActorId,
          type,
          aggregateType,
          aggregateId,
          aggregateVersion,
          tick: eventTick,
          rulesetHash: loaded.dbWorld.rulesetHash,
          payloadVersion: 1,
          visibility: "player",
          payload: json(payload),
        })
        .returning(["offset", "occurredAt"])
        .executeTakeFirstOrThrow();
      if (eventActorId === actorId) {
        summaries.push({
          id: eventId,
          offset: inserted.offset,
          type,
          tick: eventTick,
          occurredAt: date(inserted.occurredAt).toISOString(),
          actorPlayerId: eventActorId,
          payload: payload as Record<string, unknown>,
        });
      }
    }
    return summaries;
  }
}

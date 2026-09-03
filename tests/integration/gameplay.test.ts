import { randomUUID } from "node:crypto";
import { createDatabase } from "@agentworld/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { buildApp } from "../../apps/server/src/app.ts";
import { createAuthRuntime } from "../../apps/server/src/auth.ts";
import { type AppConfig, readConfig } from "../../apps/server/src/config.ts";
import { runMigrations } from "../../apps/server/src/migrate.ts";
import { finalizeDueWorlds } from "../../apps/server/src/season-finalization.ts";
import { seedBetaWorld } from "../../apps/server/src/seed.ts";
import { completeDueConstructions, expireDueTrades } from "../../apps/server/src/worker.ts";

const authorization = { authorization: `Bearer dev:integration-${randomUUID()}` };
const rivalAuthorization = { authorization: `Bearer dev:integration-rival-${randomUUID()}` };
let database: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let worldId = "";
let primaryPlayerId = "";

beforeAll(async () => {
  // Vite reserves BASE_URL and normalizes it to "/" inside the test process.
  config = readConfig({ ...process.env, BASE_URL: "http://127.0.0.1:3556" });
  await runMigrations(config);
  worldId = (await seedBetaWorld(config)).worldId;
  database = createDatabase(config.databaseUrl);
  app = await buildApp({
    config,
    database,
    auth: createAuthRuntime(config),
    logger: false,
    serveAuthWeb: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
});

describe("authoritative API vertical slice", () => {
  it("reports liveness, readiness, and installation metadata", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("agentworld_http_requests_total");
    const discovery = await app.inject({ method: "GET", url: "/.well-known/agentworld" });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      defaultWorldId: worldId,
      apiVersions: ["v1"],
      device_authorization_endpoint: "http://127.0.0.1:3556/api/auth/device/code",
      token_endpoint: "http://127.0.0.1:3556/api/auth/device/token",
    });
  });

  it("requires a scoped bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/worlds" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("spawns, builds, replays idempotently, scans, and exposes state", async () => {
    const spawnKey = randomUUID();
    const spawn = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...authorization, "idempotency-key": spawnKey },
      payload: { name: "Integration Array" },
    });
    expect(spawn.statusCode).toBe(201);
    expect(spawn.json()).toMatchObject({ name: { content: "Integration Array" }, influence: 25 });
    primaryPlayerId = spawn.json().id as string;
    const originalSpawn = spawn.json();

    const spawnReplay = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...authorization, "idempotency-key": spawnKey },
      payload: { name: "Integration Array" },
    });
    expect(spawnReplay.statusCode).toBe(201);
    expect(spawnReplay.json()).toEqual(originalSpawn);
    const mismatchedSpawn = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...authorization, "idempotency-key": spawnKey },
      payload: { name: "Different Array" },
    });
    expect(mismatchedSpawn.statusCode).toBe(409);
    expect(mismatchedSpawn.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const duplicateSpawn = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { name: "Integration Array" },
    });
    expect(duplicateSpawn.statusCode).toBe(409);
    expect(duplicateSpawn.json()).toMatchObject({ code: "PLAYER_ALREADY_EXISTS" });

    const tierZeroMessage = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/messages`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { recipientPlayerId: primaryPlayerId, body: "hello" },
    });
    expect(tierZeroMessage.statusCode).toBe(403);
    expect(tierZeroMessage.json()).toMatchObject({ code: "TRUST_REQUIRED" });

    const buildKey = randomUUID();
    const buildRequest = {
      method: "POST" as const,
      url: `/v1/worlds/${worldId}/actions/build`,
      headers: { ...authorization, "idempotency-key": buildKey },
      payload: { structure: "compute_node" },
    };
    const built = await app.inject(buildRequest);
    expect(built.statusCode).toBe(200);
    expect(built.json()).toMatchObject({ status: "scheduled", idempotencyKey: buildKey });
    const replay = await app.inject(buildRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().actionId).toBe(built.json().actionId);

    const reused = await app.inject({
      ...buildRequest,
      payload: { structure: "defense_node" },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const direction = originalSpawn.position.x < 191 ? "east" : "west";
    const moved = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/actions/move`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { direction },
    });
    expect(moved.statusCode).toBe(200);
    const spawnReplayAfterMutation = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...authorization, "idempotency-key": spawnKey },
      payload: { name: "Integration Array" },
    });
    expect(spawnReplayAfterMutation.json()).toEqual(originalSpawn);

    const scan = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/actions/scan`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().result).toMatchObject({ radius: 3 });
    expect(scan.json().result.tiles.length).toBeGreaterThan(10);

    const [status, visible, events] = await Promise.all([
      app.inject({ method: "GET", url: `/v1/worlds/${worldId}/me/status`, headers: authorization }),
      app.inject({ method: "GET", url: `/v1/worlds/${worldId}/look`, headers: authorization }),
      app.inject({ method: "GET", url: `/v1/worlds/${worldId}/events`, headers: authorization }),
    ]);
    expect(status.statusCode).toBe(200);
    expect(status.json().activeConstructions).toBe(1);
    expect(visible.json().tiles.length).toBeGreaterThan(1);
    expect(events.json().items.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["PLAYER_SPAWNED", "CONSTRUCTION_STARTED"]),
    );
  });

  it("preserves fog of war and defender production during combat", async () => {
    const rivalSpawn = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...rivalAuthorization, "idempotency-key": randomUUID() },
      payload: { name: "Rival Matrix" },
    });
    expect(rivalSpawn.statusCode).toBe(201);
    const rivalPlayerId = rivalSpawn.json().id as string;
    await database
      .updateTable("players")
      .set({ positionX: 191, positionY: 191 })
      .where("id", "=", rivalPlayerId)
      .execute();

    const playersBeforeContact = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/players`,
      headers: authorization,
    });
    expect(playersBeforeContact.statusCode).toBe(200);
    expect(
      playersBeforeContact
        .json()
        .items.some((player: { id: string }) => player.id === rivalPlayerId),
    ).toBe(false);
    const rememberedMap = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/map?limit=200`,
      headers: authorization,
    });
    expect(rememberedMap.statusCode).toBe(200);
    const hiddenTiles = rememberedMap
      .json()
      .items.filter((tile: { visible: boolean }) => !tile.visible);
    expect(hiddenTiles.length).toBeGreaterThan(0);
    expect(
      hiddenTiles.every(
        (tile: { structure?: unknown; players: unknown[] }) =>
          tile.structure === undefined && tile.players.length === 0,
      ),
    ).toBe(true);

    const playerRows = await database
      .selectFrom("players")
      .select(["id", "civilizationId"])
      .where("id", "in", [primaryPlayerId, rivalPlayerId])
      .execute();
    await database
      .updateTable("civilizations")
      .set({ trustTier: 2 })
      .where(
        "id",
        "in",
        playerRows.map((player) => player.civilizationId),
      )
      .execute();

    const targetTile = await database
      .selectFrom("tiles")
      .leftJoin("structures", (join) =>
        join.onRef("structures.tileId", "=", "tiles.id").on("structures.status", "!=", "destroyed"),
      )
      .select(["tiles.id", "tiles.x", "tiles.y"])
      .where("tiles.worldId", "=", worldId)
      .where("tiles.zone", "in", ["contested", "frontier"])
      .where("tiles.x", ">", 0)
      .where("structures.id", "is", null)
      .orderBy("tiles.y")
      .orderBy("tiles.x")
      .executeTakeFirstOrThrow();
    const capturedAt = new Date();
    const startsAt = new Date(capturedAt.getTime() - 1_200_000);
    await database
      .updateTable("worlds")
      .set({ startsAt, endsAt: new Date(capturedAt.getTime() + 2_400_000_000) })
      .where("id", "=", worldId)
      .execute();
    await database
      .updateTable("players")
      .set({ positionX: targetTile.x - 1, positionY: targetTile.y })
      .where("id", "=", primaryPlayerId)
      .execute();
    const targetStructureId = randomUUID();
    await database
      .insertInto("structures")
      .values({
        id: targetStructureId,
        worldId,
        tileId: targetTile.id,
        ownerPlayerId: rivalPlayerId,
        kind: "generator",
        status: "active",
        hitPoints: 100,
        maxHitPoints: 100,
        completesAt: null,
        activatedAt: startsAt,
        destroyedAt: null,
        lastProductionAt: startsAt,
      })
      .execute();
    await database
      .insertInto("hostilities")
      .values({
        worldId,
        aggressorPlayerId: primaryPlayerId,
        defenderPlayerId: rivalPlayerId,
        declaredAt: startsAt,
        activeAt: new Date(startsAt.getTime() + 900_000),
        withdrawnAt: null,
        retaliationEndsAt: null,
      })
      .execute();
    const defenderBefore = await database
      .selectFrom("inventories")
      .select(["boundEnergy", "energy"])
      .where("playerId", "=", rivalPlayerId)
      .executeTakeFirstOrThrow();
    const attack = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/actions/attack`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { targetStructureId, bonusInference: 0 },
    });
    expect(attack.statusCode).toBe(200);
    expect(
      attack
        .json()
        .events.every(
          (event: { actorPlayerId?: string }) => event.actorPlayerId === primaryPlayerId,
        ),
    ).toBe(true);
    const defenderAfter = await database
      .selectFrom("inventories")
      .select(["boundEnergy", "energy"])
      .where("playerId", "=", rivalPlayerId)
      .executeTakeFirstOrThrow();
    expect(defenderAfter.boundEnergy + defenderAfter.energy).toBeGreaterThan(
      defenderBefore.boundEnergy + defenderBefore.energy,
    );
    const productionLedger = await database
      .selectFrom("resourceLedger")
      .select("id")
      .where("playerId", "=", rivalPlayerId)
      .where("reason", "=", "passive_production")
      .executeTakeFirst();
    expect(productionLedger).toBeDefined();
  });

  it("allows gifts and refunds expired trade escrow exactly once", async () => {
    await database
      .updateTable("inventories")
      .set((expression) => ({ energy: expression("energy", "+", 10) }))
      .where("playerId", "=", primaryPlayerId)
      .execute();
    const rival = await database
      .selectFrom("players")
      .select("id")
      .where("worldId", "=", worldId)
      .where("id", "!=", primaryPlayerId)
      .orderBy("spawnedAt", "desc")
      .executeTakeFirstOrThrow();
    const offer = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/trades`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: {
        recipientPlayerId: rival.id,
        offered: { energy: 5, materials: 0, inference: 0 },
        requested: { energy: 0, materials: 0, inference: 0 },
      },
    });
    expect(offer.statusCode).toBe(200);
    expect(offer.json()).toMatchObject({ state: "open" });
    const tradeId = offer.json().id as string;
    const escrowed = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/me/inventory`,
      headers: authorization,
    });
    expect(escrowed.statusCode).toBe(200);
    expect(escrowed.json().escrowed.energy).toBe(5);
    expect(escrowed.json().total.energy).toBe(
      escrowed.json().bound.energy +
        escrowed.json().transferable.energy +
        escrowed.json().escrowed.energy,
    );
    await database
      .updateTable("trades")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", tradeId)
      .execute();
    expect(await expireDueTrades(database, new Date())).toBe(1);
    expect(await expireDueTrades(database, new Date())).toBe(0);
    const [trade, inventory, ledger] = await Promise.all([
      database
        .selectFrom("trades")
        .select("state")
        .where("id", "=", tradeId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("inventories")
        .select(["energy", "escrowEnergy"])
        .where("playerId", "=", primaryPlayerId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("resourceLedger")
        .select("id")
        .where("playerId", "=", primaryPlayerId)
        .where("reason", "=", "trade_expired")
        .executeTakeFirst(),
    ]);
    expect(trade.state).toBe("expired");
    expect(inventory.escrowEnergy).toBe(0);
    expect(inventory.energy).toBeGreaterThanOrEqual(10);
    expect(ledger).toBeDefined();
  });

  it("enforces append-only events and economic ledgers in PostgreSQL", async () => {
    const event = await database
      .selectFrom("events")
      .select("id")
      .where("worldId", "=", worldId)
      .executeTakeFirstOrThrow();
    const ledger = await database
      .selectFrom("resourceLedger")
      .select("id")
      .where("worldId", "=", worldId)
      .executeTakeFirstOrThrow();

    await expect(
      database.updateTable("events").set({ type: "TAMPERED" }).where("id", "=", event.id).execute(),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.deleteFrom("resourceLedger").where("id", "=", ledger.id).execute(),
    ).rejects.toMatchObject({ code: "55000" });
    const duplicateVersions = await sql<{ count: string }>`
      select count(*)::text as count
      from (
        select emitting_server_id, aggregate_type, aggregate_id, aggregate_version
        from events
        group by emitting_server_id, aggregate_type, aggregate_id, aggregate_version
        having count(*) > 1
      ) duplicates
    `.execute(database);
    expect(duplicateVersions.rows[0]?.count).toBe("0");
  });

  it("atomically finalizes a due season once across competing workers", async () => {
    const rival = await database
      .selectFrom("players")
      .select("id")
      .where("worldId", "=", worldId)
      .where("id", "!=", primaryPlayerId)
      .executeTakeFirstOrThrow();
    const tradeId = randomUUID();
    await database
      .updateTable("inventories")
      .set((expression) => ({
        energy: expression("energy", "-", 3),
        escrowEnergy: expression("escrowEnergy", "+", 3),
      }))
      .where("playerId", "=", primaryPlayerId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("trades")
      .values({
        id: tradeId,
        worldId,
        senderPlayerId: primaryPlayerId,
        recipientPlayerId: rival.id,
        offered: { energy: 3, materials: 0, inference: 0 },
        requested: { energy: 0, materials: 0, inference: 0 },
        state: "open",
        expiresAt: new Date(Date.now() + 86_400_000),
        resolvedAt: null,
      })
      .execute();
    const cutoffAt = new Date(Date.now() + 60_000);
    const finalizationNow = new Date(cutoffAt.getTime() + 1_000);
    await database
      .updateTable("worlds")
      .set({ endsAt: cutoffAt })
      .where("id", "=", worldId)
      .execute();
    await completeDueConstructions(database, finalizationNow);

    const [left, right] = await Promise.all([
      finalizeDueWorlds(database, finalizationNow, 1),
      finalizeDueWorlds(database, finalizationNow, 1),
    ]);
    expect(left.length + right.length).toBe(1);
    expect(await finalizeDueWorlds(database, finalizationNow, 1)).toEqual([]);

    const [world, trade, inventory, finalization, players, rankings, unsettled, postCutoff] =
      await Promise.all([
        database
          .selectFrom("worlds")
          .selectAll()
          .where("id", "=", worldId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom("trades")
          .selectAll()
          .where("id", "=", tradeId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom("inventories")
          .select(["energy", "escrowEnergy"])
          .where("playerId", "=", primaryPlayerId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom("seasonFinalizations")
          .selectAll()
          .where("worldId", "=", worldId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom("players")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("worldId", "=", worldId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom("seasonPlayerRankings")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("worldId", "=", worldId)
          .executeTakeFirstOrThrow(),
        database
          .selectFrom("structures")
          .select("id")
          .where("worldId", "=", worldId)
          .where("status", "=", "constructing")
          .where("completesAt", "<=", cutoffAt)
          .execute(),
        database
          .selectFrom("structures")
          .select("id")
          .where("worldId", "=", worldId)
          .where("status", "=", "constructing")
          .where("completesAt", ">", cutoffAt)
          .execute(),
      ]);
    expect(world.state).toBe("archived");
    expect(trade.state).toBe("expired");
    expect(inventory.escrowEnergy).toBe(0);
    expect(finalization.cutoffAt).toEqual(cutoffAt);
    expect(rankings.count).toBe(players.count);
    expect(unsettled).toEqual([]);
    expect(postCutoff.length).toBeGreaterThan(0);

    const leaderboard = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/leaderboard`,
      headers: authorization,
    });
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.json().items).toHaveLength(rankings.count);
    await expect(
      database
        .updateTable("seasonPlayerRankings")
        .set({ scoreReachedAt: new Date() })
        .where("worldId", "=", worldId)
        .execute(),
    ).rejects.toThrow(/immutable/);

    const nextSeason = await seedBetaWorld(config);
    expect(nextSeason.worldId).not.toBe(worldId);
    expect((await seedBetaWorld(config)).worldId).toBe(nextSeason.worldId);
    const current = await database
      .selectFrom("worlds")
      .select(["id", "seasonNumber", "seed"])
      .where("id", "=", nextSeason.worldId)
      .executeTakeFirstOrThrow();
    expect(current.seasonNumber).toBe(world.seasonNumber + 1);
    expect(current.seed).toMatch(/^[a-f0-9]{64}$/);
    expect(current.seed).not.toContain(current.id);
  });
});

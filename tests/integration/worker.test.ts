import { randomUUID } from "node:crypto";
import { createDatabase } from "@agentworld/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.ts";
import { createAuthRuntime } from "../../apps/server/src/auth.ts";
import { type AppConfig, readConfig } from "../../apps/server/src/config.ts";
import { runMigrations } from "../../apps/server/src/migrate.ts";
import { finalizeDueWorlds } from "../../apps/server/src/season-finalization.ts";
import { seedBetaWorld } from "../../apps/server/src/seed.ts";
import {
  completeDueConstructions,
  expireDueTrades,
  type SkippedRow,
} from "../../apps/server/src/worker.ts";

const authorization = { authorization: `Bearer dev:worker-${randomUUID()}` };
const partnerAuthorization = { authorization: `Bearer dev:worker-partner-${randomUUID()}` };
let database: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let worldId = "";
let playerId = "";
let partnerPlayerId = "";
let spawnX = 0;

async function duplicateVersionCount(): Promise<string> {
  const duplicates = await sql<{ count: string }>`
    select count(*)::text as count
    from (
      select emitting_server_id, aggregate_type, aggregate_id, aggregate_version
      from events
      group by emitting_server_id, aggregate_type, aggregate_id, aggregate_version
      having count(*) > 1
    ) duplicates
  `.execute(database);
  return duplicates.rows[0]?.count ?? "missing";
}

function aggregateEvents(aggregateType: string, aggregateId: string) {
  return database
    .selectFrom("events")
    .select(["type", "aggregateVersion"])
    .where("worldId", "=", worldId)
    .where("aggregateType", "=", aggregateType)
    .where("aggregateId", "=", aggregateId)
    .orderBy("aggregateVersion")
    .execute();
}

beforeAll(async () => {
  // Vite reserves BASE_URL and normalizes it to "/" inside the test process.
  config = readConfig({ ...process.env, BASE_URL: "http://127.0.0.1:3557" });
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

describe("durable worker on API-created rows", () => {
  it("completes an API-built structure with a journal-allocated event version", async () => {
    const spawn = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { name: "Worker Array" },
    });
    expect(spawn.statusCode).toBe(201);
    playerId = spawn.json().id as string;
    spawnX = spawn.json().position.x as number;
    const partnerSpawn = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/players`,
      headers: { ...partnerAuthorization, "idempotency-key": randomUUID() },
      payload: { name: "Worker Partner" },
    });
    expect(partnerSpawn.statusCode).toBe(201);
    partnerPlayerId = partnerSpawn.json().id as string;

    const built = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/actions/build`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { structure: "generator" },
    });
    expect(built.statusCode).toBe(200);
    expect(built.json()).toMatchObject({ status: "scheduled" });

    const structure = await database
      .selectFrom("structures")
      .select(["id", "version", "maxHitPoints"])
      .where("worldId", "=", worldId)
      .where("ownerPlayerId", "=", playerId)
      .where("status", "=", "constructing")
      .executeTakeFirstOrThrow();
    // The API left the row at its initial version while its journal already holds version 1.
    expect(structure.version).toBe(0);
    expect(await aggregateEvents("structure", structure.id)).toEqual([
      { type: "CONSTRUCTION_STARTED", aggregateVersion: 1 },
    ]);
    const ownerBefore = await database
      .selectFrom("players")
      .select("completedStructures")
      .where("id", "=", playerId)
      .executeTakeFirstOrThrow();

    const completesAt = new Date(Date.now() - 60_000);
    await database
      .updateTable("structures")
      .set({ completesAt })
      .where("id", "=", structure.id)
      .execute();
    const now = new Date();
    expect(await completeDueConstructions(database, now)).toBe(1);

    const [after, ownerAfter, events] = await Promise.all([
      database
        .selectFrom("structures")
        .select([
          "status",
          "hitPoints",
          "maxHitPoints",
          "activatedAt",
          "lastProductionAt",
          "version",
        ])
        .where("id", "=", structure.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("players")
        .select("completedStructures")
        .where("id", "=", playerId)
        .executeTakeFirstOrThrow(),
      aggregateEvents("structure", structure.id),
    ]);
    expect(after).toEqual({
      status: "active",
      hitPoints: structure.maxHitPoints,
      maxHitPoints: structure.maxHitPoints,
      activatedAt: completesAt,
      lastProductionAt: completesAt,
      version: 1,
    });
    expect(ownerAfter.completedStructures).toBe(ownerBefore.completedStructures + 1);
    expect(events).toEqual([
      { type: "CONSTRUCTION_STARTED", aggregateVersion: 1 },
      { type: "CONSTRUCTION_COMPLETED", aggregateVersion: 2 },
    ]);
    expect(await completeDueConstructions(database, now)).toBe(0);
    expect(await duplicateVersionCount()).toBe("0");
  });

  it("skips a poison trade row, still refunds its neighbour, and rejects negative escrow", async () => {
    const before = await database
      .selectFrom("inventories")
      .select(["energy", "escrowEnergy"])
      .where("playerId", "=", playerId)
      .executeTakeFirstOrThrow();
    // Fund the sender and escrow 4 energy for the healthy offer, as the API would have.
    await database
      .updateTable("inventories")
      .set((expression) => ({
        energy: expression("energy", "+", 6),
        escrowEnergy: expression("escrowEnergy", "+", 4),
      }))
      .where("worldId", "=", worldId)
      .where("playerId", "=", playerId)
      .execute();
    const now = new Date();
    const poisonTradeId = randomUUID();
    const healthyTradeId = randomUUID();
    const trade = {
      worldId,
      senderPlayerId: playerId,
      recipientPlayerId: partnerPlayerId,
      requested: { energy: 0, materials: 0, inference: 0 },
      state: "open" as const,
      resolvedAt: null,
    };
    await database
      .insertInto("trades")
      .values([
        {
          ...trade,
          id: poisonTradeId,
          offered: { energy: -5, materials: 0, inference: 0 },
          expiresAt: new Date(now.getTime() - 2_000),
        },
        {
          ...trade,
          id: healthyTradeId,
          offered: { energy: 4, materials: 0, inference: 0 },
          expiresAt: new Date(now.getTime() - 1_000),
        },
      ])
      .execute();

    const skipped: SkippedRow[] = [];
    expect(
      await expireDueTrades(database, now, 100, (row) => {
        skipped.push(row);
      }),
    ).toBe(1);
    expect(skipped.map((row) => [row.job, row.id])).toEqual([["trade-expiry", poisonTradeId]]);
    expect(skipped[0]?.error).toBeInstanceOf(Error);
    expect(skipped[0]?.error).toMatchObject({
      message: expect.stringMatching(/invalid offered resource vector/),
    });

    const [poison, healthy, inventory, ledger] = await Promise.all([
      database
        .selectFrom("trades")
        .select(["state", "resolvedAt"])
        .where("id", "=", poisonTradeId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("trades")
        .select(["state", "resolvedAt"])
        .where("id", "=", healthyTradeId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("inventories")
        .select(["energy", "escrowEnergy"])
        .where("playerId", "=", playerId)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("resourceLedger")
        .select(["energyDelta"])
        .where("playerId", "=", playerId)
        .where("reason", "=", "trade_expired")
        .execute(),
    ]);
    expect(poison).toEqual({ state: "open", resolvedAt: null });
    expect(healthy).toEqual({ state: "expired", resolvedAt: now });
    expect(inventory).toEqual({ energy: before.energy + 10, escrowEnergy: before.escrowEnergy });
    expect(ledger).toEqual([{ energyDelta: 4 }]);

    // Without a skip handler the failure surfaces to the caller and nothing moves.
    await expect(expireDueTrades(database, now)).rejects.toThrow(/invalid offered resource vector/);
    expect(
      await database
        .selectFrom("inventories")
        .select(["energy", "escrowEnergy"])
        .where("playerId", "=", playerId)
        .executeTakeFirstOrThrow(),
    ).toEqual(inventory);
    // Retire the poison offer so finalization below sees consistent escrow.
    await database
      .updateTable("trades")
      .set({ state: "cancelled", resolvedAt: now })
      .where("id", "=", poisonTradeId)
      .execute();
  });

  it("finalizes a world whose players already own player-aggregate events", async () => {
    const moved = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/actions/move`,
      headers: { ...authorization, "idempotency-key": randomUUID() },
      payload: { direction: spawnX < 191 ? "east" : "west" },
    });
    expect(moved.statusCode).toBe(200);
    const playerEventsBefore = await aggregateEvents("player", playerId);
    expect(playerEventsBefore.length).toBeGreaterThan(0);
    const highestBefore = Math.max(...playerEventsBefore.map((event) => event.aggregateVersion));

    // Owe the producers two hours of settlement and move the cutoff into the past.
    const world = await database
      .selectFrom("worlds")
      .select("startsAt")
      .where("id", "=", worldId)
      .executeTakeFirstOrThrow();
    const capturedAt = new Date();
    const cutoffAt = new Date(capturedAt.getTime() - 1_000);
    await database
      .updateTable("worlds")
      .set({ startsAt: new Date(new Date(world.startsAt).getTime() - 7_200_000), endsAt: cutoffAt })
      .where("id", "=", worldId)
      .execute();
    await database
      .updateTable("structures")
      .set({ lastProductionAt: sql`last_production_at - interval '2 hours'` })
      .where("worldId", "=", worldId)
      .where("status", "=", "active")
      .execute();

    const finalized = await finalizeDueWorlds(database, capturedAt, 1);
    expect(finalized.map((entry) => entry.worldId)).toEqual([worldId]);
    expect(await finalizeDueWorlds(database, capturedAt, 1)).toEqual([]);

    const [archived, players, rankings, produced, seasonEvents] = await Promise.all([
      database
        .selectFrom("worlds")
        .select(["state", "archivedAt"])
        .where("id", "=", worldId)
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
        .selectFrom("events")
        .select("aggregateVersion")
        .where("worldId", "=", worldId)
        .where("type", "=", "RESOURCES_PRODUCED")
        .where("aggregateType", "=", "player")
        .where("aggregateId", "=", playerId)
        .execute(),
      aggregateEvents("world", worldId),
    ]);
    expect(archived.state).toBe("archived");
    expect(archived.archivedAt).toEqual(capturedAt);
    expect(finalized[0]?.playerCount).toBe(players.count);
    expect(rankings.count).toBe(players.count);
    expect(produced).toHaveLength(1);
    expect(produced[0]?.aggregateVersion).toBe(highestBefore + 1);
    expect(seasonEvents).toEqual([{ type: "SEASON_FINALIZED", aggregateVersion: 1 }]);
    expect(await duplicateVersionCount()).toBe("0");
  });
});

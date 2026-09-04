import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "@agentworld/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.ts";
import { createAuthRuntime } from "../../apps/server/src/auth.ts";
import { type AppConfig, readConfig } from "../../apps/server/src/config.ts";
import { runMigrations } from "../../apps/server/src/migrate.ts";
import { seedBetaWorld } from "../../apps/server/src/seed.ts";

/** beta-v1 runs one tick per second with movement.cooldownTicks = 2; a little slack covers tick edges. */
const MOVE_COOLDOWN_MS = 2_100;

const alpha = { authorization: `Bearer dev:concurrency-alpha-${randomUUID()}` };
const beta = { authorization: `Bearer dev:concurrency-beta-${randomUUID()}` };
let database: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let worldId = "";
let alphaPlayerId = "";
let betaPlayerId = "";
let alphaPosition = { x: 0, y: 0 };
let betaPosition = { x: 0, y: 0 };

/** Starter plots sit in the outer band of a 192x192 map, so heading for the centre never leaves it. */
function towardCentre(position: { readonly x: number }): "east" | "west" {
  return position.x < 96 ? "east" : "west";
}

function stepTowardCentre(position: { readonly x: number; readonly y: number }) {
  return { ...position, x: position.x + (position.x < 96 ? 1 : -1) };
}

function spawn(headers: Record<string, string>, name: string) {
  return app.inject({
    method: "POST",
    url: `/v1/worlds/${worldId}/players`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { name },
  });
}

function move(headers: Record<string, string>, direction: string, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/v1/worlds/${worldId}/actions/move`,
    headers: { ...headers, "idempotency-key": key },
    payload: { direction },
  });
}

async function persistedTrustTier(playerId: string): Promise<number> {
  const row = await database
    .selectFrom("players")
    .innerJoin("civilizations", "civilizations.id", "players.civilizationId")
    .select("civilizations.trustTier")
    .where("players.id", "=", playerId)
    .executeTakeFirstOrThrow();
  return row.trustTier;
}

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
  // A test-only route that fails the way PostgreSQL does once the in-process retry is exhausted.
  app.get("/__test/serialization-failure", async () => {
    throw Object.assign(new Error("could not serialize access due to read/write dependencies"), {
      code: "40001",
    });
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
});

describe("concurrent mutations and transport guarantees", () => {
  it("spawns two players concurrently and stamps x-request-id on success and not-found", async () => {
    // Concurrent registrations on a fresh world must both receive a plot; the loser of the plot
    // race may only ever see a retryable problem, never WORLD_FULL or a 500.
    const [alphaSpawn, betaSpawn] = await Promise.all([
      spawn(alpha, "Alpha Lattice"),
      spawn(beta, "Beta Lattice"),
    ]);
    expect(alphaSpawn.json()).toMatchObject({ id: expect.any(String) });
    expect(betaSpawn.json()).toMatchObject({ id: expect.any(String) });
    expect(alphaSpawn.statusCode).toBe(201);
    expect(betaSpawn.statusCode).toBe(201);
    expect(alphaSpawn.headers["x-request-id"]).toEqual(expect.any(String));
    alphaPlayerId = alphaSpawn.json().id as string;
    betaPlayerId = betaSpawn.json().id as string;
    alphaPosition = alphaSpawn.json().position;
    betaPosition = betaSpawn.json().position;
    expect(alphaPlayerId).not.toBe(betaPlayerId);

    const status = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/me/status`,
      headers: { ...alpha, "x-request-id": "concurrency-probe-1" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers["x-request-id"]).toBe("concurrency-probe-1");

    const missing = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/does-not-exist`,
      headers: alpha,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND", requestId: expect.any(String) });
    expect(missing.headers["x-request-id"]).toBe(missing.json().requestId);
  });

  it("commits simultaneous moves by two players in every round", async () => {
    for (let round = 0; round < 5; round += 1) {
      if (round > 0) await delay(MOVE_COOLDOWN_MS);
      const [alphaMove, betaMove] = await Promise.all([
        move(alpha, towardCentre(alphaPosition)),
        move(beta, towardCentre(betaPosition)),
      ]);
      expect([alphaMove.statusCode, betaMove.statusCode]).toEqual([200, 200]);
      expect(alphaMove.json()).toMatchObject({ status: "completed" });
      expect(betaMove.json()).toMatchObject({ status: "completed" });
      alphaPosition = stepTowardCentre(alphaPosition);
      betaPosition = stepTowardCentre(betaPosition);
    }

    const tooSoon = await move(alpha, towardCentre(alphaPosition));
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json()).toMatchObject({
      code: "COOLDOWN_ACTIVE",
      retryable: true,
      retryAfter: expect.any(Number),
    });
    expect(tooSoon.headers["retry-after"]).toBe(String(tooSoon.json().retryAfter));
  });

  it("converges concurrent identical requests on one stored receipt", async () => {
    await delay(MOVE_COOLDOWN_MS);
    const key = randomUUID();
    const direction = towardCentre(alphaPosition);
    const [first, second] = await Promise.all([
      move(alpha, direction, key),
      move(alpha, direction, key),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.json().actionId).toBe(second.json().actionId);
    expect(first.json()).toEqual(second.json());
    alphaPosition = stepTowardCentre(alphaPosition);

    const stored = await database
      .selectFrom("actions")
      .select(["id", "state"])
      .where("worldId", "=", worldId)
      .where("playerId", "=", alphaPlayerId)
      .where("idempotencyKey", "=", key)
      .execute();
    expect(stored).toEqual([{ id: first.json().actionId, state: "completed" }]);
  });

  it("reports engine trust violations as 403 TRUST_REQUIRED", async () => {
    const hostility = await app.inject({
      method: "PUT",
      url: `/v1/worlds/${worldId}/relationships/${betaPlayerId}/hostility`,
      headers: { ...alpha, "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(hostility.statusCode).toBe(403);
    expect(hostility.json()).toMatchObject({ code: "TRUST_REQUIRED", retryable: false });
  });

  it("maps an exhausted serialization retry to a retryable 409 with Retry-After", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/serialization-failure" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "CONCURRENT_MODIFICATION",
      retryable: true,
      retryAfter: 1,
    });
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("honors the message page limit and keeps the read path side-effect free", async () => {
    const alphaCivilization = await database
      .selectFrom("players")
      .select("civilizationId")
      .where("id", "=", alphaPlayerId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("civilizations")
      .set({ trustTier: 1 })
      .where("id", "=", alphaCivilization.civilizationId)
      .execute();
    for (const body of ["first dispatch", "second dispatch"]) {
      const sent = await app.inject({
        method: "POST",
        url: `/v1/worlds/${worldId}/messages`,
        headers: { ...alpha, "idempotency-key": randomUUID() },
        payload: { recipientPlayerId: betaPlayerId, body },
      });
      expect(sent.statusCode).toBe(200);
    }

    const firstPage = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/messages?limit=1`,
      headers: alpha,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(1);
    expect(firstPage.json().items[0].body.content).toBe("second dispatch");
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));

    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/messages?limit=1&cursor=${encodeURIComponent(
        firstPage.json().nextCursor as string,
      )}`,
      headers: alpha,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().items[0].body.content).toBe("first dispatch");

    const fullPage = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/messages`,
      headers: alpha,
    });
    expect(fullPage.json().items).toHaveLength(2);
    expect(fullPage.json().nextCursor).toBeUndefined();
    const invalidLimit = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/messages?limit=0`,
      headers: alpha,
    });
    expect(invalidLimit.statusCode).toBe(400);

    // Beta has earned Tier 1 through progress but nothing has persisted it yet; reading messages
    // must pass the tier check without writing the promotion.
    await database
      .updateTable("players")
      .set({ successfulMutations: 5, completedStructures: 1 })
      .where("id", "=", betaPlayerId)
      .execute();
    expect(await persistedTrustTier(betaPlayerId)).toBe(0);
    const inbox = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/messages`,
      headers: beta,
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().items).toHaveLength(2);
    expect(await persistedTrustTier(betaPlayerId)).toBe(0);
  });

  it("persists trust earned through a game action", async () => {
    await delay(MOVE_COOLDOWN_MS);
    const moved = await move(beta, towardCentre(betaPosition));
    expect(moved.statusCode).toBe(200);
    betaPosition = stepTowardCentre(betaPosition);
    expect(await persistedTrustTier(betaPlayerId)).toBe(1);
  });

  it("skips a starter plot whose tile already carries a live structure", async () => {
    const poisonedPlot = await database
      .selectFrom("starterPlots")
      .select(["id", "plotIndex"])
      .where("worldId", "=", worldId)
      .where("playerId", "is", null)
      .orderBy("plotIndex")
      .executeTakeFirstOrThrow();
    const tile = await database
      .selectFrom("tiles")
      .select("id")
      .where("worldId", "=", worldId)
      .where("starterPlotId", "=", poisonedPlot.id)
      .orderBy("y")
      .orderBy("x")
      .executeTakeFirstOrThrow();
    const now = new Date();
    await database
      .insertInto("structures")
      .values({
        id: randomUUID(),
        worldId,
        tileId: tile.id,
        ownerPlayerId: alphaPlayerId,
        kind: "generator",
        status: "active",
        hitPoints: 100,
        maxHitPoints: 100,
        completesAt: null,
        activatedAt: now,
        destroyedAt: null,
        lastProductionAt: now,
      })
      .execute();

    const gamma = { authorization: `Bearer dev:concurrency-gamma-${randomUUID()}` };
    const gammaSpawn = await spawn(gamma, "Gamma Lattice");
    expect(gammaSpawn.json()).toMatchObject({ id: expect.any(String) });
    expect(gammaSpawn.statusCode).toBe(201);
    const gammaPlayer = await database
      .selectFrom("players")
      .select("starterPlotId")
      .where("id", "=", gammaSpawn.json().id as string)
      .executeTakeFirstOrThrow();
    expect(gammaPlayer.starterPlotId).not.toBe(poisonedPlot.id);
    const skipped = await database
      .selectFrom("starterPlots")
      .select("playerId")
      .where("id", "=", poisonedPlot.id)
      .executeTakeFirstOrThrow();
    expect(skipped.playerId).toBeNull();
  });

  it("rejects actions after the season cutoff without inviting a retry", async () => {
    const world = await database
      .selectFrom("worlds")
      .select("endsAt")
      .where("id", "=", worldId)
      .executeTakeFirstOrThrow();
    try {
      await database
        .updateTable("worlds")
        .set({ endsAt: new Date(Date.now() - 1_000) })
        .where("id", "=", worldId)
        .execute();
      const closed = await move(alpha, towardCentre(alphaPosition));
      expect(closed.statusCode).toBe(409);
      expect(closed.json()).toMatchObject({ code: "SEASON_TRANSITION", retryable: false });
      expect(closed.json().retryAfter).toBeUndefined();
      expect(closed.headers["retry-after"]).toBeUndefined();
    } finally {
      await database
        .updateTable("worlds")
        .set({ endsAt: world.endsAt })
        .where("id", "=", worldId)
        .execute();
    }
  });
});

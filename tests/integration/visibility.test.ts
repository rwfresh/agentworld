import { randomUUID } from "node:crypto";
import { createDatabase } from "@agentworld/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.ts";
import { createAuthRuntime } from "../../apps/server/src/auth.ts";
import { type AppConfig, readConfig } from "../../apps/server/src/config.ts";
import { runMigrations } from "../../apps/server/src/migrate.ts";
import { seedBetaWorld } from "../../apps/server/src/seed.ts";

/** beta-v1 runs one tick per second; the hostility warmup and retaliation windows are both 900 ticks. */
const WINDOW_MS = 900_000;

const aggressor = { authorization: `Bearer dev:visibility-aggressor-${randomUUID()}` };
const defender = { authorization: `Bearer dev:visibility-defender-${randomUUID()}` };
const bystander = { authorization: `Bearer dev:visibility-bystander-${randomUUID()}` };
let database: ReturnType<typeof createDatabase>;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let worldId = "";
let aggressorId = "";
let defenderId = "";
let bystanderId = "";
let seasonStart = new Date();
let targetStructureId = "";

interface FeedEvent {
  readonly type: string;
  readonly actorPlayerId?: string;
  readonly targetPlayerId?: string;
  readonly payload: Record<string, unknown>;
}

interface Relationship {
  readonly aggressorPlayerId: string;
  readonly defenderPlayerId: string;
  readonly declaredAt: string;
  readonly attacksAllowedAt: string;
  readonly withdrawnAt?: string;
  readonly retaliationEndsAt?: string;
  readonly role: string;
  readonly state: string;
}

async function spawn(headers: Record<string, string>, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/worlds/${worldId}/players`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function feed(headers: Record<string, string>): Promise<FeedEvent[]> {
  const response = await app.inject({
    method: "GET",
    url: `/v1/worlds/${worldId}/events?limit=100`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json().items as FeedEvent[];
}

async function relationships(headers: Record<string, string>): Promise<Relationship[]> {
  const response = await app.inject({
    method: "GET",
    url: `/v1/worlds/${worldId}/relationships`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json().items as Relationship[];
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

/** Events a player may see are their own or done to them; anything else is a leak. */
function assertPrivate(events: readonly FeedEvent[], playerId: string): void {
  for (const event of events) {
    expect(
      event.actorPlayerId === playerId || event.targetPlayerId === playerId,
      `${event.type} leaked into ${playerId}'s feed`,
    ).toBe(true);
  }
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
  await app.ready();

  // Start the season twenty minutes ago so a declaration moved to the season start is past its
  // warmup, and end it far enough out that alliance changes are not frozen.
  const now = new Date();
  seasonStart = new Date(now.getTime() - 1_200_000);
  await database
    .updateTable("worlds")
    .set({ startsAt: seasonStart, endsAt: new Date(now.getTime() + 2_400_000_000) })
    .where("id", "=", worldId)
    .execute();
  aggressorId = await spawn(aggressor, "Visibility Aggressor");
  defenderId = await spawn(defender, "Visibility Defender");
  bystanderId = await spawn(bystander, "Visibility Bystander");
  const tierTwo = await database
    .selectFrom("players")
    .select("civilizationId")
    .where("id", "in", [aggressorId, defenderId])
    .execute();
  await database
    .updateTable("civilizations")
    .set({ trustTier: 2 })
    .where(
      "id",
      "in",
      tierTwo.map((player) => player.civilizationId),
    )
    .execute();
});

afterAll(async () => {
  await app?.close();
  await database?.destroy();
});

describe("event and relationship visibility", () => {
  it("delivers a hostility declaration to its defender and to nobody else", async () => {
    const declared = await app.inject({
      method: "PUT",
      url: `/v1/worlds/${worldId}/relationships/${defenderId}/hostility`,
      headers: { ...aggressor, "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(declared.statusCode).toBe(200);
    expect(declared.json().events).toEqual([
      expect.objectContaining({
        type: "HOSTILITY_DECLARED",
        actorPlayerId: aggressorId,
        targetPlayerId: defenderId,
      }),
    ]);

    const defenderFeed = await feed(defender);
    const declaration = defenderFeed.find((event) => event.type === "HOSTILITY_DECLARED");
    expect(declaration).toMatchObject({
      actorPlayerId: aggressorId,
      targetPlayerId: defenderId,
      payload: { defenderId, attacksAllowedAtTick: expect.any(Number) },
    });
    assertPrivate(defenderFeed, defenderId);

    const aggressorFeed = await feed(aggressor);
    expect(aggressorFeed).toContainEqual(
      expect.objectContaining({ type: "HOSTILITY_DECLARED", targetPlayerId: defenderId }),
    );
    assertPrivate(aggressorFeed, aggressorId);

    const bystanderFeed = await feed(bystander);
    expect(bystanderFeed.map((event) => event.type)).not.toContain("HOSTILITY_DECLARED");
    assertPrivate(bystanderFeed, bystanderId);
  });

  it("lists the declaration for both parties with their role and the warmup window", async () => {
    const [asAggressor] = await relationships(aggressor);
    expect(asAggressor).toMatchObject({
      aggressorPlayerId: aggressorId,
      defenderPlayerId: defenderId,
      role: "aggressor",
      state: "warmup",
    });
    if (!asAggressor) throw new Error("aggressor relationship is missing");
    expect(asAggressor.withdrawnAt).toBeUndefined();
    expect(asAggressor.retaliationEndsAt).toBeUndefined();
    expect(new Date(asAggressor.attacksAllowedAt).getTime()).toBe(
      new Date(asAggressor.declaredAt).getTime() + WINDOW_MS,
    );

    const [asDefender] = await relationships(defender);
    expect(asDefender).toEqual({ ...asAggressor, role: "defender" });
    expect(await relationships(bystander)).toEqual([]);
  });

  it("delivers an attack to the structure's owner once the warmup has elapsed", async () => {
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
    await database
      .updateTable("players")
      .set({ positionX: targetTile.x - 1, positionY: targetTile.y })
      .where("id", "=", aggressorId)
      .execute();
    targetStructureId = randomUUID();
    await database
      .insertInto("structures")
      .values({
        id: targetStructureId,
        worldId,
        tileId: targetTile.id,
        ownerPlayerId: defenderId,
        kind: "generator",
        status: "active",
        hitPoints: 100,
        maxHitPoints: 100,
        completesAt: null,
        activatedAt: seasonStart,
        destroyedAt: null,
        lastProductionAt: seasonStart,
      })
      .execute();
    // The engine derives the attack window from the declaration tick, so move the declaration to
    // the season start; the persisted activeAt is kept consistent with it.
    await database
      .updateTable("hostilities")
      .set({ declaredAt: seasonStart, activeAt: new Date(seasonStart.getTime() + WINDOW_MS) })
      .where("worldId", "=", worldId)
      .where("aggressorPlayerId", "=", aggressorId)
      .where("defenderPlayerId", "=", defenderId)
      .execute();
    expect((await relationships(aggressor))[0]).toMatchObject({ state: "active" });
    expect((await relationships(defender))[0]).toMatchObject({
      role: "defender",
      state: "active",
    });

    const attack = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/actions/attack`,
      headers: { ...aggressor, "idempotency-key": randomUUID() },
      payload: { targetStructureId },
    });
    expect(attack.statusCode).toBe(200);
    expect(attack.json().events).toContainEqual(
      expect.objectContaining({
        type: "STRUCTURE_ATTACKED",
        actorPlayerId: aggressorId,
        targetPlayerId: defenderId,
      }),
    );

    const defenderFeed = await feed(defender);
    const struck = defenderFeed.find((event) => event.type === "STRUCTURE_ATTACKED");
    expect(struck).toMatchObject({
      actorPlayerId: aggressorId,
      targetPlayerId: defenderId,
      payload: { targetStructureId, damage: expect.any(Number), remainingHp: expect.any(Number) },
    });
    const damage = struck?.payload.damage as number;
    expect(damage).toBeGreaterThan(0);
    expect(struck?.payload.remainingHp).toBe(100 - damage);
    assertPrivate(defenderFeed, defenderId);

    const bystanderFeed = await feed(bystander);
    expect(bystanderFeed.map((event) => event.type)).not.toContain("STRUCTURE_ATTACKED");
    assertPrivate(bystanderFeed, bystanderId);
  });

  it("reports the retaliation window after a withdrawal and ends it once the window closes", async () => {
    const withdrawn = await app.inject({
      method: "DELETE",
      url: `/v1/worlds/${worldId}/relationships/${defenderId}/hostility`,
      headers: { ...aggressor, "idempotency-key": randomUUID() },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().events).toEqual([
      expect.objectContaining({
        type: "HOSTILITY_WITHDRAWN",
        actorPlayerId: aggressorId,
        targetPlayerId: defenderId,
      }),
    ]);
    expect(await feed(defender)).toContainEqual(
      expect.objectContaining({
        type: "HOSTILITY_WITHDRAWN",
        actorPlayerId: aggressorId,
        targetPlayerId: defenderId,
        payload: expect.objectContaining({ defenderId }),
      }),
    );
    expect((await feed(bystander)).map((event) => event.type)).not.toContain("HOSTILITY_WITHDRAWN");

    const [asDefender] = await relationships(defender);
    expect(asDefender).toMatchObject({ role: "defender", state: "retaliation_window" });
    if (!asDefender?.withdrawnAt || !asDefender.retaliationEndsAt) {
      throw new Error("withdrawal timestamps are missing");
    }
    expect(new Date(asDefender.retaliationEndsAt).getTime()).toBe(
      new Date(asDefender.withdrawnAt).getTime() + WINDOW_MS,
    );
    expect((await relationships(aggressor))[0]).toEqual({ ...asDefender, role: "aggressor" });

    const withdrawnAt = new Date(seasonStart.getTime() + 1_000);
    await database
      .updateTable("hostilities")
      .set({ withdrawnAt, retaliationEndsAt: new Date(withdrawnAt.getTime() + WINDOW_MS) })
      .where("worldId", "=", worldId)
      .where("aggressorPlayerId", "=", aggressorId)
      .where("defenderPlayerId", "=", defenderId)
      .execute();
    expect((await relationships(aggressor))[0]).toMatchObject({ state: "ended" });
    expect((await relationships(defender))[0]).toMatchObject({ state: "ended" });
  });

  it("lists pending alliance invitations to the invitee alone", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/alliances`,
      headers: { ...aggressor, "idempotency-key": randomUUID() },
      payload: { name: "Visibility Accord" },
    });
    expect(created.statusCode).toBe(200);
    const allianceId = created.json().id as string;
    const invited = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/alliances/${allianceId}/invites`,
      headers: { ...aggressor, "idempotency-key": randomUUID() },
      payload: { playerId: bystanderId },
    });
    expect(invited.statusCode).toBe(200);
    const inviteId = invited.json().inviteId as string;

    const pending = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/alliance-invites`,
      headers: bystander,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({
      items: [
        {
          inviteId,
          allianceId,
          allianceName: { content: "Visibility Accord", trust: "untrusted_player_input" },
          invitedByPlayerId: aggressorId,
          expiresAt: invited.json().expiresAt,
        },
      ],
    });
    for (const headers of [aggressor, defender]) {
      const none = await app.inject({
        method: "GET",
        url: `/v1/worlds/${worldId}/alliance-invites`,
        headers,
      });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ items: [] });
    }

    await database
      .updateTable("allianceInvites")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", inviteId)
      .execute();
    const expired = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/alliance-invites`,
      headers: bystander,
    });
    expect(expired.json()).toEqual({ items: [] });
  });

  it("lets a Tier 0 recipient read their inbox while sending still requires Tier 1", async () => {
    expect(await persistedTrustTier(bystanderId)).toBe(0);
    const sent = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/messages`,
      headers: { ...aggressor, "idempotency-key": randomUUID() },
      payload: { recipientPlayerId: bystanderId, body: "welcome to the frontier" },
    });
    expect(sent.statusCode).toBe(200);

    const inbox = await app.inject({
      method: "GET",
      url: `/v1/worlds/${worldId}/messages`,
      headers: bystander,
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().items).toEqual([
      expect.objectContaining({
        senderPlayerId: aggressorId,
        recipientPlayerId: bystanderId,
        body: { content: "welcome to the frontier", trust: "untrusted_player_input" },
      }),
    ]);

    const reply = await app.inject({
      method: "POST",
      url: `/v1/worlds/${worldId}/messages`,
      headers: { ...bystander, "idempotency-key": randomUUID() },
      payload: { recipientPlayerId: aggressorId, body: "thanks" },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json()).toMatchObject({ code: "TRUST_REQUIRED" });
    expect(await persistedTrustTier(bystanderId)).toBe(0);
  });
});

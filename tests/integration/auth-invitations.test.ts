import { randomUUID } from "node:crypto";
import { createDatabase, createPool } from "@agentworld/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistrationGate, reserveInvitation } from "../../apps/server/src/auth.ts";
import { type AppConfig, readConfig } from "../../apps/server/src/config.ts";
import { createInvitation } from "../../apps/server/src/create-invite.ts";
import {
  createEmailDigester,
  type EmailDigester,
  legacyEmailHash,
} from "../../apps/server/src/invitation-code.ts";
import { runMigrations } from "../../apps/server/src/migrate.ts";
import { seedBetaWorld } from "../../apps/server/src/seed.ts";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let config: AppConfig;
let database: ReturnType<typeof createDatabase>;
let pool: ReturnType<typeof createPool>;
let digest: EmailDigester;

function invitation(maxUses: number) {
  return createInvitation(
    { kind: "create", createdBy: "integration-suite", maxUses, expiresInHours: 1, json: false },
    config,
  );
}

async function durableAuthRows(): Promise<string> {
  const [audit, reservations] = await Promise.all([
    database.selectFrom("securityAudit").selectAll().execute(),
    database.selectFrom("invitationReservations").selectAll().execute(),
  ]);
  return JSON.stringify({ audit, reservations });
}

beforeAll(async () => {
  // Vite reserves BASE_URL and normalizes it to "/" inside the test process.
  config = readConfig({ ...process.env, BASE_URL: "http://127.0.0.1:3556" });
  await runMigrations(config);
  database = createDatabase(config.databaseUrl);
  pool = createPool(config.databaseUrl);
  digest = createEmailDigester(config.authSecret);
});

afterAll(async () => {
  await pool?.end();
  await database?.destroy();
});

describe("invitation reservations", () => {
  it("binds an invitation to the keyed email digest and audits the invitation, never the address", async () => {
    const created = await invitation(2);
    const address = `Invitee.${randomUUID()}@Example.test`;
    await reserveInvitation(pool, digest(` ${address} `), created.code);

    const reservation = await database
      .selectFrom("invitationReservations")
      .selectAll()
      .where("invitationId", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(reservation.emailHash).toBe(digest(address).current);
    expect(reservation.emailHash).not.toBe(legacyEmailHash(address));
    expect(reservation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(reservation.expiresAt.getTime() - reservation.reservedAt.getTime()).toBe(86_400_000);

    const audit = await database
      .selectFrom("securityAudit")
      .selectAll()
      .where("action", "=", "invitation_reserved")
      .where("targetId", "=", created.id)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      targetType: "invitation",
      actorUserId: null,
      metadata: { reservationId: reservation.id },
    });

    const persisted = await durableAuthRows();
    expect(persisted.toLowerCase()).not.toContain(address.toLowerCase());
    expect(persisted).not.toContain(created.code);

    // Repeat requests inside the window reuse the reservation instead of consuming another use.
    await reserveInvitation(pool, digest(address.toLowerCase()), created.code);
    const uses = await database
      .selectFrom("invitations")
      .select("uses")
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(uses.uses).toBe(1);
    expect(
      await database
        .selectFrom("invitationReservations")
        .select("id")
        .where("invitationId", "=", created.id)
        .execute(),
    ).toHaveLength(1);
  });

  it("gates user creation on an active reservation, including OAuth sign-ups", async () => {
    const created = await invitation(1);
    const address = `gated-${randomUUID()}@example.test`;
    const gate = createRegistrationGate("invite", pool, digest);
    await expect(gate({ email: address })).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "INVITATION_REQUIRED" },
    });

    await reserveInvitation(pool, digest(address), created.code);
    await expect(gate({ email: address.toUpperCase() })).resolves.toBeUndefined();
    await expect(gate({ email: `stranger-${randomUUID()}@example.test` })).rejects.toMatchObject({
      body: { code: "INVITATION_REQUIRED" },
    });
    await expect(
      createRegistrationGate("closed", pool, digest)({ email: address }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "REGISTRATION_CLOSED" },
    });
    await expect(
      createRegistrationGate("open", pool, digest)({ email: address }),
    ).resolves.toBeUndefined();
  });

  it("rejects unknown and exhausted invitations without consuming a use", async () => {
    const created = await invitation(1);
    await expect(
      reserveInvitation(
        pool,
        digest(`unknown-${randomUUID()}@example.test`),
        "AW-NOT-A-REAL-CODE-2345",
      ),
    ).rejects.toMatchObject({ status: 403, code: "INVITATION_INVALID" });
    await reserveInvitation(pool, digest(`first-${randomUUID()}@example.test`), created.code);
    await expect(
      reserveInvitation(pool, digest(`second-${randomUUID()}@example.test`), created.code),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const row = await database
      .selectFrom("invitations")
      .select("uses")
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(row.uses).toBe(1);
  });

  it("stops honouring a reservation once its window has passed", async () => {
    const created = await invitation(1);
    const address = `expired-${randomUUID()}@example.test`;
    await reserveInvitation(pool, digest(address), created.code);
    await database
      .updateTable("invitationReservations")
      .set({
        reservedAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      .where("invitationId", "=", created.id)
      .execute();
    await expect(
      createRegistrationGate("invite", pool, digest)({ email: address }),
    ).rejects.toMatchObject({
      body: { code: "INVITATION_REQUIRED" },
    });
    // Renewing needs a remaining use; this single-use invitation is exhausted.
    await expect(reserveInvitation(pool, digest(address), created.code)).rejects.toMatchObject({
      code: "INVITATION_INVALID",
    });
  });

  it("honours a legacy unkeyed reservation for lookups while writing only keyed digests", async () => {
    const created = await invitation(1);
    const address = `legacy-${randomUUID()}@example.test`;
    // Migration 007 backfilled live rows with the plain SHA-256 digest; their plaintext is gone.
    await database
      .insertInto("invitationReservations")
      .values({
        id: randomUUID(),
        invitationId: created.id,
        emailHash: legacyEmailHash(address),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const gate = createRegistrationGate("invite", pool, digest);
    await expect(gate({ email: address.toUpperCase() })).resolves.toBeUndefined();

    // A repeat magic-link request reuses the legacy reservation instead of consuming the use.
    await reserveInvitation(pool, digest(address), created.code);
    const [uses, reservations] = await Promise.all([
      database
        .selectFrom("invitations")
        .select("uses")
        .where("id", "=", created.id)
        .executeTakeFirstOrThrow(),
      database
        .selectFrom("invitationReservations")
        .select("emailHash")
        .where("invitationId", "=", created.id)
        .execute(),
    ]);
    expect(uses.uses).toBe(0);
    expect(reservations).toEqual([{ emailHash: legacyEmailHash(address) }]);

    // Once the legacy row lapses, the renewed reservation is written with the keyed digest.
    await database
      .updateTable("invitationReservations")
      .set({
        reservedAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      })
      .where("invitationId", "=", created.id)
      .execute();
    await expect(gate({ email: address })).rejects.toMatchObject({
      body: { code: "INVITATION_REQUIRED" },
    });
    await reserveInvitation(pool, digest(address), created.code);
    const renewed = await database
      .selectFrom("invitationReservations")
      .select("emailHash")
      .where("invitationId", "=", created.id)
      .where("expiresAt", ">", new Date())
      .execute();
    expect(renewed).toEqual([{ emailHash: digest(address).current }]);
    await expect(gate({ email: address })).resolves.toBeUndefined();
  });

  it("stops recognising keyed reservations once AUTH_SECRET rotates", async () => {
    const created = await invitation(1);
    const address = `rotated-${randomUUID()}@example.test`;
    await reserveInvitation(pool, digest(address), created.code);
    await expect(
      createRegistrationGate("invite", pool, digest)({ email: address }),
    ).resolves.toBeUndefined();
    const rotated = createEmailDigester(`${config.authSecret}-rotated`);
    await expect(
      createRegistrationGate("invite", pool, rotated)({ email: address }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "INVITATION_REQUIRED" },
    });
  });
});

describe("append-only journals", () => {
  it("rejects TRUNCATE on events and the resource ledger", async () => {
    await expect(sql`truncate table events`.execute(database)).rejects.toMatchObject({
      code: "55000",
    });
    await expect(sql`truncate table resource_ledger`.execute(database)).rejects.toMatchObject({
      code: "55000",
    });
  });
});

describe("installation identity", () => {
  it("persists one UUIDv7 installation id that survives INSTALLATION_NAME changes", async () => {
    const first = await seedBetaWorld(config);
    const renamed = await seedBetaWorld({
      ...config,
      installationName: `${config.installationName} (renamed)`,
    });
    const restored = await seedBetaWorld(config);

    expect(first.installationId).toMatch(uuidV7);
    expect(renamed.installationId).toBe(first.installationId);
    expect(restored.installationId).toBe(first.installationId);
    expect(renamed.worldId).toBe(first.worldId);
    expect(restored.worldId).toBe(first.worldId);

    const installations = await database.selectFrom("installations").selectAll().execute();
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      id: first.installationId,
      name: config.installationName,
    });
    const currentWorlds = await database
      .selectFrom("worlds")
      .select("id")
      .where("homeServerId", "=", first.installationId)
      .where("state", "in", ["scheduled", "active", "finalizing"])
      .execute();
    expect(currentWorlds).toEqual([{ id: first.worldId }]);
  });
});

import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import {
  canonicalAuthRequestUrl,
  createRegistrationGate,
  findActiveReservation,
  type InvitationConnectionPool,
  type InvitationQueryResult,
  reserveInvitation,
} from "./auth.ts";
import { emailHash, invitationHash } from "./invitation-code.ts";
import { HttpProblem } from "./problem.ts";

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeState {
  readonly activeReservationId?: string;
  readonly invitationId?: string;
  readonly failRollback?: boolean;
}

const email = " Player@Example.test ";
const normalizedEmail = "player@example.test";
const code = "AW-ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789";
const empty: InvitationQueryResult = { rows: [], rowCount: 0 };

function fakePool(state: FakeState) {
  const statements: Statement[] = [];
  const released: (Error | undefined)[] = [];
  let connections = 0;
  const query = async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<InvitationQueryResult> => {
    statements.push({ text, values });
    const normalized = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
    if (normalized === "rollback" && state.failRollback) {
      throw new Error("connection terminated during rollback");
    }
    if (normalized.includes("from public.invitation_reservations")) {
      return state.activeReservationId
        ? { rows: [{ id: state.activeReservationId }], rowCount: 1 }
        : empty;
    }
    if (normalized.startsWith("update public.invitations")) {
      return state.invitationId ? { rows: [{ id: state.invitationId }], rowCount: 1 } : empty;
    }
    if (normalized.startsWith("insert into public.invitation_reservations")) {
      return { rows: [{ id: "reservation-row" }], rowCount: 1 };
    }
    return empty;
  };
  const pool: InvitationConnectionPool = {
    query,
    async connect() {
      connections += 1;
      return {
        query,
        release(error) {
          released.push(error);
        },
      };
    },
  };
  return {
    pool,
    statements,
    released,
    get connections() {
      return connections;
    },
    verbs: () =>
      statements.map((statement) => statement.text.trim().split(/\s+/)[0]?.toLowerCase()),
  };
}

describe("auth request forwarding", () => {
  it("uses the configured public origin and preserves the request path", () => {
    const url = canonicalAuthRequestUrl(
      "https://agentworld.example",
      "/api/auth/get-session?returning=true",
    );
    expect(url.href).toBe("https://agentworld.example/api/auth/get-session?returning=true");
  });

  it("rejects an absolute request target on another origin", () => {
    expect(() =>
      canonicalAuthRequestUrl("https://agentworld.example", "https://attacker.invalid/steal"),
    ).toThrow(/invalid/);
  });
});

describe("reserveInvitation", () => {
  it("consumes one use, stores only the email digest, and audits the invitation rather than the email", async () => {
    const fake = fakePool({ invitationId: "invitation-1" });
    await reserveInvitation(fake.pool, email, code);

    expect(fake.verbs()).toEqual([
      "begin",
      "select",
      "select",
      "update",
      "insert",
      "insert",
      "commit",
    ]);
    const [reservation, audit] = fake.statements.filter((statement) =>
      statement.text.trimStart().startsWith("insert"),
    );
    const expectedDigest = createHash("sha256").update(normalizedEmail).digest("hex");
    expect(emailHash(email)).toBe(expectedDigest);
    expect(reservation?.values.slice(1)).toEqual(["invitation-1", expectedDigest]);
    expect(audit?.values[1]).toBe("invitation-1");
    expect(JSON.parse(String(audit?.values[2]))).toEqual({ reservationId: "reservation-row" });
    const usesCode = fake.statements.find((statement) =>
      statement.text.includes("update public.invitations"),
    );
    expect(usesCode?.values).toEqual([invitationHash(code)]);
    const persisted = JSON.stringify(
      fake.statements.filter((statement) => !statement.text.includes("advisory")),
    );
    expect(persisted).not.toContain(normalizedEmail);
    expect(persisted).not.toContain(code);
    expect(fake.released).toEqual([undefined]);
  });

  it("does not consume another use while a reservation is active", async () => {
    const fake = fakePool({ activeReservationId: "reservation-existing", invitationId: "unused" });
    await reserveInvitation(fake.pool, email, code);
    expect(fake.verbs()).toEqual(["begin", "select", "select", "commit"]);
  });

  it("rejects an invalid or exhausted invitation and rolls back", async () => {
    const fake = fakePool({});
    await expect(reserveInvitation(fake.pool, email, code)).rejects.toMatchObject({
      status: 403,
      code: "INVITATION_INVALID",
    });
    expect(fake.verbs()).toEqual(["begin", "select", "select", "update", "rollback"]);
    expect(fake.released).toEqual([undefined]);
  });

  it("keeps the original failure when rollback fails and discards that connection", async () => {
    const fake = fakePool({ failRollback: true });
    const failure = await reserveInvitation(fake.pool, email, code).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HttpProblem);
    expect(failure).toMatchObject({ code: "INVITATION_INVALID" });
    expect(fake.released).toHaveLength(1);
    expect(fake.released[0]).toBeInstanceOf(Error);
    expect(fake.released[0]?.message).toMatch(/rollback/);
  });

  it("requires a plausible code before touching the database", async () => {
    const fake = fakePool({ invitationId: "invitation-1" });
    await expect(reserveInvitation(fake.pool, email, undefined)).rejects.toMatchObject({
      code: "INVITATION_REQUIRED",
    });
    await expect(reserveInvitation(fake.pool, email, "AW")).rejects.toMatchObject({
      code: "INVITATION_REQUIRED",
    });
    expect(fake.connections).toBe(0);
    expect(fake.statements).toEqual([]);
  });
});

describe("findActiveReservation", () => {
  it("looks up by digest only and ignores non-string ids", async () => {
    const seen: Statement[] = [];
    const runner = {
      async query(text: string, values: readonly unknown[] = []) {
        seen.push({ text, values });
        return { rows: [{ id: 42 }], rowCount: 1 };
      },
    };
    expect(await findActiveReservation(runner, emailHash(email))).toBeUndefined();
    expect(seen[0]?.values).toEqual([emailHash(email)]);
    expect(JSON.stringify(seen)).not.toContain(normalizedEmail);
  });
});

describe("createRegistrationGate", () => {
  it("lets open registration create users without a lookup", async () => {
    const fake = fakePool({});
    await expect(createRegistrationGate("open", fake.pool)({ email })).resolves.toBeUndefined();
    expect(fake.statements).toEqual([]);
  });

  it("fails closed with a coded error when registration is closed", async () => {
    const fake = fakePool({ activeReservationId: "irrelevant" });
    const failure = await createRegistrationGate(
      "closed",
      fake.pool,
    )({ email }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIError);
    expect(failure).toMatchObject({
      statusCode: 403,
      body: { code: "REGISTRATION_CLOSED" },
    });
    expect(fake.statements).toEqual([]);
  });

  it("requires an active reservation in invite mode, for OAuth sign-ups too", async () => {
    const withoutReservation = fakePool({});
    const failure = await createRegistrationGate(
      "invite",
      withoutReservation.pool,
    )({
      email,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIError);
    expect(failure).toMatchObject({
      statusCode: 403,
      body: { code: "INVITATION_REQUIRED", message: expect.stringMatching(/GitHub/) },
    });
    expect(withoutReservation.statements[0]?.values).toEqual([emailHash(email)]);

    const withReservation = fakePool({ activeReservationId: "reservation-1" });
    await expect(
      createRegistrationGate("invite", withReservation.pool)({ email }),
    ).resolves.toBeUndefined();
  });
});

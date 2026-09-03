import { createHash } from "node:crypto";
import type {
  AllianceView,
  MessageSendReceipt,
  MessageView,
  Resources,
  SendMessageRequest,
  TradeOfferRequest,
  TradeView,
} from "@agentworld/api-contract";
import type { Database, Json } from "@agentworld/db";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import { v7 as uuidv7 } from "uuid";
import type { GameService } from "./game-service.ts";
import { HttpProblem } from "./problem.ts";

type Actor = Awaited<ReturnType<GameService["requireActor"]>>;

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function digest(action: string, body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, body: canonicalValue(body) }))
    .digest("hex");
}

function untrusted(content: string) {
  return { content, trust: "untrusted_player_input" as const };
}

function asResources(input: unknown): Resources {
  if (!input || typeof input !== "object")
    throw new HttpProblem(400, "INVALID_RESOURCES", "Invalid resource vector");
  const record = input as Record<string, unknown>;
  const result = {
    energy: record.energy,
    materials: record.materials,
    inference: record.inference,
  };
  if (
    !Number.isSafeInteger(result.energy) ||
    !Number.isSafeInteger(result.materials) ||
    !Number.isSafeInteger(result.inference) ||
    (result.energy as number) < 0 ||
    (result.materials as number) < 0 ||
    (result.inference as number) < 0
  ) {
    throw new HttpProblem(400, "INVALID_RESOURCES", "Resources must be non-negative safe integers");
  }
  return result as Resources;
}

function hasResources(value: Resources): boolean {
  return value.energy + value.materials + value.inference > 0;
}

function messageView(row: {
  id: string;
  senderPlayerId: string;
  recipientPlayerId: string | null;
  allianceId: string | null;
  body: string;
  sentAt: Date | string;
}): MessageView {
  return {
    id: row.id,
    senderPlayerId: row.senderPlayerId,
    ...(row.recipientPlayerId ? { recipientPlayerId: row.recipientPlayerId } : {}),
    ...(row.allianceId ? { allianceId: row.allianceId } : {}),
    body: untrusted(row.body),
    sentAt: new Date(row.sentAt).toISOString(),
  };
}

function tradeView(row: {
  id: string;
  senderPlayerId: string;
  recipientPlayerId: string;
  offered: Json;
  requested: Json;
  state: "open" | "accepted" | "cancelled" | "expired";
  expiresAt: Date | string;
}): TradeView {
  return {
    id: row.id,
    senderPlayerId: row.senderPlayerId,
    recipientPlayerId: row.recipientPlayerId,
    offered: asResources(row.offered),
    requested: asResources(row.requested),
    state: row.state,
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

export class SocialService {
  public constructor(
    private readonly game: GameService,
    private readonly database: import("kysely").Kysely<Database>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = uuidv7,
  ) {}

  private async refreshAllianceInfluence(
    transaction: Transaction<Database>,
    worldId: string,
    allianceId: string,
  ): Promise<number> {
    const members = await transaction
      .selectFrom("players")
      .select("influence")
      .where("worldId", "=", worldId)
      .where("allianceId", "=", allianceId)
      .execute();
    const influence = members.reduce((sum, member) => sum + member.influence, 0);
    if (!Number.isSafeInteger(influence)) throw new RangeError("alliance influence overflow");
    await transaction
      .updateTable("alliances")
      .set({ influence })
      .where("worldId", "=", worldId)
      .where("id", "=", allianceId)
      .execute();
    return influence;
  }

  private async requireAllianceCapacity(
    transaction: Transaction<Database>,
    worldId: string,
    allianceId: string,
  ): Promise<void> {
    const count = await transaction
      .selectFrom("allianceMembers")
      .select((expression) => expression.fn.countAll().as("count"))
      .where("worldId", "=", worldId)
      .where("allianceId", "=", allianceId)
      .where("leftAt", "is", null)
      .executeTakeFirstOrThrow();
    if (Number(count.count) >= 20) {
      throw new HttpProblem(409, "ALLIANCE_FULL", "An alliance can have at most 20 members");
    }
  }

  private async refundTradeEscrow(
    transaction: Transaction<Database>,
    worldId: string,
    senderPlayerId: string,
    offered: Resources,
    actionId: string,
    reason: "trade_cancelled" | "trade_expired",
  ): Promise<void> {
    const inventory = await transaction
      .selectFrom("inventories")
      .selectAll()
      .where("playerId", "=", senderPlayerId)
      .where("worldId", "=", worldId)
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
        version: sql`version + 1`,
      })
      .where("playerId", "=", senderPlayerId)
      .execute();
    await transaction
      .insertInto("resourceLedger")
      .values({
        id: this.newId(),
        worldId,
        playerId: senderPlayerId,
        actionId,
        reason,
        energyDelta: offered.energy,
        materialsDelta: offered.materials,
        inferenceDelta: offered.inference,
      })
      .execute();
  }

  private async mutation<T>(
    userId: string,
    worldId: string,
    key: string,
    action: string,
    body: unknown,
    execute: (transaction: Transaction<Database>, actor: Actor, actionId: string) => Promise<T>,
  ): Promise<T> {
    if (key.length < 1 || key.length > 128) {
      throw new HttpProblem(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A 1 to 128 character Idempotency-Key is required",
      );
    }
    return this.database
      .transaction()
      .setIsolationLevel("serializable")
      .execute(async (transaction) => {
        const actor = await this.game.requireActor(transaction, userId, worldId, true);
        await this.game.requireMutableWorld(transaction, worldId);
        await sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.id}:${key}`}, 0))`.execute(
          transaction,
        );
        const hash = digest(action, body);
        const existing = await transaction
          .selectFrom("actions")
          .selectAll()
          .where("worldId", "=", worldId)
          .where("playerId", "=", actor.id)
          .where("idempotencyKey", "=", key)
          .executeTakeFirst();
        if (existing) {
          if (existing.actionType !== action || existing.requestHash !== hash) {
            throw new HttpProblem(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This idempotency key was used for different input",
            );
          }
          if (existing.state === "completed" && existing.response !== null)
            return existing.response as T;
          throw new HttpProblem(
            409,
            "ACTION_IN_PROGRESS",
            "This request is already processing",
            true,
            1,
          );
        }
        const actionId = this.newId();
        await transaction
          .insertInto("actions")
          .values({
            id: actionId,
            worldId,
            playerId: actor.id,
            idempotencyKey: key,
            requestHash: hash,
            actionType: action,
            state: "processing",
            response: null,
            completedAt: null,
          })
          .execute();
        const result = await execute(transaction, actor, actionId);
        await this.game.recordPlayerEvent(
          transaction,
          worldId,
          actor.id,
          actionId,
          `${action.replaceAll("-", "_").toUpperCase()}_COMPLETED`,
        );
        await transaction
          .updateTable("actions")
          .set({
            state: "completed",
            response: json(result),
            completedAt: this.now(),
          })
          .where("id", "=", actionId)
          .execute();
        return result;
      });
  }

  public async messages(userId: string, worldId: string, cursor?: string) {
    const actor = await this.game.requireActor(this.database, userId, worldId);
    await this.game.requireTrustTier(this.database, actor.id, worldId, 1);
    const before = cursor
      ? new Date(Buffer.from(cursor, "base64url").toString("utf8"))
      : this.now();
    if (Number.isNaN(before.getTime()))
      throw new HttpProblem(400, "INVALID_CURSOR", "Invalid cursor");
    const [rows, muteRows] = await Promise.all([
      this.database
        .selectFrom("messages")
        .selectAll()
        .where("worldId", "=", worldId)
        .where("deletedAt", "is", null)
        .where("sentAt", "<", before)
        .where((expression) =>
          expression.or([
            expression("senderPlayerId", "=", actor.id),
            expression("recipientPlayerId", "=", actor.id),
            ...(actor.allianceId ? [expression("allianceId", "=", actor.allianceId)] : []),
          ]),
        )
        .orderBy("sentAt", "desc")
        .limit(100)
        .execute(),
      this.database
        .selectFrom("messageMutes")
        .select("channelId")
        .where("worldId", "=", worldId)
        .where("playerId", "=", actor.id)
        .execute(),
    ]);
    const mutedChannels = new Set(muteRows.map((row) => row.channelId));
    const visibleRows = rows
      .filter(
        (row) =>
          row.senderPlayerId === actor.id ||
          (!mutedChannels.has(row.senderPlayerId) &&
            (row.allianceId === null || !mutedChannels.has(row.allianceId))),
      )
      .slice(0, 50);
    return {
      items: visibleRows.map(messageView),
      ...(visibleRows.length === 50
        ? {
            nextCursor: Buffer.from(
              new Date(visibleRows.at(-1)?.sentAt ?? before).toISOString(),
            ).toString("base64url"),
          }
        : {}),
    };
  }

  public sendMessage(userId: string, worldId: string, key: string, request: SendMessageRequest) {
    return this.mutation(
      userId,
      worldId,
      key,
      "send-message",
      request,
      async (transaction, actor) => {
        await this.game.requireTrustTier(transaction, actor.id, worldId, 1);
        if ((request.recipientPlayerId ? 1 : 0) + (request.allianceId ? 1 : 0) !== 1) {
          throw new HttpProblem(
            400,
            "ONE_RECIPIENT_REQUIRED",
            "Choose exactly one player or alliance recipient",
          );
        }
        const body = request.body.normalize("NFKC").trim();
        if (body.length < 1 || body.length > 4_000) {
          throw new HttpProblem(
            400,
            "INVALID_MESSAGE",
            "Message body must contain 1 to 4000 characters",
          );
        }
        if (request.recipientPlayerId) {
          const target = await transaction
            .selectFrom("players")
            .select("id")
            .where("id", "=", request.recipientPlayerId)
            .where("worldId", "=", worldId)
            .executeTakeFirst();
          if (!target) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Recipient not found");
          const blocked = await transaction
            .selectFrom("playerBlocks")
            .select("blockerPlayerId")
            .where("worldId", "=", worldId)
            .where((expression) =>
              expression.or([
                expression.and([
                  expression("blockerPlayerId", "=", request.recipientPlayerId as string),
                  expression("blockedPlayerId", "=", actor.id),
                ]),
                expression.and([
                  expression("blockerPlayerId", "=", actor.id),
                  expression("blockedPlayerId", "=", request.recipientPlayerId as string),
                ]),
              ]),
            )
            .executeTakeFirst();
          if (blocked)
            throw new HttpProblem(
              403,
              "INTERACTION_UNAVAILABLE",
              "Direct interaction is unavailable",
            );
          const muted = await transaction
            .selectFrom("messageMutes")
            .select("playerId")
            .where("worldId", "=", worldId)
            .where("playerId", "=", request.recipientPlayerId)
            .where("channelId", "=", actor.id)
            .executeTakeFirst();
          if (muted)
            throw new HttpProblem(
              403,
              "INTERACTION_UNAVAILABLE",
              "Direct interaction is unavailable",
            );
        } else if (request.allianceId !== actor.allianceId) {
          throw new HttpProblem(
            403,
            "NOT_ALLIANCE_MEMBER",
            "Messages may be sent only to your alliance",
          );
        }
        const id = this.newId();
        const contentHash = createHash("sha256").update(body).digest("hex");
        const row = await transaction
          .insertInto("messages")
          .values({
            id,
            worldId,
            senderPlayerId: actor.id,
            recipientPlayerId: request.recipientPlayerId ?? null,
            allianceId: request.allianceId ?? null,
            body,
            contentHash,
            deletedAt: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          id: row.id,
          senderPlayerId: row.senderPlayerId,
          ...(row.recipientPlayerId ? { recipientPlayerId: row.recipientPlayerId } : {}),
          ...(row.allianceId ? { allianceId: row.allianceId } : {}),
          sentAt: new Date(row.sentAt).toISOString(),
        } satisfies MessageSendReceipt;
      },
    );
  }

  public block(userId: string, worldId: string, key: string, targetId: string, blocked: boolean) {
    return this.mutation(
      userId,
      worldId,
      key,
      blocked ? "block-player" : "unblock-player",
      { targetId },
      async (transaction, actor) => {
        if (actor.id === targetId)
          throw new HttpProblem(400, "SELF_TARGET", "You cannot block yourself");
        const target = await transaction
          .selectFrom("players")
          .select("id")
          .where("worldId", "=", worldId)
          .where("id", "=", targetId)
          .executeTakeFirst();
        if (!target) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Player not found");
        if (blocked) {
          await transaction
            .insertInto("playerBlocks")
            .values({ worldId, blockerPlayerId: actor.id, blockedPlayerId: targetId })
            .onConflict((conflict) => conflict.doNothing())
            .execute();
        } else {
          await transaction
            .deleteFrom("playerBlocks")
            .where("worldId", "=", worldId)
            .where("blockerPlayerId", "=", actor.id)
            .where("blockedPlayerId", "=", targetId)
            .execute();
        }
        return { blocked, playerId: targetId };
      },
    );
  }

  public mute(userId: string, worldId: string, key: string, channelId: string, muted: boolean) {
    return this.mutation(
      userId,
      worldId,
      key,
      muted ? "mute-channel" : "unmute-channel",
      { channelId },
      async (transaction, actor) => {
        if (muted) {
          await transaction
            .insertInto("messageMutes")
            .values({ worldId, playerId: actor.id, channelId })
            .onConflict((conflict) => conflict.doNothing())
            .execute();
        } else {
          await transaction
            .deleteFrom("messageMutes")
            .where("worldId", "=", worldId)
            .where("playerId", "=", actor.id)
            .where("channelId", "=", channelId)
            .execute();
        }
        return { muted, channelId };
      },
    );
  }

  public report(
    userId: string,
    worldId: string,
    key: string,
    request: { reportedPlayerId: string; messageId?: string; reason: string },
  ) {
    return this.mutation(
      userId,
      worldId,
      key,
      "report-player",
      request,
      async (transaction, actor) => {
        if (request.reportedPlayerId === actor.id) {
          throw new HttpProblem(400, "SELF_TARGET", "You cannot report yourself");
        }
        const reason = request.reason.normalize("NFKC").trim();
        if (reason.length < 1 || reason.length > 500) {
          throw new HttpProblem(
            400,
            "INVALID_REPORT_REASON",
            "A report reason must contain 1 to 500 characters",
          );
        }
        const reported = await transaction
          .selectFrom("players")
          .select("id")
          .where("worldId", "=", worldId)
          .where("id", "=", request.reportedPlayerId)
          .executeTakeFirst();
        if (!reported) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Reported player not found");
        if (request.messageId) {
          const message = await transaction
            .selectFrom("messages")
            .select(["id", "recipientPlayerId", "allianceId"])
            .where("id", "=", request.messageId)
            .where("worldId", "=", worldId)
            .where("senderPlayerId", "=", request.reportedPlayerId)
            .executeTakeFirst();
          const visibleToReporter =
            message?.recipientPlayerId === actor.id ||
            (message?.allianceId !== null && message?.allianceId === actor.allianceId);
          if (!message || !visibleToReporter) {
            throw new HttpProblem(
              404,
              "MESSAGE_NOT_FOUND",
              "The reported message was not sent by that player in this world",
            );
          }
        }
        const id = this.newId();
        await transaction
          .insertInto("reports")
          .values({
            id,
            worldId,
            reporterPlayerId: actor.id,
            reportedPlayerId: request.reportedPlayerId,
            messageId: request.messageId ?? null,
            reason,
            state: "open",
            resolvedAt: null,
          })
          .execute();
        return { id, accepted: true };
      },
    );
  }

  public async trades(userId: string, worldId: string) {
    const actor = await this.game.requireActor(this.database, userId, worldId);
    const rows = await this.database
      .selectFrom("trades")
      .selectAll()
      .where("worldId", "=", worldId)
      .where((expression) =>
        expression.or([
          expression("senderPlayerId", "=", actor.id),
          expression("recipientPlayerId", "=", actor.id),
        ]),
      )
      .orderBy("createdAt", "desc")
      .limit(100)
      .execute();
    return { items: rows.map(tradeView) };
  }

  public offerTrade(userId: string, worldId: string, key: string, request: TradeOfferRequest) {
    return this.mutation(
      userId,
      worldId,
      key,
      "offer-trade",
      request,
      async (transaction, actor, actionId) => {
        if (request.recipientPlayerId === actor.id)
          throw new HttpProblem(400, "SELF_TARGET", "You cannot trade with yourself");
        await this.game.requireTrustTier(transaction, actor.id, worldId, 2);
        await this.game.settlePlayerProduction(transaction, actor.id, worldId, actionId);
        const offered = asResources(request.offered);
        const requested = asResources(request.requested);
        if (!hasResources(offered))
          throw new HttpProblem(400, "EMPTY_TRADE", "A trade must offer at least one resource");
        const target = await transaction
          .selectFrom("players")
          .select("id")
          .where("worldId", "=", worldId)
          .where("id", "=", request.recipientPlayerId)
          .executeTakeFirst();
        if (!target) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Trade recipient not found");
        const inventory = await transaction
          .selectFrom("inventories")
          .selectAll()
          .where("playerId", "=", actor.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (
          inventory.energy < offered.energy ||
          inventory.materials < offered.materials ||
          inventory.inference < offered.inference
        ) {
          throw new HttpProblem(
            409,
            "INSUFFICIENT_TRANSFERABLE_RESOURCES",
            "Only transferable resources can be offered",
          );
        }
        await transaction
          .updateTable("inventories")
          .set({
            energy: inventory.energy - offered.energy,
            materials: inventory.materials - offered.materials,
            inference: inventory.inference - offered.inference,
            escrowEnergy: inventory.escrowEnergy + offered.energy,
            escrowMaterials: inventory.escrowMaterials + offered.materials,
            escrowInference: inventory.escrowInference + offered.inference,
            version: sql`version + 1`,
          })
          .where("playerId", "=", actor.id)
          .execute();
        const expiresAt = new Date(this.now().getTime() + 86_400_000);
        const row = await transaction
          .insertInto("trades")
          .values({
            id: this.newId(),
            worldId,
            senderPlayerId: actor.id,
            recipientPlayerId: request.recipientPlayerId,
            offered: json(offered),
            requested: json(requested),
            state: "open",
            expiresAt,
            resolvedAt: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("resourceLedger")
          .values({
            id: this.newId(),
            worldId,
            playerId: actor.id,
            actionId,
            reason: "trade_escrow",
            energyDelta: -offered.energy,
            materialsDelta: -offered.materials,
            inferenceDelta: -offered.inference,
          })
          .execute();
        return tradeView(row);
      },
    );
  }

  public resolveTrade(
    userId: string,
    worldId: string,
    key: string,
    tradeId: string,
    resolution: "accept" | "cancel",
  ) {
    return this.mutation(
      userId,
      worldId,
      key,
      `${resolution}-trade`,
      { tradeId },
      async (transaction, actor, actionId) => {
        await this.game.requireTrustTier(transaction, actor.id, worldId, 2);
        await this.game.settlePlayerProduction(transaction, actor.id, worldId, actionId);
        const trade = await transaction
          .selectFrom("trades")
          .selectAll()
          .where("id", "=", tradeId)
          .where("worldId", "=", worldId)
          .forUpdate()
          .executeTakeFirst();
        if (!trade) throw new HttpProblem(404, "TRADE_NOT_FOUND", "Trade not found");
        if (trade.state !== "open")
          throw new HttpProblem(409, "TRADE_NOT_OPEN", "Trade is no longer open");
        const offered = asResources(trade.offered);
        const requested = asResources(trade.requested);
        const expired = new Date(trade.expiresAt) <= this.now();
        if (resolution === "cancel") {
          if (trade.senderPlayerId !== actor.id)
            throw new HttpProblem(403, "NOT_TRADE_SENDER", "Only the sender can cancel this trade");
          await this.refundTradeEscrow(
            transaction,
            worldId,
            trade.senderPlayerId,
            offered,
            actionId,
            expired ? "trade_expired" : "trade_cancelled",
          );
        } else {
          if (trade.recipientPlayerId !== actor.id)
            throw new HttpProblem(
              403,
              "NOT_TRADE_RECIPIENT",
              "Only the recipient can accept this trade",
            );
          if (expired) {
            await this.refundTradeEscrow(
              transaction,
              worldId,
              trade.senderPlayerId,
              offered,
              actionId,
              "trade_expired",
            );
          } else {
            await this.game.requireTrustTier(transaction, trade.senderPlayerId, worldId, 2);
            await this.game.settlePlayerProduction(
              transaction,
              trade.senderPlayerId,
              worldId,
              actionId,
            );
            const ids = [trade.senderPlayerId, trade.recipientPlayerId].sort();
            const inventories = await transaction
              .selectFrom("inventories")
              .selectAll()
              .where("playerId", "in", ids)
              .orderBy("playerId")
              .forUpdate()
              .execute();
            const sender = inventories.find((value) => value.playerId === trade.senderPlayerId);
            const recipient = inventories.find(
              (value) => value.playerId === trade.recipientPlayerId,
            );
            if (!sender || !recipient) throw new Error("trade inventory is missing");
            if (
              recipient.energy < requested.energy ||
              recipient.materials < requested.materials ||
              recipient.inference < requested.inference
            ) {
              throw new HttpProblem(
                409,
                "INSUFFICIENT_TRANSFERABLE_RESOURCES",
                "The recipient cannot afford this trade",
              );
            }
            await transaction
              .updateTable("inventories")
              .set({
                energy: sender.energy + requested.energy,
                materials: sender.materials + requested.materials,
                inference: sender.inference + requested.inference,
                escrowEnergy: sender.escrowEnergy - offered.energy,
                escrowMaterials: sender.escrowMaterials - offered.materials,
                escrowInference: sender.escrowInference - offered.inference,
                version: sql`version + 1`,
              })
              .where("playerId", "=", sender.playerId)
              .execute();
            await transaction
              .updateTable("inventories")
              .set({
                energy: recipient.energy - requested.energy + offered.energy,
                materials: recipient.materials - requested.materials + offered.materials,
                inference: recipient.inference - requested.inference + offered.inference,
                version: sql`version + 1`,
              })
              .where("playerId", "=", recipient.playerId)
              .execute();
            await transaction
              .insertInto("resourceLedger")
              .values([
                {
                  id: this.newId(),
                  worldId,
                  playerId: sender.playerId,
                  actionId,
                  reason: "trade_completed",
                  energyDelta: requested.energy,
                  materialsDelta: requested.materials,
                  inferenceDelta: requested.inference,
                },
                {
                  id: this.newId(),
                  worldId,
                  playerId: recipient.playerId,
                  actionId,
                  reason: "trade_completed",
                  energyDelta: offered.energy - requested.energy,
                  materialsDelta: offered.materials - requested.materials,
                  inferenceDelta: offered.inference - requested.inference,
                },
              ])
              .execute();
          }
        }
        const row = await transaction
          .updateTable("trades")
          .set({
            state: expired ? "expired" : resolution === "accept" ? "accepted" : "cancelled",
            resolvedAt: this.now(),
          })
          .where("id", "=", trade.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return tradeView(row);
      },
    );
  }

  public async alliances(userId: string, worldId: string) {
    await this.game.requireActor(this.database, userId, worldId);
    const rows = await this.database
      .selectFrom("alliances")
      .selectAll()
      .where("worldId", "=", worldId)
      .where("disbandedAt", "is", null)
      .orderBy("influence", "desc")
      .execute();
    const members = await this.database
      .selectFrom("allianceMembers")
      .select(["allianceId", "playerId"])
      .where("worldId", "=", worldId)
      .where("leftAt", "is", null)
      .execute();
    return {
      items: rows.map(
        (row): AllianceView => ({
          id: row.id,
          name: untrusted(row.name),
          leaderPlayerId: row.leaderPlayerId,
          memberPlayerIds: members
            .filter((member) => member.allianceId === row.id)
            .map((member) => member.playerId),
          influence: row.influence,
        }),
      ),
    };
  }

  public createAlliance(userId: string, worldId: string, key: string, nameValue: string) {
    const body = { name: nameValue.normalize("NFKC").trim() };
    return this.mutation(
      userId,
      worldId,
      key,
      "create-alliance",
      body,
      async (transaction, actor) => {
        await this.game.requireTrustTier(transaction, actor.id, worldId, 1);
        await this.game.assertAllianceChangesAllowed(transaction, worldId);
        if (actor.allianceId)
          throw new HttpProblem(409, "ALREADY_IN_ALLIANCE", "Leave your current alliance first");
        if (body.name.length < 2 || body.name.length > 40)
          throw new HttpProblem(
            400,
            "INVALID_ALLIANCE_NAME",
            "Alliance name must contain 2 to 40 characters",
          );
        const id = this.newId();
        const row = await transaction
          .insertInto("alliances")
          .values({ id, worldId, name: body.name, leaderPlayerId: actor.id, disbandedAt: null })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("allianceMembers")
          .values({ worldId, allianceId: id, playerId: actor.id, role: "leader", leftAt: null })
          .execute();
        await transaction
          .updateTable("players")
          .set({ allianceId: id })
          .where("id", "=", actor.id)
          .execute();
        const influence = await this.refreshAllianceInfluence(transaction, worldId, id);
        return {
          id,
          name: untrusted(row.name),
          leaderPlayerId: actor.id,
          memberPlayerIds: [actor.id],
          influence,
        } satisfies AllianceView;
      },
    );
  }

  public inviteAlliance(
    userId: string,
    worldId: string,
    key: string,
    allianceId: string,
    targetId: string,
  ) {
    return this.mutation(
      userId,
      worldId,
      key,
      "invite-alliance",
      { allianceId, targetId },
      async (transaction, actor) => {
        await this.game.requireTrustTier(transaction, actor.id, worldId, 1);
        await this.game.assertAllianceChangesAllowed(transaction, worldId);
        const alliance = await transaction
          .selectFrom("alliances")
          .selectAll()
          .where("id", "=", allianceId)
          .where("worldId", "=", worldId)
          .where("disbandedAt", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!alliance) throw new HttpProblem(404, "ALLIANCE_NOT_FOUND", "Alliance not found");
        if (alliance.leaderPlayerId !== actor.id)
          throw new HttpProblem(403, "NOT_ALLIANCE_LEADER", "Only the leader can invite players");
        const target = await transaction
          .selectFrom("players")
          .select(["id", "allianceId"])
          .where("id", "=", targetId)
          .where("worldId", "=", worldId)
          .executeTakeFirst();
        if (!target) throw new HttpProblem(404, "PLAYER_NOT_FOUND", "Player not found");
        if (target.allianceId)
          throw new HttpProblem(
            409,
            "ALREADY_IN_ALLIANCE",
            "Player already belongs to an alliance",
          );
        await this.requireAllianceCapacity(transaction, worldId, allianceId);
        const invite = await transaction
          .insertInto("allianceInvites")
          .values({
            id: this.newId(),
            worldId,
            allianceId,
            playerId: targetId,
            invitedByPlayerId: actor.id,
            state: "pending",
            expiresAt: new Date(this.now().getTime() + 86_400_000),
          })
          .returning(["id", "expiresAt"])
          .executeTakeFirstOrThrow();
        return { inviteId: invite.id, expiresAt: new Date(invite.expiresAt).toISOString() };
      },
    );
  }

  public acceptAllianceInvite(userId: string, worldId: string, key: string, inviteId: string) {
    return this.mutation(
      userId,
      worldId,
      key,
      "accept-alliance-invite",
      { inviteId },
      async (transaction, actor) => {
        await this.game.requireTrustTier(transaction, actor.id, worldId, 1);
        await this.game.assertAllianceChangesAllowed(transaction, worldId);
        if (actor.allianceId)
          throw new HttpProblem(409, "ALREADY_IN_ALLIANCE", "Leave your current alliance first");
        const invite = await transaction
          .selectFrom("allianceInvites")
          .selectAll()
          .where("id", "=", inviteId)
          .where("worldId", "=", worldId)
          .forUpdate()
          .executeTakeFirst();
        if (!invite || invite.playerId !== actor.id)
          throw new HttpProblem(404, "INVITE_NOT_FOUND", "Invitation not found");
        if (invite.state !== "pending" || new Date(invite.expiresAt) <= this.now())
          throw new HttpProblem(409, "INVITE_EXPIRED", "Invitation is no longer valid");
        const alliance = await transaction
          .selectFrom("alliances")
          .select("id")
          .where("id", "=", invite.allianceId)
          .where("worldId", "=", worldId)
          .where("disbandedAt", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!alliance) throw new HttpProblem(404, "ALLIANCE_NOT_FOUND", "Alliance not found");
        await this.requireAllianceCapacity(transaction, worldId, alliance.id);
        await transaction
          .updateTable("allianceInvites")
          .set({ state: "accepted" })
          .where("id", "=", invite.id)
          .execute();
        await transaction
          .insertInto("allianceMembers")
          .values({
            worldId,
            allianceId: invite.allianceId,
            playerId: actor.id,
            role: "member",
            leftAt: null,
          })
          .execute();
        await transaction
          .updateTable("players")
          .set({ allianceId: invite.allianceId })
          .where("id", "=", actor.id)
          .execute();
        await this.refreshAllianceInfluence(transaction, worldId, alliance.id);
        const members = await transaction
          .selectFrom("allianceMembers")
          .select("playerId")
          .where("worldId", "=", worldId)
          .where("allianceId", "=", alliance.id)
          .where("leftAt", "is", null)
          .execute();
        const memberIds = members.map((member) => member.playerId);
        await transaction
          .deleteFrom("hostilities")
          .where("worldId", "=", worldId)
          .where((expression) =>
            expression.or([
              expression.and([
                expression("aggressorPlayerId", "=", actor.id),
                expression("defenderPlayerId", "in", memberIds),
              ]),
              expression.and([
                expression("defenderPlayerId", "=", actor.id),
                expression("aggressorPlayerId", "in", memberIds),
              ]),
            ]),
          )
          .execute();
        return { accepted: true, allianceId: invite.allianceId };
      },
    );
  }

  public allianceAdministration(
    userId: string,
    worldId: string,
    key: string,
    allianceId: string,
    operation: "leave" | "leadership" | "disband",
    targetId?: string,
  ) {
    return this.mutation(
      userId,
      worldId,
      key,
      `alliance-${operation}`,
      { allianceId, targetId },
      async (transaction, actor) => {
        await this.game.requireTrustTier(transaction, actor.id, worldId, 1);
        await this.game.assertAllianceChangesAllowed(transaction, worldId);
        const alliance = await transaction
          .selectFrom("alliances")
          .selectAll()
          .where("id", "=", allianceId)
          .where("worldId", "=", worldId)
          .forUpdate()
          .executeTakeFirst();
        if (!alliance || actor.allianceId !== alliance.id)
          throw new HttpProblem(404, "ALLIANCE_NOT_FOUND", "Alliance not found");
        if (operation === "leave") {
          if (alliance.leaderPlayerId === actor.id)
            throw new HttpProblem(
              409,
              "LEADER_CANNOT_LEAVE",
              "Transfer leadership or disband first",
            );
          await transaction
            .updateTable("allianceMembers")
            .set({ leftAt: this.now() })
            .where("allianceId", "=", alliance.id)
            .where("playerId", "=", actor.id)
            .where("leftAt", "is", null)
            .execute();
          await transaction
            .updateTable("players")
            .set({ allianceId: null })
            .where("id", "=", actor.id)
            .execute();
          await this.refreshAllianceInfluence(transaction, worldId, alliance.id);
        } else if (operation === "leadership") {
          if (alliance.leaderPlayerId !== actor.id)
            throw new HttpProblem(
              403,
              "NOT_ALLIANCE_LEADER",
              "Only the leader can transfer leadership",
            );
          if (!targetId) throw new HttpProblem(400, "PLAYER_REQUIRED", "A new leader is required");
          const target = await transaction
            .selectFrom("allianceMembers")
            .select("playerId")
            .where("allianceId", "=", alliance.id)
            .where("playerId", "=", targetId)
            .where("leftAt", "is", null)
            .executeTakeFirst();
          if (!target)
            throw new HttpProblem(404, "ALLIANCE_MEMBER_NOT_FOUND", "New leader is not a member");
          await transaction
            .updateTable("alliances")
            .set({ leaderPlayerId: targetId })
            .where("id", "=", alliance.id)
            .execute();
          await transaction
            .updateTable("allianceMembers")
            .set({ role: "member" })
            .where("allianceId", "=", alliance.id)
            .where("playerId", "=", actor.id)
            .where("leftAt", "is", null)
            .execute();
          await transaction
            .updateTable("allianceMembers")
            .set({ role: "leader" })
            .where("allianceId", "=", alliance.id)
            .where("playerId", "=", targetId)
            .where("leftAt", "is", null)
            .execute();
        } else {
          if (alliance.leaderPlayerId !== actor.id)
            throw new HttpProblem(403, "NOT_ALLIANCE_LEADER", "Only the leader can disband");
          await transaction
            .updateTable("alliances")
            .set({ disbandedAt: this.now(), influence: 0 })
            .where("id", "=", alliance.id)
            .execute();
          await transaction
            .updateTable("allianceInvites")
            .set({ state: "expired" })
            .where("allianceId", "=", alliance.id)
            .where("state", "=", "pending")
            .execute();
          await transaction
            .updateTable("allianceMembers")
            .set({ leftAt: this.now() })
            .where("allianceId", "=", alliance.id)
            .where("leftAt", "is", null)
            .execute();
          await transaction
            .updateTable("players")
            .set({ allianceId: null })
            .where("allianceId", "=", alliance.id)
            .execute();
        }
        return { ok: true, operation, allianceId, ...(targetId ? { playerId: targetId } : {}) };
      },
    );
  }
}

import {
  ActionReceipt,
  AllianceAdministrationResponse,
  AllianceCreateRequest,
  AllianceInviteAcceptResponse,
  AllianceInviteListResponse,
  AllianceInviteRequest,
  AllianceInviteResponse,
  AllianceLeadershipRequest,
  AllianceListResponse,
  AllianceView,
  AttackRequest,
  BuildRequest,
  EventPageResponse,
  HarvestRequest,
  InstallationDiscovery,
  InventoryResponse,
  LeaderboardResponse,
  LookResponse,
  MapResponse,
  MessagePageResponse,
  MessageSendReceipt,
  ModerationState,
  MoveRequest,
  MuteState,
  PlayerListResponse,
  PlayerStatus,
  PlayerSummary,
  RelationshipListResponse,
  ReportReceipt,
  ReportRequest,
  ScanActionReceipt,
  ScanRequest,
  SendMessageRequest,
  SpawnRequest,
  TradeOfferRequest,
  TradePageResponse,
  TradeView,
  WorldListResponse,
} from "@agentworld/api-contract";
import { type Static, Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type AuthRuntime, type GameScope, requireScopes } from "./auth.ts";
import type { GameService } from "./game-service.ts";
import { HttpProblem } from "./problem.ts";
import type { SocialService } from "./social-service.ts";

const WorldParams = Type.Object(
  { worldId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const PlayerParams = Type.Object(
  { worldId: Type.String({ format: "uuid" }), playerId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const TradeParams = Type.Object(
  { worldId: Type.String({ format: "uuid" }), tradeId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const AllianceParams = Type.Object(
  { worldId: Type.String({ format: "uuid" }), allianceId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const InviteParams = Type.Object(
  { worldId: Type.String({ format: "uuid" }), inviteId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const ChannelParams = Type.Object(
  {
    worldId: Type.String({ format: "uuid" }),
    channelId: Type.String({ minLength: 1, maxLength: 191 }),
  },
  { additionalProperties: false },
);
const EmptyBody = Type.Object({}, { additionalProperties: false });
const PageQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);
type WorldParams = Static<typeof WorldParams>;
type PlayerParams = Static<typeof PlayerParams>;
type TradeParams = Static<typeof TradeParams>;
type AllianceParams = Static<typeof AllianceParams>;
type InviteParams = Static<typeof InviteParams>;
type ChannelParams = Static<typeof ChannelParams>;
type PageQuery = Static<typeof PageQuery>;

function principal(request: FastifyRequest): string {
  if (!request.principal)
    throw new HttpProblem(500, "AUTH_CONTEXT_MISSING", "Authentication context is missing");
  return request.principal.userId;
}

function key(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new HttpProblem(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Set a 1 to 128 character Idempotency-Key header",
    );
  }
  return value;
}

function auth(authRuntime: AuthRuntime, ...scopes: GameScope[]) {
  return requireScopes(authRuntime, scopes);
}

export async function registerGameRoutes(
  app: FastifyInstance,
  game: GameService,
  social: SocialService,
  authRuntime: AuthRuntime,
): Promise<void> {
  app.get(
    "/.well-known/agentworld",
    { schema: { response: { 200: InstallationDiscovery }, tags: ["installation"] } },
    () => game.discovery(),
  );

  app.get(
    "/v1/worlds",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { response: { 200: WorldListResponse }, tags: ["worlds"] },
    },
    () => game.worlds(),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof SpawnRequest> }>(
    "/v1/worlds/:worldId/players",
    {
      preHandler: auth(authRuntime, "world:act"),
      schema: {
        params: WorldParams,
        body: SpawnRequest,
        response: { 200: PlayerSummary, 201: PlayerSummary },
        tags: ["worlds"],
      },
    },
    async (request, reply) => {
      const response = await game.spawn(
        principal(request),
        request.params.worldId,
        request.body.name,
        key(request),
      );
      return reply.code(201).send(response);
    },
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/me/status",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: PlayerStatus }, tags: ["state"] },
    },
    (request) => game.status(principal(request), request.params.worldId),
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/me/inventory",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: InventoryResponse }, tags: ["state"] },
    },
    (request) => game.inventory(principal(request), request.params.worldId),
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/look",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: LookResponse }, tags: ["state"] },
    },
    (request) => game.look(principal(request), request.params.worldId),
  );
  app.get<{ Params: WorldParams; Querystring: PageQuery }>(
    "/v1/worlds/:worldId/map",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: {
        params: WorldParams,
        querystring: PageQuery,
        response: { 200: MapResponse },
        tags: ["state"],
      },
    },
    (request) =>
      game.map(
        principal(request),
        request.params.worldId,
        request.query.cursor,
        request.query.limit,
      ),
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/players",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: PlayerListResponse }, tags: ["state"] },
    },
    (request) => game.players(principal(request), request.params.worldId),
  );
  app.get<{ Params: WorldParams; Querystring: PageQuery }>(
    "/v1/worlds/:worldId/events",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: {
        params: WorldParams,
        querystring: PageQuery,
        response: { 200: EventPageResponse },
        tags: ["state"],
      },
    },
    (request) =>
      game.events(
        principal(request),
        request.params.worldId,
        request.query.cursor,
        request.query.limit,
      ),
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/leaderboard",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: LeaderboardResponse }, tags: ["state"] },
    },
    (request) => game.leaderboard(principal(request), request.params.worldId),
  );

  app.post<{ Params: WorldParams; Body: Static<typeof MoveRequest> }>(
    "/v1/worlds/:worldId/actions/move",
    {
      preHandler: auth(authRuntime, "world:act"),
      schema: {
        params: WorldParams,
        body: MoveRequest,
        response: { 200: ActionReceipt },
        tags: ["actions"],
      },
    },
    (request) =>
      game.move(principal(request), request.params.worldId, key(request), request.body.direction),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof BuildRequest> }>(
    "/v1/worlds/:worldId/actions/build",
    {
      preHandler: auth(authRuntime, "world:act"),
      schema: {
        params: WorldParams,
        body: BuildRequest,
        response: { 200: ActionReceipt },
        tags: ["actions"],
      },
    },
    (request) =>
      game.build(principal(request), request.params.worldId, key(request), request.body.structure),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof HarvestRequest> }>(
    "/v1/worlds/:worldId/actions/harvest",
    {
      preHandler: auth(authRuntime, "world:act"),
      schema: {
        params: WorldParams,
        body: HarvestRequest,
        response: { 200: ActionReceipt },
        tags: ["actions"],
      },
    },
    (request) =>
      game.harvest(principal(request), request.params.worldId, key(request), request.body.resource),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof ScanRequest> }>(
    "/v1/worlds/:worldId/actions/scan",
    {
      preHandler: auth(authRuntime, "world:act"),
      schema: {
        params: WorldParams,
        body: ScanRequest,
        response: { 200: ScanActionReceipt },
        tags: ["actions"],
      },
    },
    (request) => game.scan(principal(request), request.params.worldId, key(request)),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof AttackRequest> }>(
    "/v1/worlds/:worldId/actions/attack",
    {
      preHandler: auth(authRuntime, "combat:write"),
      schema: {
        params: WorldParams,
        body: AttackRequest,
        response: { 200: ActionReceipt },
        tags: ["actions"],
      },
    },
    (request) =>
      game.attack(
        principal(request),
        request.params.worldId,
        key(request),
        request.body.targetStructureId,
        request.body.bonusInference,
      ),
  );
  app.put<{ Params: PlayerParams; Body: Record<string, never> }>(
    "/v1/worlds/:worldId/relationships/:playerId/hostility",
    {
      preHandler: auth(authRuntime, "combat:write"),
      schema: {
        params: PlayerParams,
        body: EmptyBody,
        response: { 200: ActionReceipt },
        tags: ["combat"],
      },
    },
    (request) =>
      game.hostility(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.playerId,
        false,
      ),
  );
  app.delete<{ Params: PlayerParams }>(
    "/v1/worlds/:worldId/relationships/:playerId/hostility",
    {
      preHandler: auth(authRuntime, "combat:write"),
      schema: { params: PlayerParams, response: { 200: ActionReceipt }, tags: ["combat"] },
    },
    (request) =>
      game.hostility(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.playerId,
        true,
      ),
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/relationships",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: {
        params: WorldParams,
        response: { 200: RelationshipListResponse },
        tags: ["combat"],
      },
    },
    (request) => game.relationships(principal(request), request.params.worldId),
  );

  app.get<{ Params: WorldParams; Querystring: PageQuery }>(
    "/v1/worlds/:worldId/messages",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: {
        params: WorldParams,
        querystring: PageQuery,
        response: { 200: MessagePageResponse },
        tags: ["social"],
      },
    },
    (request) =>
      social.messages(
        principal(request),
        request.params.worldId,
        request.query.cursor,
        request.query.limit,
      ),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof SendMessageRequest> }>(
    "/v1/worlds/:worldId/messages",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: WorldParams,
        body: SendMessageRequest,
        response: { 200: MessageSendReceipt },
        tags: ["social"],
      },
    },
    (request) =>
      social.sendMessage(principal(request), request.params.worldId, key(request), request.body),
  );
  app.put<{ Params: PlayerParams }>(
    "/v1/worlds/:worldId/blocks/:playerId",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: { params: PlayerParams, response: { 200: ModerationState }, tags: ["moderation"] },
    },
    (request) =>
      social.block(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.playerId,
        true,
      ),
  );
  app.delete<{ Params: PlayerParams }>(
    "/v1/worlds/:worldId/blocks/:playerId",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: { params: PlayerParams, response: { 200: ModerationState }, tags: ["moderation"] },
    },
    (request) =>
      social.block(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.playerId,
        false,
      ),
  );
  app.put<{ Params: ChannelParams }>(
    "/v1/worlds/:worldId/mutes/:channelId",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: { params: ChannelParams, response: { 200: MuteState }, tags: ["moderation"] },
    },
    (request) =>
      social.mute(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.channelId,
        true,
      ),
  );
  app.delete<{ Params: ChannelParams }>(
    "/v1/worlds/:worldId/mutes/:channelId",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: { params: ChannelParams, response: { 200: MuteState }, tags: ["moderation"] },
    },
    (request) =>
      social.mute(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.channelId,
        false,
      ),
  );
  app.post<{ Params: WorldParams; Body: ReportRequest }>(
    "/v1/worlds/:worldId/reports",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: WorldParams,
        body: ReportRequest,
        response: { 200: ReportReceipt },
        tags: ["moderation"],
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute", groupId: "reports" } },
    },
    (request) =>
      social.report(principal(request), request.params.worldId, key(request), request.body),
  );

  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/trades",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: TradePageResponse }, tags: ["trades"] },
    },
    (request) => social.trades(principal(request), request.params.worldId),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof TradeOfferRequest> }>(
    "/v1/worlds/:worldId/trades",
    {
      preHandler: auth(authRuntime, "trade:write"),
      schema: {
        params: WorldParams,
        body: TradeOfferRequest,
        response: { 200: TradeView },
        tags: ["trades"],
      },
    },
    (request) =>
      social.offerTrade(principal(request), request.params.worldId, key(request), request.body),
  );
  for (const resolution of ["accept", "cancel"] as const) {
    app.post<{ Params: TradeParams; Body: Record<string, never> }>(
      `/v1/worlds/:worldId/trades/:tradeId/${resolution}`,
      {
        preHandler: auth(authRuntime, "trade:write"),
        schema: {
          params: TradeParams,
          body: EmptyBody,
          response: { 200: TradeView },
          tags: ["trades"],
        },
      },
      (request) =>
        social.resolveTrade(
          principal(request),
          request.params.worldId,
          key(request),
          request.params.tradeId,
          resolution,
        ),
    );
  }

  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/alliances",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: { params: WorldParams, response: { 200: AllianceListResponse }, tags: ["alliances"] },
    },
    (request) => social.alliances(principal(request), request.params.worldId),
  );
  app.post<{ Params: WorldParams; Body: Static<typeof AllianceCreateRequest> }>(
    "/v1/worlds/:worldId/alliances",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: WorldParams,
        body: AllianceCreateRequest,
        response: { 200: AllianceView },
        tags: ["alliances"],
      },
    },
    (request) =>
      social.createAlliance(
        principal(request),
        request.params.worldId,
        key(request),
        request.body.name,
      ),
  );
  app.post<{ Params: AllianceParams; Body: Static<typeof AllianceInviteRequest> }>(
    "/v1/worlds/:worldId/alliances/:allianceId/invites",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: AllianceParams,
        body: AllianceInviteRequest,
        response: { 200: AllianceInviteResponse },
        tags: ["alliances"],
      },
    },
    (request) =>
      social.inviteAlliance(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.allianceId,
        request.body.playerId,
      ),
  );
  app.get<{ Params: WorldParams }>(
    "/v1/worlds/:worldId/alliance-invites",
    {
      preHandler: auth(authRuntime, "world:read"),
      schema: {
        params: WorldParams,
        response: { 200: AllianceInviteListResponse },
        tags: ["alliances"],
      },
    },
    (request) => social.allianceInvites(principal(request), request.params.worldId),
  );
  app.post<{ Params: InviteParams; Body: Record<string, never> }>(
    "/v1/worlds/:worldId/alliance-invites/:inviteId/accept",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: InviteParams,
        body: EmptyBody,
        response: { 200: AllianceInviteAcceptResponse },
        tags: ["alliances"],
      },
    },
    (request) =>
      social.acceptAllianceInvite(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.inviteId,
      ),
  );
  app.post<{ Params: AllianceParams; Body: Record<string, never> }>(
    "/v1/worlds/:worldId/alliances/:allianceId/leave",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: AllianceParams,
        body: EmptyBody,
        response: { 200: AllianceAdministrationResponse },
        tags: ["alliances"],
      },
    },
    (request) =>
      social.allianceAdministration(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.allianceId,
        "leave",
      ),
  );
  app.post<{ Params: AllianceParams; Body: Static<typeof AllianceLeadershipRequest> }>(
    "/v1/worlds/:worldId/alliances/:allianceId/leadership",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: AllianceParams,
        body: AllianceLeadershipRequest,
        response: { 200: AllianceAdministrationResponse },
        tags: ["alliances"],
      },
    },
    (request) =>
      social.allianceAdministration(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.allianceId,
        "leadership",
        request.body.playerId,
      ),
  );
  app.delete<{ Params: AllianceParams }>(
    "/v1/worlds/:worldId/alliances/:allianceId",
    {
      preHandler: auth(authRuntime, "social:write"),
      schema: {
        params: AllianceParams,
        response: { 200: AllianceAdministrationResponse },
        tags: ["alliances"],
      },
    },
    (request) =>
      social.allianceAdministration(
        principal(request),
        request.params.worldId,
        key(request),
        request.params.allianceId,
        "disband",
      ),
  );
}

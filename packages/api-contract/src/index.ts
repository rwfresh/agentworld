import { type Static, Type } from "@sinclair/typebox/type";

export const Identifier = Type.String({ format: "uuid", description: "UUID identifier" });
export type Identifier = Static<typeof Identifier>;

export const SafeInteger = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const ResourceKind = Type.Union([
  Type.Literal("energy"),
  Type.Literal("materials"),
  Type.Literal("inference"),
]);
export type ResourceKind = Static<typeof ResourceKind>;

export const Resources = Type.Object(
  {
    energy: SafeInteger,
    materials: SafeInteger,
    inference: SafeInteger,
  },
  { additionalProperties: false },
);
export type Resources = Static<typeof Resources>;

export const Coordinates = Type.Object(
  { x: Type.Integer(), y: Type.Integer() },
  { additionalProperties: false },
);
export type Coordinates = Static<typeof Coordinates>;

export const Direction = Type.Union([
  Type.Literal("north"),
  Type.Literal("east"),
  Type.Literal("south"),
  Type.Literal("west"),
]);
export type Direction = Static<typeof Direction>;

export const StructureKind = Type.Union([
  Type.Literal("command_node"),
  Type.Literal("generator"),
  Type.Literal("extractor"),
  Type.Literal("compute_node"),
  Type.Literal("defense_node"),
]);
export type StructureKind = Static<typeof StructureKind>;

export const Terrain = Type.Union([
  Type.Literal("plains"),
  Type.Literal("forest"),
  Type.Literal("hills"),
  Type.Literal("wetlands"),
]);
export type Terrain = Static<typeof Terrain>;

export const Zone = Type.Union([
  Type.Literal("safe"),
  Type.Literal("contested"),
  Type.Literal("frontier"),
]);
export type Zone = Static<typeof Zone>;

export const UntrustedText = Type.Object(
  {
    content: Type.String({ maxLength: 4_000 }),
    trust: Type.Literal("untrusted_player_input"),
  },
  { additionalProperties: false },
);
export type UntrustedText = Static<typeof UntrustedText>;

export const ProblemDetails = Type.Object(
  {
    type: Type.String({ format: "uri-reference" }),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    code: Type.String({ pattern: "^[A-Z0-9_]+$" }),
    detail: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
    retryAfter: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type ProblemDetails = Static<typeof ProblemDetails>;

export const EventSummary = Type.Object(
  {
    id: Identifier,
    offset: SafeInteger,
    type: Type.String(),
    tick: SafeInteger,
    occurredAt: Type.String({ format: "date-time" }),
    actorPlayerId: Type.Optional(Identifier),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type EventSummary = Static<typeof EventSummary>;

export const ActionReceipt = Type.Object(
  {
    actionId: Identifier,
    idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
    status: Type.Union([Type.Literal("completed"), Type.Literal("scheduled")]),
    effectiveTick: SafeInteger,
    completesAt: Type.Optional(Type.String({ format: "date-time" })),
    resources: Type.Optional(Resources),
    result: Type.Optional(
      Type.Unknown({ description: "Endpoint-specific structured action result" }),
    ),
    events: Type.Array(EventSummary),
  },
  { additionalProperties: false },
);
export type ActionReceipt = Static<typeof ActionReceipt>;

export const InstallationDiscovery = Type.Object(
  {
    installationId: Identifier,
    name: Type.String(),
    apiVersions: Type.Array(Type.Literal("v1")),
    authIssuer: Type.String({ format: "uri" }),
    registration: Type.Union([
      Type.Literal("open"),
      Type.Literal("invite"),
      Type.Literal("closed"),
    ]),
    defaultWorldId: Type.Optional(Identifier),
    device_authorization_endpoint: Type.String({ format: "uri" }),
    token_endpoint: Type.String({ format: "uri" }),
  },
  { additionalProperties: false },
);
export type InstallationDiscovery = Static<typeof InstallationDiscovery>;

export const WorldSummary = Type.Object(
  {
    id: Identifier,
    name: Type.String(),
    seasonNumber: Type.Integer({ minimum: 1 }),
    state: Type.Union([
      Type.Literal("scheduled"),
      Type.Literal("active"),
      Type.Literal("finalizing"),
      Type.Literal("archived"),
    ]),
    startsAt: Type.String({ format: "date-time" }),
    endsAt: Type.String({ format: "date-time" }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    rulesetHash: Type.String(),
  },
  { additionalProperties: false },
);
export type WorldSummary = Static<typeof WorldSummary>;

export const PlayerSummary = Type.Object(
  {
    id: Identifier,
    civilizationId: Identifier,
    name: UntrustedText,
    position: Coordinates,
    trustTier: Type.Integer({ minimum: 0, maximum: 2 }),
    influence: SafeInteger,
    allianceId: Type.Optional(Identifier),
  },
  { additionalProperties: false },
);
export type PlayerSummary = Static<typeof PlayerSummary>;

export const PlayerStatus = Type.Object(
  {
    player: PlayerSummary,
    resources: Resources,
    transferable: Resources,
    tick: SafeInteger,
    cooldowns: Type.Record(Type.String(), Type.String({ format: "date-time" })),
    activeConstructions: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PlayerStatus = Static<typeof PlayerStatus>;

export const InventoryResponse = Type.Object(
  {
    total: Resources,
    transferable: Resources,
    bound: Resources,
    escrowed: Resources,
    tick: SafeInteger,
  },
  { additionalProperties: false },
);
export type InventoryResponse = Static<typeof InventoryResponse>;

export const InfluenceBreakdown = Type.Object(
  {
    territory: SafeInteger,
    structures: SafeInteger,
    economy: SafeInteger,
    combat: SafeInteger,
    total: SafeInteger,
  },
  { additionalProperties: false },
);
export type InfluenceBreakdown = Static<typeof InfluenceBreakdown>;

export const LeaderboardEntry = Type.Object(
  {
    rank: Type.Integer({ minimum: 1 }),
    playerId: Identifier,
    name: UntrustedText,
    allianceId: Type.Optional(Identifier),
    influence: InfluenceBreakdown,
  },
  { additionalProperties: false },
);
export type LeaderboardEntry = Static<typeof LeaderboardEntry>;

export const StructureView = Type.Object(
  {
    id: Identifier,
    ownerPlayerId: Identifier,
    kind: StructureKind,
    status: Type.Union([
      Type.Literal("constructing"),
      Type.Literal("active"),
      Type.Literal("destroyed"),
    ]),
    hitPoints: Type.Integer({ minimum: 0 }),
    maxHitPoints: Type.Integer({ minimum: 1 }),
    completesAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);
export type StructureView = Static<typeof StructureView>;

export const TileView = Type.Object(
  {
    coordinates: Coordinates,
    terrain: Terrain,
    zone: Zone,
    richness: Resources,
    discovered: Type.Boolean(),
    visible: Type.Boolean(),
    structure: Type.Optional(StructureView),
    players: Type.Array(PlayerSummary),
  },
  { additionalProperties: false },
);
export type TileView = Static<typeof TileView>;

export const LookResponse = Type.Object(
  {
    origin: Coordinates,
    radius: Type.Integer({ minimum: 1 }),
    tick: SafeInteger,
    tiles: Type.Array(TileView),
  },
  { additionalProperties: false, $id: "LookResponse" },
);
export type LookResponse = Static<typeof LookResponse>;

export const ScanActionReceipt = Type.Object(
  {
    ...Type.Omit(ActionReceipt, ["result"]).properties,
    result: LookResponse,
  },
  { additionalProperties: false },
);
export type ScanActionReceipt = Static<typeof ScanActionReceipt>;

export const SpawnRequest = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 40 }),
  },
  { additionalProperties: false },
);
export type SpawnRequest = Static<typeof SpawnRequest>;

export const MoveRequest = Type.Object({ direction: Direction }, { additionalProperties: false });
export type MoveRequest = Static<typeof MoveRequest>;

export const BuildRequest = Type.Object(
  { structure: StructureKind },
  { additionalProperties: false },
);
export type BuildRequest = Static<typeof BuildRequest>;

export const HarvestRequest = Type.Object(
  { resource: Type.Optional(ResourceKind) },
  { additionalProperties: false },
);
export type HarvestRequest = Static<typeof HarvestRequest>;

export const ScanRequest = Type.Object({}, { additionalProperties: false });
export type ScanRequest = Static<typeof ScanRequest>;

export const AttackRequest = Type.Object(
  {
    targetStructureId: Identifier,
    // The active ruleset owns the upper bound and rejects excess with INVALID_BONUS.
    bonusInference: Type.Optional(SafeInteger),
  },
  { additionalProperties: false },
);
export type AttackRequest = Static<typeof AttackRequest>;

export const MessageView = Type.Object(
  {
    id: Identifier,
    senderPlayerId: Identifier,
    recipientPlayerId: Type.Optional(Identifier),
    allianceId: Type.Optional(Identifier),
    body: UntrustedText,
    sentAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type MessageView = Static<typeof MessageView>;

export const MessageSendReceipt = Type.Omit(MessageView, ["body"], {
  additionalProperties: false,
});
export type MessageSendReceipt = Static<typeof MessageSendReceipt>;

export const SendMessageRequest = Type.Object(
  {
    recipientPlayerId: Type.Optional(Identifier),
    allianceId: Type.Optional(Identifier),
    body: Type.String({ minLength: 1, maxLength: 4_000 }),
  },
  { additionalProperties: false },
);
export type SendMessageRequest = Static<typeof SendMessageRequest>;

export const ModerationState = Type.Object(
  {
    playerId: Identifier,
    blocked: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ModerationState = Static<typeof ModerationState>;

export const MuteState = Type.Object(
  {
    channelId: Type.String({ minLength: 1, maxLength: 191 }),
    muted: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MuteState = Static<typeof MuteState>;

export const ReportRequest = Type.Object(
  {
    reportedPlayerId: Identifier,
    messageId: Type.Optional(Identifier),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type ReportRequest = Static<typeof ReportRequest>;

export const ReportReceipt = Type.Object(
  { id: Identifier, accepted: Type.Literal(true) },
  { additionalProperties: false },
);
export type ReportReceipt = Static<typeof ReportReceipt>;

export const TradeOfferRequest = Type.Object(
  {
    recipientPlayerId: Identifier,
    offered: Resources,
    requested: Resources,
  },
  { additionalProperties: false },
);
export type TradeOfferRequest = Static<typeof TradeOfferRequest>;

export const TradeView = Type.Object(
  {
    id: Identifier,
    senderPlayerId: Identifier,
    recipientPlayerId: Identifier,
    offered: Resources,
    requested: Resources,
    state: Type.Union([
      Type.Literal("open"),
      Type.Literal("accepted"),
      Type.Literal("cancelled"),
      Type.Literal("expired"),
    ]),
    expiresAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type TradeView = Static<typeof TradeView>;

export const AllianceCreateRequest = Type.Object(
  { name: Type.String({ minLength: 2, maxLength: 40 }) },
  { additionalProperties: false },
);
export type AllianceCreateRequest = Static<typeof AllianceCreateRequest>;

export const AllianceInviteRequest = Type.Object(
  { playerId: Identifier },
  { additionalProperties: false },
);
export type AllianceInviteRequest = Static<typeof AllianceInviteRequest>;

export const AllianceInviteResponse = Type.Object(
  {
    inviteId: Identifier,
    expiresAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type AllianceInviteResponse = Static<typeof AllianceInviteResponse>;

export const AllianceInviteAcceptResponse = Type.Object(
  {
    accepted: Type.Literal(true),
    allianceId: Identifier,
  },
  { additionalProperties: false },
);
export type AllianceInviteAcceptResponse = Static<typeof AllianceInviteAcceptResponse>;

export const AllianceAdministrationOperation = Type.Union([
  Type.Literal("leave"),
  Type.Literal("leadership"),
  Type.Literal("disband"),
]);
export type AllianceAdministrationOperation = Static<typeof AllianceAdministrationOperation>;

export const AllianceAdministrationResponse = Type.Object(
  {
    ok: Type.Literal(true),
    operation: AllianceAdministrationOperation,
    allianceId: Identifier,
    // Present only for leadership transfers, naming the new leader.
    playerId: Type.Optional(Identifier),
  },
  { additionalProperties: false },
);
export type AllianceAdministrationResponse = Static<typeof AllianceAdministrationResponse>;

export const AllianceView = Type.Object(
  {
    id: Identifier,
    name: UntrustedText,
    leaderPlayerId: Identifier,
    memberPlayerIds: Type.Array(Identifier, { maxItems: 20 }),
    influence: SafeInteger,
  },
  { additionalProperties: false },
);
export type AllianceView = Static<typeof AllianceView>;

export const Page = <T extends ReturnType<typeof Type.Object>>(item: T) =>
  Type.Object(
    {
      items: Type.Array(item),
      nextCursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  );

export const LeaderboardResponse = Page(LeaderboardEntry);
export type LeaderboardResponse = Static<typeof LeaderboardResponse>;

export const WorldListResponse = Page(WorldSummary);
export type WorldListResponse = Static<typeof WorldListResponse>;

export const MapResponse = Page(TileView);
export type MapResponse = Static<typeof MapResponse>;

export const PlayerListResponse = Page(PlayerSummary);
export type PlayerListResponse = Static<typeof PlayerListResponse>;

export const EventPageResponse = Page(EventSummary);
export type EventPageResponse = Static<typeof EventPageResponse>;

export const MessagePageResponse = Page(MessageView);
export type MessagePageResponse = Static<typeof MessagePageResponse>;

export const TradePageResponse = Page(TradeView);
export type TradePageResponse = Static<typeof TradePageResponse>;

export const AllianceListResponse = Page(AllianceView);
export type AllianceListResponse = Static<typeof AllianceListResponse>;

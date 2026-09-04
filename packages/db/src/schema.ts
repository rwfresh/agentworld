import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export type Timestamp = Date;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonColumn<T extends Json = Json> = ColumnType<T, T, T>;

export interface InstallationsTable {
  id: string;
  name: string;
  createdAt: Generated<Timestamp>;
}

export interface WorldsTable {
  id: string;
  homeServerId: string;
  name: string;
  seasonNumber: number;
  state: "scheduled" | "active" | "finalizing" | "archived";
  startsAt: Timestamp;
  endsAt: Timestamp;
  width: number;
  height: number;
  seed: string;
  ruleset: JsonColumn;
  rulesetHash: string;
  maxPlayers: number;
  createdAt: Generated<Timestamp>;
  archivedAt: Timestamp | null;
}

export interface RegionsTable {
  id: string;
  worldId: string;
  authorityServerId: string;
  regionX: number;
  regionY: number;
  createdAt: Generated<Timestamp>;
}

export interface StarterPlotsTable {
  id: string;
  worldId: string;
  plotIndex: number;
  originX: number;
  originY: number;
  playerId: string | null;
  allocatedAt: Timestamp | null;
}

export interface TilesTable {
  id: string;
  worldId: string;
  regionId: string;
  x: number;
  y: number;
  terrain: "plains" | "forest" | "hills" | "wetlands";
  zone: "safe" | "contested" | "frontier";
  energyRichness: number;
  materialsRichness: number;
  inferenceRichness: number;
  starterPlotId: string | null;
}

export interface CivilizationsTable {
  id: string;
  userId: string;
  name: string;
  trustTier: Generated<number>;
  reputation: Generated<number>;
  successfulMutations: Generated<number>;
  earnedResources: Generated<number>;
  createdAt: Generated<Timestamp>;
  suspendedAt: Timestamp | null;
}

export interface PlayersTable {
  id: string;
  worldId: string;
  civilizationId: string;
  name: string;
  positionX: number;
  positionY: number;
  starterPlotId: string;
  allianceId: string | null;
  influence: Generated<number>;
  successfulMutations: Generated<number>;
  completedStructures: Generated<number>;
  earnedEnergy: Generated<number>;
  earnedMaterials: Generated<number>;
  earnedInference: Generated<number>;
  combatInfluence: Generated<number>;
  spawnedAt: Generated<Timestamp>;
  lastSeenAt: Generated<Timestamp>;
}

export interface InventoriesTable {
  playerId: string;
  worldId: string;
  boundEnergy: number;
  boundMaterials: number;
  boundInference: number;
  energy: number;
  materials: number;
  inference: number;
  escrowEnergy: Generated<number>;
  escrowMaterials: Generated<number>;
  escrowInference: Generated<number>;
  energyRate: Generated<number>;
  materialsRate: Generated<number>;
  inferenceRate: Generated<number>;
  lastSettledAt: Timestamp;
  producedEnergy: Generated<number>;
  producedMaterials: Generated<number>;
  producedInference: Generated<number>;
  version: Generated<number>;
}

export interface DiscoveredTilesTable {
  worldId: string;
  playerId: string;
  tileId: string;
  discoveredAt: Generated<Timestamp>;
}

export interface StructuresTable {
  id: string;
  worldId: string;
  tileId: string;
  ownerPlayerId: string;
  kind: "command_node" | "generator" | "extractor" | "compute_node" | "defense_node";
  status: "constructing" | "active" | "destroyed";
  hitPoints: number;
  maxHitPoints: number;
  createdAt: Generated<Timestamp>;
  completesAt: Timestamp | null;
  activatedAt: Timestamp | null;
  destroyedAt: Timestamp | null;
  lastProductionAt: Timestamp;
  productionRemainderTicks: Generated<number>;
  version: Generated<number>;
}

export interface CombatAwardWindowsTable {
  worldId: string;
  playerId: string;
  opponentPlayerId: string;
  startedAt: Timestamp;
  influence: number;
}

export interface CooldownsTable {
  worldId: string;
  playerId: string;
  action: string;
  availableAt: Timestamp;
}

export interface ActionsTable {
  id: string;
  worldId: string;
  playerId: string;
  idempotencyKey: string;
  requestHash: string;
  actionType: string;
  state: "processing" | "completed" | "failed";
  response: JsonColumn | null;
  createdAt: Generated<Timestamp>;
  completedAt: Timestamp | null;
}

export interface EventsTable {
  offset: Generated<number>;
  id: string;
  worldId: string;
  emittingServerId: string;
  actionId: string | null;
  actorPlayerId: string | null;
  /** The player the event was done to; the feed delivers the row to them as well as the actor. */
  targetPlayerId: string | null;
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  tick: number;
  rulesetHash: string;
  payloadVersion: number;
  visibility: "public" | "player" | "alliance" | "operator";
  payload: JsonColumn;
  occurredAt: Generated<Timestamp>;
}

export interface ResourceLedgerTable {
  id: string;
  worldId: string;
  playerId: string;
  actionId: string | null;
  reason: string;
  energyDelta: number;
  materialsDelta: number;
  inferenceDelta: number;
  createdAt: Generated<Timestamp>;
}

export interface AlliancesTable {
  id: string;
  worldId: string;
  name: string;
  leaderPlayerId: string;
  influence: Generated<number>;
  createdAt: Generated<Timestamp>;
  disbandedAt: Timestamp | null;
}

export interface AllianceMembersTable {
  worldId: string;
  allianceId: string;
  playerId: string;
  role: "leader" | "member";
  joinedAt: Generated<Timestamp>;
  leftAt: Timestamp | null;
}

export interface AllianceInvitesTable {
  id: string;
  worldId: string;
  allianceId: string;
  playerId: string;
  invitedByPlayerId: string;
  state: "pending" | "accepted" | "declined" | "expired";
  expiresAt: Timestamp;
  createdAt: Generated<Timestamp>;
}

export interface HostilitiesTable {
  worldId: string;
  aggressorPlayerId: string;
  defenderPlayerId: string;
  declaredAt: Timestamp;
  activeAt: Timestamp;
  withdrawnAt: Timestamp | null;
  retaliationEndsAt: Timestamp | null;
}

export interface MessagesTable {
  id: string;
  worldId: string;
  senderPlayerId: string;
  recipientPlayerId: string | null;
  allianceId: string | null;
  body: string;
  contentHash: string;
  sentAt: Generated<Timestamp>;
  deletedAt: Timestamp | null;
}

export interface PlayerBlocksTable {
  worldId: string;
  blockerPlayerId: string;
  blockedPlayerId: string;
  createdAt: Generated<Timestamp>;
}

export interface MessageMutesTable {
  worldId: string;
  playerId: string;
  channelId: string;
  createdAt: Generated<Timestamp>;
}

export interface ReportsTable {
  id: string;
  worldId: string;
  reporterPlayerId: string;
  messageId: string | null;
  reportedPlayerId: string;
  reason: string;
  state: "open" | "resolved" | "dismissed";
  createdAt: Generated<Timestamp>;
  resolvedAt: Timestamp | null;
}

export interface TradesTable {
  id: string;
  worldId: string;
  senderPlayerId: string;
  recipientPlayerId: string;
  offered: JsonColumn;
  requested: JsonColumn;
  state: "open" | "accepted" | "cancelled" | "expired";
  expiresAt: Timestamp;
  createdAt: Generated<Timestamp>;
  resolvedAt: Timestamp | null;
}

export interface InvitationsTable {
  id: string;
  codeHash: string;
  maxUses: number;
  uses: Generated<number>;
  expiresAt: Timestamp | null;
  createdBy: string;
  createdAt: Generated<Timestamp>;
  revokedAt: Timestamp | null;
}

export interface InvitationReservationsTable {
  id: string;
  invitationId: string;
  /** SHA-256 hex digest of the normalized email; the plaintext address is never persisted here. */
  emailHash: string;
  reservedAt: Generated<Timestamp>;
  expiresAt: Timestamp;
}

export interface SecurityAuditTable {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: JsonColumn;
  createdAt: Generated<Timestamp>;
}

export interface SeasonFinalizationsTable {
  worldId: string;
  finalTick: number;
  cutoffAt: Timestamp;
  rulesetHash: string;
  finalizedAt: Timestamp;
}

export interface SeasonPlayerRankingsTable {
  worldId: string;
  playerId: string;
  allianceId: string | null;
  rank: number;
  territoryInfluence: number;
  structureInfluence: number;
  economyInfluence: number;
  combatInfluence: number;
  totalInfluence: number;
  scoreReachedAt: Timestamp;
  finalizedAt: Timestamp;
  rulesetHash: string;
}

export interface SeasonAllianceRankingsTable {
  worldId: string;
  allianceId: string;
  rank: number;
  totalInfluence: number;
  memberCount: number;
  scoreReachedAt: Timestamp;
  finalizedAt: Timestamp;
  rulesetHash: string;
}

export interface Database {
  installations: InstallationsTable;
  worlds: WorldsTable;
  regions: RegionsTable;
  starterPlots: StarterPlotsTable;
  tiles: TilesTable;
  civilizations: CivilizationsTable;
  players: PlayersTable;
  inventories: InventoriesTable;
  discoveredTiles: DiscoveredTilesTable;
  structures: StructuresTable;
  combatAwardWindows: CombatAwardWindowsTable;
  cooldowns: CooldownsTable;
  actions: ActionsTable;
  events: EventsTable;
  resourceLedger: ResourceLedgerTable;
  alliances: AlliancesTable;
  allianceMembers: AllianceMembersTable;
  allianceInvites: AllianceInvitesTable;
  hostilities: HostilitiesTable;
  messages: MessagesTable;
  playerBlocks: PlayerBlocksTable;
  messageMutes: MessageMutesTable;
  reports: ReportsTable;
  trades: TradesTable;
  invitations: InvitationsTable;
  invitationReservations: InvitationReservationsTable;
  securityAudit: SecurityAuditTable;
  seasonFinalizations: SeasonFinalizationsTable;
  seasonPlayerRankings: SeasonPlayerRankingsTable;
  seasonAllianceRankings: SeasonAllianceRankingsTable;
}

export type World = Selectable<WorldsTable>;
export type NewWorld = Insertable<WorldsTable>;
export type Player = Selectable<PlayersTable>;
export type PlayerUpdate = Updateable<PlayersTable>;
export type Inventory = Selectable<InventoriesTable>;
export type Structure = Selectable<StructuresTable>;
export type Tile = Selectable<TilesTable>;
export type Trade = Selectable<TradesTable>;
export type Invitation = Selectable<InvitationsTable>;
export type InvitationReservation = Selectable<InvitationReservationsTable>;
export type Event = Selectable<EventsTable>;
export type SeasonFinalization = Selectable<SeasonFinalizationsTable>;
export type SeasonPlayerRanking = Selectable<SeasonPlayerRankingsTable>;
export type SeasonAllianceRanking = Selectable<SeasonAllianceRankingsTable>;

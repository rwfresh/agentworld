import {
  addResources,
  canAfford,
  creditTransferable,
  debitResources,
  emptyResources,
  type ResourceKind,
  type ResourceVector,
  resourceForKind,
  resources,
} from "./resources.ts";
import type { Ruleset, StructureType } from "./ruleset.ts";
import { combatPower, trustTierAt } from "./scoring.ts";
import type {
  CivilizationState,
  CombatAwardWindow,
  GameSnapshot,
  HostilityState,
  StructureState,
} from "./state.ts";
import {
  type Coordinate,
  coordinateKey,
  type Direction,
  isCardinallyAdjacent,
  manhattanDistance,
  moveCoordinate,
  type PlayerId,
  type StructureId,
  sameCoordinate,
  type Tick,
  tick,
} from "./types.ts";
import {
  coordinatesWithinRadius,
  isInsideWorld,
  type Tile,
  tileAt,
  uniqueCoordinates,
  zoneAt,
} from "./world.ts";

export type ViolationCode =
  | "PLAYER_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "OUT_OF_BOUNDS"
  | "COOLDOWN_ACTIVE"
  | "INSUFFICIENT_RESOURCES"
  | "TILE_OCCUPIED"
  | "BUILD_LOCATION_INVALID"
  | "CONSTRUCTION_LIMIT_REACHED"
  | "STRUCTURE_TYPE_INVALID"
  | "CONSTRUCTION_NOT_READY"
  | "NOT_STRUCTURE_OWNER"
  | "HOSTILITY_NOT_FOUND"
  | "HOSTILITY_NOT_ACTIVE"
  | "HOSTILITY_WARMUP"
  | "ALREADY_HOSTILE"
  | "TARGET_NOT_ADJACENT"
  | "SAFE_ZONE"
  | "ALLIED_TARGET"
  | "SELF_TARGET"
  | "INVALID_BONUS"
  | "TARGET_DESTROYED"
  | "TRUST_REQUIRED";

export interface RuleViolation {
  readonly code: ViolationCode;
  readonly message: string;
  readonly retryAtTick?: Tick;
}

export interface SignedResourceVector {
  readonly energy: number;
  readonly materials: number;
  readonly inference: number;
}

interface EventBase {
  readonly tick: Tick;
  readonly actorId: PlayerId;
}

export type DomainEvent =
  | (EventBase & {
      readonly type: "PLAYER_MOVED";
      readonly from: Coordinate;
      readonly to: Coordinate;
      readonly energyCost: number;
    })
  | (EventBase & {
      readonly type: "CONSTRUCTION_STARTED";
      readonly structureId: StructureId;
      readonly structureType: StructureType;
      readonly coordinate: Coordinate;
      readonly completionTick: Tick;
    })
  | (EventBase & {
      readonly type: "CONSTRUCTION_COMPLETED";
      readonly structureId: StructureId;
      readonly structureType: StructureType;
    })
  | (EventBase & {
      readonly type: "RESOURCES_PRODUCED";
      readonly resources: ResourceVector;
    })
  | (EventBase & {
      readonly type: "RESOURCES_HARVESTED";
      readonly resource: ResourceKind;
      readonly amount: number;
      readonly coordinate: Coordinate;
    })
  | (EventBase & {
      readonly type: "AREA_SCANNED";
      readonly center: Coordinate;
      readonly radius: number;
      readonly revealedTileKeys: readonly string[];
    })
  | (EventBase & {
      readonly type: "HOSTILITY_DECLARED";
      readonly defenderId: PlayerId;
      readonly attacksAllowedAtTick: Tick;
    })
  | (EventBase & {
      readonly type: "HOSTILITY_WITHDRAWN";
      readonly defenderId: PlayerId;
      readonly retaliationEndsAtTick: Tick;
    })
  | (EventBase & {
      readonly type: "STRUCTURE_ATTACKED";
      readonly targetStructureId: StructureId;
      readonly damage: number;
      readonly remainingHp: number;
    })
  | (EventBase & {
      readonly type: "STRUCTURE_DESTROYED";
      readonly targetStructureId: StructureId;
      readonly formerOwnerId: PlayerId;
    })
  | (EventBase & {
      readonly type: "COMBAT_INFLUENCE_AWARDED";
      readonly opponentId: PlayerId;
      readonly amount: number;
    });

interface CommandBase {
  readonly actorId: PlayerId;
}

export type GameCommand =
  | (CommandBase & { readonly type: "move"; readonly direction: Direction })
  | (CommandBase & {
      readonly type: "build";
      readonly structureId: StructureId;
      readonly structureType: StructureType;
    })
  | (CommandBase & {
      readonly type: "complete-construction";
      readonly structureId: StructureId;
    })
  | (CommandBase & { readonly type: "harvest"; readonly resource?: ResourceKind })
  | (CommandBase & { readonly type: "scan" })
  | (CommandBase & { readonly type: "declare-hostility"; readonly defenderId: PlayerId })
  | (CommandBase & { readonly type: "withdraw-hostility"; readonly defenderId: PlayerId })
  | (CommandBase & {
      readonly type: "attack";
      readonly targetStructureId: StructureId;
      readonly bonusInference?: number;
    });

export interface DecisionSuccess {
  readonly ok: true;
  readonly effectiveTick: Tick;
  readonly state: GameSnapshot;
  readonly events: readonly DomainEvent[];
  readonly resourceChange: SignedResourceVector;
  readonly completionTick?: Tick;
}

export interface DecisionFailure {
  readonly ok: false;
  readonly violation: RuleViolation;
}

export type Decision = DecisionSuccess | DecisionFailure;

export interface ProductionSettlement {
  readonly state: GameSnapshot;
  readonly produced: ResourceVector;
  readonly events: readonly DomainEvent[];
}

export interface LookResult {
  readonly center: Coordinate;
  readonly tiles: readonly Tile[];
  readonly structures: readonly StructureState[];
}

const signed = (energy = 0, materials = 0, inference = 0): SignedResourceVector => ({
  energy,
  materials,
  inference,
});

const signedFrom = (vector: ResourceVector, multiplier = 1): SignedResourceVector =>
  signed(vector.energy * multiplier, vector.materials * multiplier, vector.inference * multiplier);

const addSigned = (left: SignedResourceVector, right: SignedResourceVector): SignedResourceVector =>
  signed(
    left.energy + right.energy,
    left.materials + right.materials,
    left.inference + right.inference,
  );

const failure = (code: ViolationCode, message: string, retryAtTick?: Tick): DecisionFailure => ({
  ok: false,
  violation: retryAtTick === undefined ? { code, message } : { code, message, retryAtTick },
});

function success(
  effectiveTick: Tick,
  state: GameSnapshot,
  events: readonly DomainEvent[],
  resourceChange: SignedResourceVector,
  completionTick?: Tick,
): DecisionSuccess {
  return completionTick === undefined
    ? { ok: true, effectiveTick, state, events, resourceChange }
    : { ok: true, effectiveTick, state, events, resourceChange, completionTick };
}

function replacePlayer(snapshot: GameSnapshot, player: CivilizationState): GameSnapshot {
  return {
    ...snapshot,
    players: snapshot.players.map((candidate) => (candidate.id === player.id ? player : candidate)),
  };
}

function replaceStructure(snapshot: GameSnapshot, structure: StructureState): GameSnapshot {
  return {
    ...snapshot,
    structures: snapshot.structures.map((candidate) =>
      candidate.id === structure.id ? structure : candidate,
    ),
  };
}

function creditEarned(player: CivilizationState, credit: ResourceVector): CivilizationState {
  return {
    ...player,
    inventory: creditTransferable(player.inventory, credit),
    earnedResources: addResources(player.earnedResources, credit),
  };
}

function discover(
  player: CivilizationState,
  coordinates: readonly Coordinate[],
): CivilizationState {
  const keys = new Set(player.discoveredTileKeys);
  for (const value of coordinates) keys.add(coordinateKey(value));
  return { ...player, discoveredTileKeys: [...keys] };
}

function mutated(player: CivilizationState): CivilizationState {
  return { ...player, successfulMutations: player.successfulMutations + 1 };
}

function findPlayer(snapshot: GameSnapshot, id: PlayerId): CivilizationState | undefined {
  return snapshot.players.find((candidate) => candidate.id === id);
}

function cooldownRetry(lastTick: Tick | undefined, duration: number, now: Tick): Tick | undefined {
  if (lastTick === undefined) return undefined;
  const available = tick(lastTick + duration);
  return now < available ? available : undefined;
}

export function settlePassiveProduction(
  snapshot: GameSnapshot,
  ownerId: PlayerId,
  effectiveTick: Tick,
  ruleset: Ruleset,
): ProductionSettlement {
  const initialPlayer = findPlayer(snapshot, ownerId);
  if (initialPlayer === undefined) throw new RangeError("player not found");
  let produced = emptyResources();
  let changed = false;
  const structures = snapshot.structures.map((structure): StructureState => {
    if (structure.ownerId !== ownerId || structure.status !== "active") return structure;
    const production = ruleset.structures[structure.type].production;
    if (production === undefined) return structure;
    const elapsed = effectiveTick - structure.lastProductionTick;
    if (elapsed < 0) throw new RangeError("effective tick predates production state");
    const creditedElapsed = Math.min(elapsed, ruleset.production.offlineCapTicks);
    const accumulated = structure.productionRemainderTicks + creditedElapsed;
    const intervals = Math.floor(accumulated / ruleset.production.intervalTicks);
    const remainder = accumulated % ruleset.production.intervalTicks;
    const richness = tileAt(snapshot.world, structure.coordinate, ruleset).richness[
      production.resource
    ];
    const credit = resourceForKind(production.resource, production.amount * richness * intervals);
    produced = addResources(produced, credit);
    changed = changed || elapsed > 0;
    return {
      ...structure,
      lastProductionTick: effectiveTick,
      productionRemainderTicks: remainder,
    };
  });
  if (!changed) return { state: snapshot, produced, events: [] };
  const player = creditEarned(initialPlayer, produced);
  const state = {
    ...snapshot,
    players: snapshot.players.map((value) => (value.id === ownerId ? player : value)),
    structures,
  };
  const hasProduction = produced.energy + produced.materials + produced.inference > 0;
  return {
    state,
    produced,
    events: hasProduction
      ? [{ type: "RESOURCES_PRODUCED", tick: effectiveTick, actorId: ownerId, resources: produced }]
      : [],
  };
}

export function look(
  snapshot: GameSnapshot,
  actorId: PlayerId,
  ruleset: Ruleset,
): LookResult | RuleViolation {
  const player = findPlayer(snapshot, actorId);
  if (player === undefined) return { code: "PLAYER_NOT_FOUND", message: "player not found" };
  const coordinates = coordinatesWithinRadius(snapshot.world, player.position, ruleset.look.radius);
  const visibleKeys = new Set(coordinates.map(coordinateKey));
  return {
    center: player.position,
    tiles: coordinates.map((value) => tileAt(snapshot.world, value, ruleset)),
    structures: snapshot.structures.filter(
      (structure) =>
        structure.status !== "destroyed" && visibleKeys.has(coordinateKey(structure.coordinate)),
    ),
  };
}

export function projectPlayerAt(
  snapshot: GameSnapshot,
  actorId: PlayerId,
  effectiveTick: Tick,
  ruleset: Ruleset,
): CivilizationState | RuleViolation {
  if (findPlayer(snapshot, actorId) === undefined) {
    return { code: "PLAYER_NOT_FOUND", message: "player not found" };
  }
  const projected = settlePassiveProduction(snapshot, actorId, effectiveTick, ruleset);
  const player = findPlayer(projected.state, actorId);
  if (player === undefined) throw new Error("settlement removed the player");
  return player;
}

function prepare(
  snapshot: GameSnapshot,
  actorId: PlayerId,
  effectiveTick: Tick,
  ruleset: Ruleset,
): ProductionSettlement | DecisionFailure {
  if (findPlayer(snapshot, actorId) === undefined) {
    return failure("PLAYER_NOT_FOUND", "player not found");
  }
  return settlePassiveProduction(snapshot, actorId, effectiveTick, ruleset);
}

function decideMove(
  command: Extract<GameCommand, { type: "move" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const player = findPlayer(prepared.state, command.actorId);
  if (player === undefined) throw new Error("prepared player is missing");
  const retryAt = cooldownRetry(
    player.cooldowns.movedAtTick,
    ruleset.movement.cooldownTicks,
    effectiveTick,
  );
  if (retryAt !== undefined) return failure("COOLDOWN_ACTIVE", "movement is cooling down", retryAt);
  const destination = moveCoordinate(player.position, command.direction);
  if (!isInsideWorld(prepared.state.world, destination)) {
    return failure("OUT_OF_BOUNDS", "movement would leave the world");
  }
  const blocking = prepared.state.structures.some(
    (structure) =>
      structure.ownerId !== player.id &&
      structure.status !== "destroyed" &&
      sameCoordinate(structure.coordinate, destination) &&
      isActivelyHostile(prepared.state.hostilities, player.id, structure.ownerId),
  );
  if (blocking) return failure("TILE_OCCUPIED", "a hostile structure blocks movement");
  const destinationTile = tileAt(prepared.state.world, destination, ruleset);
  const cost = resources(ruleset.movement.terrainEnergyCost[destinationTile.terrain], 0, 0);
  if (!canAfford(player.inventory, cost)) {
    return failure("INSUFFICIENT_RESOURCES", "not enough energy to move");
  }
  const debit = debitResources(player.inventory, cost);
  const revealed = coordinatesWithinRadius(prepared.state.world, destination, ruleset.look.radius);
  const updated = mutated(
    discover(
      {
        ...player,
        position: destination,
        inventory: debit.inventory,
        cooldowns: { ...player.cooldowns, movedAtTick: effectiveTick },
      },
      revealed,
    ),
  );
  const state = replacePlayer(prepared.state, updated);
  const event: DomainEvent = {
    type: "PLAYER_MOVED",
    tick: effectiveTick,
    actorId: player.id,
    from: player.position,
    to: destination,
    energyCost: cost.energy,
  };
  return success(
    effectiveTick,
    state,
    [...prepared.events, event],
    addSigned(signedFrom(prepared.produced), signedFrom(cost, -1)),
  );
}

function isBuildLocationValid(
  snapshot: GameSnapshot,
  player: CivilizationState,
  target: Coordinate,
): boolean {
  if (
    snapshot.players.some(
      (candidate) =>
        candidate.id !== player.id &&
        candidate.homePlot.some((coordinate) => sameCoordinate(coordinate, target)),
    )
  ) {
    return false;
  }
  if (player.homePlot.some((value) => sameCoordinate(value, target))) return true;
  return snapshot.structures.some(
    (structure) =>
      structure.ownerId === player.id &&
      structure.status !== "destroyed" &&
      isCardinallyAdjacent(structure.coordinate, target),
  );
}

function decideBuild(
  command: Extract<GameCommand, { type: "build" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const player = findPlayer(prepared.state, command.actorId);
  if (player === undefined) throw new Error("prepared player is missing");
  const rule = ruleset.structures[command.structureType];
  if (rule.starterOnly === true) {
    return failure("STRUCTURE_TYPE_INVALID", "command nodes can only be granted at spawn");
  }
  if (
    prepared.state.structures.some(
      (structure) =>
        structure.status !== "destroyed" && sameCoordinate(structure.coordinate, player.position),
    )
  ) {
    return failure("TILE_OCCUPIED", "the current tile already contains a structure");
  }
  if (!isBuildLocationValid(prepared.state, player, player.position)) {
    return failure("BUILD_LOCATION_INVALID", "build on a home tile or beside owned territory");
  }
  const constructions = prepared.state.structures.filter(
    (structure) => structure.ownerId === player.id && structure.status === "constructing",
  ).length;
  if (constructions >= ruleset.construction.concurrentLimit) {
    return failure("CONSTRUCTION_LIMIT_REACHED", "too many simultaneous constructions");
  }
  if (prepared.state.structures.some((structure) => structure.id === command.structureId)) {
    return failure("TILE_OCCUPIED", "structure ID is already in use");
  }
  if (!canAfford(player.inventory, rule.cost)) {
    return failure("INSUFFICIENT_RESOURCES", "not enough resources to build");
  }
  const debit = debitResources(player.inventory, rule.cost);
  const completionTick = tick(effectiveTick + rule.buildTimeTicks);
  const structure: StructureState = {
    id: command.structureId,
    ownerId: player.id,
    type: command.structureType,
    coordinate: player.position,
    status: "constructing",
    hp: Math.ceil(rule.maxHp / 2),
    constructionCompleteTick: completionTick,
    lastProductionTick: effectiveTick,
    productionRemainderTicks: 0,
  };
  const updated = mutated({ ...player, inventory: debit.inventory });
  const state: GameSnapshot = {
    ...replacePlayer(prepared.state, updated),
    structures: [...prepared.state.structures, structure],
  };
  const event: DomainEvent = {
    type: "CONSTRUCTION_STARTED",
    tick: effectiveTick,
    actorId: player.id,
    structureId: structure.id,
    structureType: structure.type,
    coordinate: structure.coordinate,
    completionTick,
  };
  return success(
    effectiveTick,
    state,
    [...prepared.events, event],
    addSigned(signedFrom(prepared.produced), signedFrom(rule.cost, -1)),
    completionTick,
  );
}

function decideCompleteConstruction(
  command: Extract<GameCommand, { type: "complete-construction" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const player = findPlayer(prepared.state, command.actorId);
  const structure = prepared.state.structures.find((value) => value.id === command.structureId);
  if (player === undefined) throw new Error("prepared player is missing");
  if (structure === undefined) return failure("TARGET_NOT_FOUND", "structure not found");
  if (structure.ownerId !== player.id) {
    return failure("NOT_STRUCTURE_OWNER", "only the owner can complete construction");
  }
  if (structure.status !== "constructing") {
    return failure("CONSTRUCTION_NOT_READY", "structure is not under construction");
  }
  const completion = structure.constructionCompleteTick;
  if (completion === undefined || effectiveTick < completion) {
    return failure("CONSTRUCTION_NOT_READY", "construction is not finished", completion);
  }
  const completed: StructureState = {
    id: structure.id,
    ownerId: structure.ownerId,
    type: structure.type,
    coordinate: structure.coordinate,
    status: "active",
    hp: ruleset.structures[structure.type].maxHp,
    lastProductionTick: effectiveTick,
    productionRemainderTicks: 0,
  };
  const updated: CivilizationState = {
    ...player,
    completedStructures: player.completedStructures + 1,
  };
  let state = replaceStructure(prepared.state, completed);
  state = replacePlayer(state, updated);
  const event: DomainEvent = {
    type: "CONSTRUCTION_COMPLETED",
    tick: effectiveTick,
    actorId: player.id,
    structureId: completed.id,
    structureType: completed.type,
  };
  return success(effectiveTick, state, [...prepared.events, event], signedFrom(prepared.produced));
}

function decideHarvest(
  command: Extract<GameCommand, { type: "harvest" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const player = findPlayer(prepared.state, command.actorId);
  if (player === undefined) throw new Error("prepared player is missing");
  const retryAt = cooldownRetry(
    player.cooldowns.harvestedAtTick,
    ruleset.harvest.cooldownTicks,
    effectiveTick,
  );
  if (retryAt !== undefined) return failure("COOLDOWN_ACTIVE", "harvest is cooling down", retryAt);
  const cost = resources(ruleset.harvest.energyCost, 0, 0);
  if (!canAfford(player.inventory, cost)) {
    return failure("INSUFFICIENT_RESOURCES", "not enough energy to harvest");
  }
  const currentTile = tileAt(prepared.state.world, player.position, ruleset);
  const kind = command.resource ?? currentTile.dominantResource;
  const amount = ruleset.harvest.baseYield * currentTile.richness[kind];
  const credit = resourceForKind(kind, amount);
  const debit = debitResources(player.inventory, cost);
  const credited = creditEarned({ ...player, inventory: debit.inventory }, credit);
  const updated = mutated({
    ...credited,
    cooldowns: { ...credited.cooldowns, harvestedAtTick: effectiveTick },
  });
  const state = replacePlayer(prepared.state, updated);
  const event: DomainEvent = {
    type: "RESOURCES_HARVESTED",
    tick: effectiveTick,
    actorId: player.id,
    resource: kind,
    amount,
    coordinate: player.position,
  };
  return success(
    effectiveTick,
    state,
    [...prepared.events, event],
    addSigned(addSigned(signedFrom(prepared.produced), signedFrom(cost, -1)), signedFrom(credit)),
  );
}

function decideScan(
  command: Extract<GameCommand, { type: "scan" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const player = findPlayer(prepared.state, command.actorId);
  if (player === undefined) throw new Error("prepared player is missing");
  const retryAt = cooldownRetry(
    player.cooldowns.scannedAtTick,
    ruleset.scan.cooldownTicks,
    effectiveTick,
  );
  if (retryAt !== undefined) return failure("COOLDOWN_ACTIVE", "scan is cooling down", retryAt);
  const cost = resources(0, 0, ruleset.scan.inferenceCost);
  if (!canAfford(player.inventory, cost)) {
    return failure("INSUFFICIENT_RESOURCES", "not enough inference to scan");
  }
  const debit = debitResources(player.inventory, cost);
  const revealed = coordinatesWithinRadius(
    prepared.state.world,
    player.position,
    ruleset.scan.radius,
  );
  const updated = mutated(
    discover(
      {
        ...player,
        inventory: debit.inventory,
        cooldowns: { ...player.cooldowns, scannedAtTick: effectiveTick },
      },
      revealed,
    ),
  );
  const state = replacePlayer(prepared.state, updated);
  const event: DomainEvent = {
    type: "AREA_SCANNED",
    tick: effectiveTick,
    actorId: player.id,
    center: player.position,
    radius: ruleset.scan.radius,
    revealedTileKeys: revealed.map(coordinateKey),
  };
  return success(
    effectiveTick,
    state,
    [...prepared.events, event],
    addSigned(signedFrom(prepared.produced), signedFrom(cost, -1)),
  );
}

function sameAlliance(left: CivilizationState, right: CivilizationState): boolean {
  return left.allianceId !== undefined && left.allianceId === right.allianceId;
}

function isActivelyHostile(
  hostilities: readonly HostilityState[],
  left: PlayerId,
  right: PlayerId,
): boolean {
  return hostilities.some(
    (hostility) =>
      hostility.withdrawnAtTick === undefined &&
      ((hostility.aggressorId === left && hostility.defenderId === right) ||
        (hostility.aggressorId === right && hostility.defenderId === left)),
  );
}

function decideDeclareHostility(
  command: Extract<GameCommand, { type: "declare-hostility" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const actor = findPlayer(prepared.state, command.actorId);
  const defender = findPlayer(prepared.state, command.defenderId);
  if (actor === undefined) throw new Error("prepared player is missing");
  if (defender === undefined) return failure("TARGET_NOT_FOUND", "defender not found");
  if (actor.id === defender.id) return failure("SELF_TARGET", "a player cannot target itself");
  if (sameAlliance(actor, defender))
    return failure("ALLIED_TARGET", "allies cannot declare hostility");
  if (trustTierAt(actor, effectiveTick, ruleset) < 2) {
    return failure("TRUST_REQUIRED", "trust tier 2 is required to initiate hostility");
  }
  const existing = prepared.state.hostilities.find(
    (value) => value.aggressorId === actor.id && value.defenderId === defender.id,
  );
  if (existing?.withdrawnAtTick === undefined && existing !== undefined) {
    return failure("ALREADY_HOSTILE", "hostility is already active");
  }
  const hostility: HostilityState = {
    aggressorId: actor.id,
    defenderId: defender.id,
    declaredAtTick: effectiveTick,
  };
  const state: GameSnapshot = {
    ...replacePlayer(prepared.state, mutated(actor)),
    hostilities: [
      ...prepared.state.hostilities.filter(
        (value) => !(value.aggressorId === actor.id && value.defenderId === defender.id),
      ),
      hostility,
    ],
  };
  const attacksAllowedAtTick = tick(effectiveTick + ruleset.combat.hostilityWarmupTicks);
  const event: DomainEvent = {
    type: "HOSTILITY_DECLARED",
    tick: effectiveTick,
    actorId: actor.id,
    defenderId: defender.id,
    attacksAllowedAtTick,
  };
  return success(effectiveTick, state, [...prepared.events, event], signedFrom(prepared.produced));
}

function decideWithdrawHostility(
  command: Extract<GameCommand, { type: "withdraw-hostility" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const actor = findPlayer(prepared.state, command.actorId);
  if (actor === undefined) throw new Error("prepared player is missing");
  const existing = prepared.state.hostilities.find(
    (value) =>
      value.aggressorId === actor.id &&
      value.defenderId === command.defenderId &&
      value.withdrawnAtTick === undefined,
  );
  if (existing === undefined) return failure("HOSTILITY_NOT_FOUND", "active hostility not found");
  const withdrawn: HostilityState = { ...existing, withdrawnAtTick: effectiveTick };
  const state: GameSnapshot = {
    ...replacePlayer(prepared.state, mutated(actor)),
    hostilities: prepared.state.hostilities.map((value) =>
      value === existing ? withdrawn : value,
    ),
  };
  const retaliationEndsAtTick = tick(
    effectiveTick + ruleset.combat.retaliationAfterWithdrawalTicks,
  );
  const event: DomainEvent = {
    type: "HOSTILITY_WITHDRAWN",
    tick: effectiveTick,
    actorId: actor.id,
    defenderId: command.defenderId,
    retaliationEndsAtTick,
  };
  return success(effectiveTick, state, [...prepared.events, event], signedFrom(prepared.produced));
}

type AttackPermission =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly violation: RuleViolation };

function attackPermission(
  hostilities: readonly HostilityState[],
  actorId: PlayerId,
  targetId: PlayerId,
  effectiveTick: Tick,
  ruleset: Ruleset,
): AttackPermission {
  const actorDeclaration = hostilities.find(
    (value) => value.aggressorId === actorId && value.defenderId === targetId,
  );
  if (actorDeclaration?.withdrawnAtTick === undefined && actorDeclaration !== undefined) {
    const allowedAt = tick(actorDeclaration.declaredAtTick + ruleset.combat.hostilityWarmupTicks);
    return effectiveTick >= allowedAt
      ? { allowed: true }
      : {
          allowed: false,
          violation: {
            code: "HOSTILITY_WARMUP",
            message: "aggressor hostility warmup is active",
            retryAtTick: allowedAt,
          },
        };
  }
  const targetDeclaration = hostilities.find(
    (value) => value.aggressorId === targetId && value.defenderId === actorId,
  );
  if (targetDeclaration !== undefined) {
    if (targetDeclaration.withdrawnAtTick === undefined) return { allowed: true };
    const retaliationEnds = tick(
      targetDeclaration.withdrawnAtTick + ruleset.combat.retaliationAfterWithdrawalTicks,
    );
    if (effectiveTick <= retaliationEnds) return { allowed: true };
  }
  return {
    allowed: false,
    violation: { code: "HOSTILITY_NOT_ACTIVE", message: "no hostility permits this attack" },
  };
}

function updateCombatAward(
  player: CivilizationState,
  opponentId: PlayerId,
  effectiveTick: Tick,
  ruleset: Ruleset,
): readonly [CivilizationState, number] {
  const existing = player.combatAwardWindows.find((window) => window.opponentId === opponentId);
  const current =
    existing === undefined ||
    effectiveTick - existing.startedAtTick >= ruleset.combat.influenceWindowTicks
      ? { opponentId, startedAtTick: effectiveTick, influence: 0 }
      : existing;
  const remaining = Math.max(0, ruleset.combat.influencePerOpponentWindow - current.influence);
  const award = Math.min(ruleset.combat.influencePerDestruction, remaining);
  const updatedWindow: CombatAwardWindow = { ...current, influence: current.influence + award };
  return [
    {
      ...player,
      combatInfluence: player.combatInfluence + award,
      combatAwardWindows: [
        ...player.combatAwardWindows.filter((window) => window.opponentId !== opponentId),
        updatedWindow,
      ],
    },
    award,
  ];
}

function decideAttack(
  command: Extract<GameCommand, { type: "attack" }>,
  snapshot: GameSnapshot,
  effectiveTick: Tick,
  ruleset: Ruleset,
): Decision {
  const prepared = prepare(snapshot, command.actorId, effectiveTick, ruleset);
  if ("ok" in prepared) return prepared;
  const actor = findPlayer(prepared.state, command.actorId);
  let target = prepared.state.structures.find((value) => value.id === command.targetStructureId);
  if (actor === undefined) throw new Error("prepared player is missing");
  if (target === undefined) return failure("TARGET_NOT_FOUND", "target structure not found");
  if (target.ownerId === actor.id) return failure("SELF_TARGET", "a player cannot attack itself");
  if (target.status === "destroyed")
    return failure("TARGET_DESTROYED", "target is already destroyed");
  const defender = findPlayer(prepared.state, target.ownerId);
  if (defender === undefined) return failure("TARGET_NOT_FOUND", "target owner not found");
  if (sameAlliance(actor, defender))
    return failure("ALLIED_TARGET", "allies cannot attack each other");
  if (!isCardinallyAdjacent(actor.position, target.coordinate)) {
    return failure("TARGET_NOT_ADJACENT", "target structure must be cardinally adjacent");
  }
  if (zoneAt(prepared.state.world, target.coordinate, ruleset) === "starter") {
    return failure("SAFE_ZONE", "structures in starter plots cannot be attacked");
  }
  const bonus = command.bonusInference ?? 0;
  if (!Number.isSafeInteger(bonus) || bonus < 0 || bonus > ruleset.combat.maxBonusInference) {
    return failure(
      "INVALID_BONUS",
      `bonus inference must be between 0 and ${ruleset.combat.maxBonusInference}`,
    );
  }
  const retryAt = cooldownRetry(
    actor.cooldowns.attackedAtTick,
    ruleset.combat.attackCooldownTicks,
    effectiveTick,
  );
  if (retryAt !== undefined) return failure("COOLDOWN_ACTIVE", "attack is cooling down", retryAt);
  const permission = attackPermission(
    prepared.state.hostilities,
    actor.id,
    defender.id,
    effectiveTick,
    ruleset,
  );
  if (!permission.allowed) return { ok: false, violation: permission.violation };
  // A producer keeps everything earned before the hit that destroys it.
  const defenderSettlement = settlePassiveProduction(
    prepared.state,
    defender.id,
    effectiveTick,
    ruleset,
  );
  const combatState = defenderSettlement.state;
  target = combatState.structures.find((value) => value.id === command.targetStructureId);
  if (target === undefined) throw new Error("defender settlement removed the target structure");
  const cost = resources(ruleset.combat.energyCost, 0, ruleset.combat.inferenceCost + bonus);
  if (!canAfford(actor.inventory, cost)) {
    return failure("INSUFFICIENT_RESOURCES", "not enough resources to attack");
  }
  const defended = combatState.structures.some(
    (structure) =>
      structure.ownerId === defender.id &&
      structure.type === "defense-node" &&
      structure.status === "active" &&
      manhattanDistance(structure.coordinate, target.coordinate) <= 1,
  );
  const rawDamage = ruleset.combat.baseDamage + bonus * ruleset.combat.damagePerBonusInference;
  const damage = Math.max(
    ruleset.combat.minimumDamage,
    rawDamage - (defended ? ruleset.combat.defenseReduction : 0),
  );
  const remainingHp = Math.max(0, target.hp - damage);
  const destroyed = remainingHp === 0;
  const attacked: StructureState = {
    ...target,
    hp: remainingHp,
    status: destroyed ? "destroyed" : target.status,
  };
  const debit = debitResources(actor.inventory, cost);
  let updatedActor = mutated({
    ...actor,
    inventory: debit.inventory,
    cooldowns: { ...actor.cooldowns, attackedAtTick: effectiveTick },
  });
  const events: DomainEvent[] = [
    ...prepared.events,
    ...defenderSettlement.events,
    {
      type: "STRUCTURE_ATTACKED",
      tick: effectiveTick,
      actorId: actor.id,
      targetStructureId: target.id,
      damage,
      remainingHp,
    },
  ];
  if (destroyed) {
    events.push({
      type: "STRUCTURE_DESTROYED",
      tick: effectiveTick,
      actorId: actor.id,
      targetStructureId: target.id,
      formerOwnerId: defender.id,
    });
    const attackerPower = combatPower(combatState, actor.id, ruleset);
    const defenderPower = combatPower(combatState, defender.id, ruleset);
    const eligible = defenderPower >= attackerPower * ruleset.combat.weakOpponentPowerRatio;
    if (eligible) {
      const awardResult = updateCombatAward(updatedActor, defender.id, effectiveTick, ruleset);
      updatedActor = awardResult[0];
      if (awardResult[1] > 0) {
        events.push({
          type: "COMBAT_INFLUENCE_AWARDED",
          tick: effectiveTick,
          actorId: actor.id,
          opponentId: defender.id,
          amount: awardResult[1],
        });
      }
    }
  }
  let state = replaceStructure(combatState, attacked);
  state = replacePlayer(state, updatedActor);
  return success(
    effectiveTick,
    state,
    events,
    addSigned(signedFrom(prepared.produced), signedFrom(cost, -1)),
  );
}

export function decide(
  command: GameCommand,
  snapshot: GameSnapshot,
  ruleset: Ruleset,
  effectiveTick: Tick,
): Decision {
  switch (command.type) {
    case "move":
      return decideMove(command, snapshot, effectiveTick, ruleset);
    case "build":
      return decideBuild(command, snapshot, effectiveTick, ruleset);
    case "complete-construction":
      return decideCompleteConstruction(command, snapshot, effectiveTick, ruleset);
    case "harvest":
      return decideHarvest(command, snapshot, effectiveTick, ruleset);
    case "scan":
      return decideScan(command, snapshot, effectiveTick, ruleset);
    case "declare-hostility":
      return decideDeclareHostility(command, snapshot, effectiveTick, ruleset);
    case "withdraw-hostility":
      return decideWithdrawHostility(command, snapshot, effectiveTick, ruleset);
    case "attack":
      return decideAttack(command, snapshot, effectiveTick, ruleset);
  }
}

export function revealedCoordinates(player: CivilizationState): readonly Coordinate[] {
  return uniqueCoordinates(
    player.discoveredTileKeys.map((key) => {
      const [xText, yText] = key.split(",");
      const x = Number(xText);
      const y = Number(yText);
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
        throw new RangeError(`invalid discovered coordinate key: ${key}`);
      }
      return { x, y };
    }),
  );
}

export const resourceDeltaTotal = (change: SignedResourceVector): number =>
  change.energy + change.materials + change.inference;

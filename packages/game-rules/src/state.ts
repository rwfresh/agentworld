import { emptyResources, type Inventory, type ResourceVector, resources } from "./resources.ts";
import type { Ruleset, StructureType } from "./ruleset.ts";
import {
  type AllianceId,
  type Coordinate,
  coordinateKey,
  type PlayerId,
  type StructureId,
  type Tick,
} from "./types.ts";
import type { StarterPlot, WorldDescriptor } from "./world.ts";

export type TrustTier = 0 | 1 | 2;
export type StructureStatus = "constructing" | "active" | "destroyed";

export interface Cooldowns {
  readonly movedAtTick?: Tick;
  readonly scannedAtTick?: Tick;
  readonly harvestedAtTick?: Tick;
  readonly attackedAtTick?: Tick;
}

export interface CombatAwardWindow {
  readonly opponentId: PlayerId;
  readonly startedAtTick: Tick;
  readonly influence: number;
}

export interface CivilizationState {
  readonly id: PlayerId;
  readonly position: Coordinate;
  readonly homePlot: readonly Coordinate[];
  readonly inventory: Inventory;
  readonly discoveredTileKeys: readonly string[];
  readonly cooldowns: Cooldowns;
  readonly joinedAtTick: Tick;
  readonly successfulMutations: number;
  readonly completedStructures: number;
  readonly earnedResources: ResourceVector;
  readonly combatInfluence: number;
  readonly combatAwardWindows: readonly CombatAwardWindow[];
  readonly persistentTrustTier: TrustTier;
  readonly allianceId?: AllianceId;
}

export interface StructureState {
  readonly id: StructureId;
  readonly ownerId: PlayerId;
  readonly type: StructureType;
  readonly coordinate: Coordinate;
  readonly status: StructureStatus;
  readonly hp: number;
  readonly constructionCompleteTick?: Tick;
  readonly lastProductionTick: Tick;
  readonly productionRemainderTicks: number;
}

export interface HostilityState {
  readonly aggressorId: PlayerId;
  readonly defenderId: PlayerId;
  readonly declaredAtTick: Tick;
  readonly withdrawnAtTick?: Tick;
}

export interface GameSnapshot {
  readonly world: WorldDescriptor;
  readonly players: readonly CivilizationState[];
  readonly structures: readonly StructureState[];
  readonly hostilities: readonly HostilityState[];
}

export interface StarterStructureIds {
  readonly commandNode: StructureId;
  readonly generator: StructureId;
  readonly extractor: StructureId;
}

export function createStartingCivilization(
  id: PlayerId,
  plot: StarterPlot,
  joinedAtTick: Tick,
  startingResources: ResourceVector,
  persistentTrustTier: TrustTier = 0,
): CivilizationState {
  if (plot.tiles.length < 4) {
    throw new RangeError("a starter plot must contain at least four tiles");
  }
  const position = plot.tiles[3];
  if (position === undefined) throw new Error("starter position is missing");
  return {
    id,
    position,
    homePlot: plot.tiles,
    inventory: { bound: startingResources, transferable: emptyResources() },
    discoveredTileKeys: plot.tiles.map(coordinateKey),
    cooldowns: {},
    joinedAtTick,
    successfulMutations: 0,
    completedStructures: 0,
    earnedResources: emptyResources(),
    combatInfluence: 0,
    combatAwardWindows: [],
    persistentTrustTier,
  };
}

export function createStarterStructures(
  ownerId: PlayerId,
  plot: StarterPlot,
  ids: StarterStructureIds,
  createdAtTick: Tick,
  ruleset: Ruleset,
): readonly StructureState[] {
  const commandCoordinate = plot.tiles[0];
  const generatorCoordinate = plot.tiles[1];
  const extractorCoordinate = plot.tiles[2];
  if (
    commandCoordinate === undefined ||
    generatorCoordinate === undefined ||
    extractorCoordinate === undefined
  ) {
    throw new RangeError("a starter plot must contain at least three tiles");
  }
  const active = (
    id: StructureId,
    type: StructureType,
    coordinate: Coordinate,
    hp: number,
  ): StructureState => ({
    id,
    ownerId,
    type,
    coordinate,
    status: "active",
    hp,
    lastProductionTick: createdAtTick,
    productionRemainderTicks: 0,
  });
  return [
    active(
      ids.commandNode,
      "command-node",
      commandCoordinate,
      ruleset.structures["command-node"].maxHp,
    ),
    active(ids.generator, "generator", generatorCoordinate, ruleset.structures.generator.maxHp),
    active(ids.extractor, "extractor", extractorCoordinate, ruleset.structures.extractor.maxHp),
  ];
}

export function withTransferableResources(
  player: CivilizationState,
  energy: number,
  materials: number,
  inference: number,
): CivilizationState {
  return {
    ...player,
    inventory: { ...player.inventory, transferable: resources(energy, materials, inference) },
  };
}

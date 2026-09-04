import type { ResourceKind } from "./resources.ts";
import type { Ruleset, Terrain } from "./ruleset.ts";
import {
  type Coordinate,
  coordinate,
  coordinateKey,
  type PlayerId,
  type WorldId,
} from "./types.ts";

export type WorldZone = "starter" | "contested" | "frontier";

export interface WorldDescriptor {
  readonly id: WorldId;
  readonly seed: string;
  readonly width: number;
  readonly height: number;
}

export interface ResourceRichness {
  readonly energy: number;
  readonly materials: number;
  readonly inference: number;
}

export interface Tile {
  readonly coordinate: Coordinate;
  readonly region: Coordinate;
  readonly terrain: Terrain;
  readonly zone: WorldZone;
  readonly richness: ResourceRichness;
  readonly dominantResource: ResourceKind;
}

export interface StarterPlot {
  readonly slot: number;
  readonly ownerId?: PlayerId;
  readonly origin: Coordinate;
  readonly tiles: readonly Coordinate[];
}

export function createWorldDescriptor(
  id: WorldId,
  seed: string,
  ruleset: Ruleset,
): WorldDescriptor {
  if (seed.length === 0) {
    throw new RangeError("world seed must not be empty");
  }
  return { id, seed, width: ruleset.map.width, height: ruleset.map.height };
}

export function isInsideWorld(world: WorldDescriptor, target: Coordinate): boolean {
  return target.x >= 0 && target.y >= 0 && target.x < world.width && target.y < world.height;
}

function centeredSquareContains(
  world: WorldDescriptor,
  target: Coordinate,
  squareSize: number,
): boolean {
  const minimumX = Math.floor((world.width - squareSize) / 2);
  const minimumY = Math.floor((world.height - squareSize) / 2);
  return (
    target.x >= minimumX &&
    target.x < minimumX + squareSize &&
    target.y >= minimumY &&
    target.y < minimumY + squareSize
  );
}

export function zoneAt(world: WorldDescriptor, target: Coordinate, ruleset: Ruleset): WorldZone {
  if (!isInsideWorld(world, target)) {
    throw new RangeError("coordinate is outside the world");
  }
  if (centeredSquareContains(world, target, ruleset.map.starterReserveSize)) {
    return "starter";
  }
  if (centeredSquareContains(world, target, ruleset.map.contestedSize)) {
    return "contested";
  }
  return "frontier";
}

/** Stable 32-bit FNV-1a hash. It intentionally does not depend on runtime random state. */
export function deterministicHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashAt(world: WorldDescriptor, target: Coordinate, salt: string): number {
  return deterministicHash(`${world.seed}:${target.x}:${target.y}:${salt}`);
}

function terrainAt(world: WorldDescriptor, target: Coordinate): Terrain {
  const roll = hashAt(world, target, "terrain") % 100;
  if (roll < 50) return "plains";
  if (roll < 75) return "forest";
  if (roll < 90) return "hills";
  return "wetlands";
}

function richnessFor(
  world: WorldDescriptor,
  target: Coordinate,
  zone: WorldZone,
  resource: ResourceKind,
): number {
  if (zone === "starter") return 1;
  const low = zone === "contested" ? 1 : 2;
  return low + (hashAt(world, target, `richness:${resource}`) % 2);
}

function dominantResourceAt(
  world: WorldDescriptor,
  target: Coordinate,
  richness: ResourceRichness,
): ResourceKind {
  const kinds = ["energy", "materials", "inference"] as const;
  const maximum = Math.max(richness.energy, richness.materials, richness.inference);
  const tied = kinds.filter((kind) => richness[kind] === maximum);
  const selected = tied[hashAt(world, target, "dominant") % tied.length];
  if (selected === undefined) {
    throw new Error("a tile must have a dominant resource");
  }
  return selected;
}

export function tileAt(world: WorldDescriptor, target: Coordinate, ruleset: Ruleset): Tile {
  if (ruleset.generation.algorithm !== "fnv1a-32-v1") {
    throw new RangeError(`unsupported map generator: ${ruleset.generation.algorithm}`);
  }
  const zone = zoneAt(world, target, ruleset);
  const richness: ResourceRichness = {
    energy: richnessFor(world, target, zone, "energy"),
    materials: richnessFor(world, target, zone, "materials"),
    inference: richnessFor(world, target, zone, "inference"),
  };
  return {
    coordinate: target,
    region: coordinate(
      Math.floor(target.x / ruleset.map.regionSize),
      Math.floor(target.y / ruleset.map.regionSize),
    ),
    terrain: terrainAt(world, target),
    zone,
    richness,
    dominantResource: dominantResourceAt(world, target, richness),
  };
}

export function generateWorldTiles(world: WorldDescriptor, ruleset: Ruleset): readonly Tile[] {
  const tiles: Tile[] = [];
  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      tiles.push(tileAt(world, coordinate(x, y), ruleset));
    }
  }
  return tiles;
}

interface StarterPlotLayout {
  readonly plotSize: number;
  readonly plotsPerRow: number;
  readonly usedRows: number;
  readonly reserveX: number;
  readonly reserveY: number;
  /** Plot rows are centered vertically inside the reserve when fewer rows than columns are used. */
  readonly centeredRowOffset: number;
}

function starterPlotLayout(world: WorldDescriptor, ruleset: Ruleset): StarterPlotLayout {
  const plotSize = ruleset.map.starterPlotSize;
  const plotsPerRow = Math.floor(ruleset.map.starterReserveSize / plotSize);
  const usedRows = Math.ceil(ruleset.map.maxStarterPlots / plotsPerRow);
  return {
    plotSize,
    plotsPerRow,
    usedRows,
    reserveX: Math.floor((world.width - ruleset.map.starterReserveSize) / 2),
    reserveY: Math.floor((world.height - ruleset.map.starterReserveSize) / 2),
    centeredRowOffset: Math.floor((plotsPerRow - usedRows) / 2),
  };
}

export function starterPlotForSlot(
  world: WorldDescriptor,
  slot: number,
  ruleset: Ruleset,
  ownerId?: PlayerId,
): StarterPlot {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= ruleset.map.maxStarterPlots) {
    throw new RangeError(
      `starter plot slot must be between 0 and ${ruleset.map.maxStarterPlots - 1}`,
    );
  }
  const layout = starterPlotLayout(world, ruleset);
  const origin = coordinate(
    layout.reserveX + (slot % layout.plotsPerRow) * layout.plotSize,
    layout.reserveY +
      (Math.floor(slot / layout.plotsPerRow) + layout.centeredRowOffset) * layout.plotSize,
  );
  const tiles: Coordinate[] = [];
  for (let y = 0; y < layout.plotSize; y += 1) {
    for (let x = 0; x < layout.plotSize; x += 1) {
      tiles.push(coordinate(origin.x + x, origin.y + y));
    }
  }
  return ownerId === undefined ? { slot, origin, tiles } : { slot, ownerId, origin, tiles };
}

/**
 * The inverse of `starterPlotForSlot`: the slot whose plot contains the tile, whether or not that
 * slot has been allocated. Reserve tiles outside the plot rows and tiles outside the reserve have
 * no slot.
 */
export function starterPlotSlotAt(
  world: WorldDescriptor,
  target: Coordinate,
  ruleset: Ruleset,
): number | undefined {
  const layout = starterPlotLayout(world, ruleset);
  const column = Math.floor((target.x - layout.reserveX) / layout.plotSize);
  const row = Math.floor((target.y - layout.reserveY) / layout.plotSize) - layout.centeredRowOffset;
  if (column < 0 || column >= layout.plotsPerRow || row < 0 || row >= layout.usedRows) {
    return undefined;
  }
  const slot = row * layout.plotsPerRow + column;
  return slot < ruleset.map.maxStarterPlots ? slot : undefined;
}

export function coordinatesWithinRadius(
  world: WorldDescriptor,
  center: Coordinate,
  radius: number,
): readonly Coordinate[] {
  if (!Number.isSafeInteger(radius) || radius < 0) {
    throw new RangeError("radius must be a non-negative integer");
  }
  // Clamp to the world before iterating so a large radius costs at most one pass over the map.
  const minimumX = Math.max(0, center.x - radius);
  const maximumX = Math.min(world.width - 1, center.x + radius);
  const minimumY = Math.max(0, center.y - radius);
  const maximumY = Math.min(world.height - 1, center.y + radius);
  const result: Coordinate[] = [];
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      if (Math.abs(x - center.x) + Math.abs(y - center.y) <= radius) {
        result.push(coordinate(x, y));
      }
    }
  }
  return result;
}

export function uniqueCoordinates(coordinates: readonly Coordinate[]): readonly Coordinate[] {
  const byKey = new Map<string, Coordinate>();
  for (const value of coordinates) byKey.set(coordinateKey(value), value);
  return [...byKey.values()];
}

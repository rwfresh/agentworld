declare const brand: unique symbol;

/** A nominal type used to keep identifiers from being accidentally interchanged. */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type WorldId = Brand<string, "WorldId">;
export type PlayerId = Brand<string, "PlayerId">;
export type StructureId = Brand<string, "StructureId">;
export type AllianceId = Brand<string, "AllianceId">;
export type Tick = Brand<number, "Tick">;
export type ResourceAmount = Brand<number, "ResourceAmount">;

function brandedId<Name extends string>(value: string, name: Name): Brand<string, Name> {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new RangeError(`${name} must contain between 1 and 128 characters`);
  }
  return normalized as Brand<string, Name>;
}

export const worldId = (value: string): WorldId => brandedId(value, "WorldId");
export const playerId = (value: string): PlayerId => brandedId(value, "PlayerId");
export const structureId = (value: string): StructureId => brandedId(value, "StructureId");
export const allianceId = (value: string): AllianceId => brandedId(value, "AllianceId");

export function tick(value: number): Tick {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("tick must be a non-negative safe integer");
  }
  return value as Tick;
}

export function resourceAmount(value: number): ResourceAmount {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("resource amount must be a non-negative safe integer");
  }
  return value as ResourceAmount;
}

export interface Coordinate {
  readonly x: number;
  readonly y: number;
}

export function coordinate(x: number, y: number): Coordinate {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new RangeError("coordinates must be safe integers");
  }
  return { x, y };
}

export const coordinateKey = ({ x, y }: Coordinate): string => `${x},${y}`;

export const sameCoordinate = (left: Coordinate, right: Coordinate): boolean =>
  left.x === right.x && left.y === right.y;

export const manhattanDistance = (left: Coordinate, right: Coordinate): number =>
  Math.abs(left.x - right.x) + Math.abs(left.y - right.y);

export const isCardinallyAdjacent = (left: Coordinate, right: Coordinate): boolean =>
  manhattanDistance(left, right) === 1;

export type Direction = "north" | "east" | "south" | "west";

export function moveCoordinate(origin: Coordinate, direction: Direction): Coordinate {
  switch (direction) {
    case "north":
      return coordinate(origin.x, origin.y - 1);
    case "east":
      return coordinate(origin.x + 1, origin.y);
    case "south":
      return coordinate(origin.x, origin.y + 1);
    case "west":
      return coordinate(origin.x - 1, origin.y);
  }
}

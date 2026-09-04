import type { Json } from "@agentworld/db";
import {
  BETA_V1_RULESET,
  coordinate,
  createWorldDescriptor,
  type GameSnapshot,
  playerId,
  resources,
  structureId,
  tick,
  tileAt,
  worldId,
} from "@agentworld/game-rules";
import { describe, expect, it } from "vitest";

import { parseTradeResources, settleProductionThroughTick } from "./season-finalization.ts";

describe("settleProductionThroughTick", () => {
  it("settles every capped chunk through cutoff without discarding old production", () => {
    const ownerId = playerId("00000000-0000-8000-a000-000000000001");
    const world = createWorldDescriptor(
      worldId("00000000-0000-8000-a000-000000000002"),
      "season-finalization-test",
      BETA_V1_RULESET,
    );
    const location = coordinate(0, 0);
    const snapshot: GameSnapshot = {
      world,
      players: [
        {
          id: ownerId,
          position: location,
          homePlot: [],
          inventory: { bound: resources(), transferable: resources() },
          discoveredTileKeys: [],
          cooldowns: {},
          joinedAtTick: tick(0),
          successfulMutations: 0,
          completedStructures: 0,
          earnedResources: resources(),
          combatInfluence: 0,
          combatAwardWindows: [],
          persistentTrustTier: 0,
        },
      ],
      structures: [
        {
          id: structureId("00000000-0000-8000-a000-000000000003"),
          ownerId,
          type: "generator",
          coordinate: location,
          status: "active",
          hp: BETA_V1_RULESET.structures.generator.maxHp,
          lastProductionTick: tick(0),
          productionRemainderTicks: 0,
        },
      ],
      hostilities: [],
    };
    const finalTick = tick(BETA_V1_RULESET.production.offlineCapTicks * 3);
    const result = settleProductionThroughTick(snapshot, finalTick, BETA_V1_RULESET);
    const intervals = finalTick / BETA_V1_RULESET.production.intervalTicks;
    const richness = tileAt(world, location, BETA_V1_RULESET).richness.energy;
    const production = BETA_V1_RULESET.structures.generator.production;
    if (production === undefined) throw new Error("generator production rule is missing");
    const expectedEnergy = intervals * production.amount * richness;

    expect(result.producedByPlayer.get(ownerId)?.energy).toBe(expectedEnergy);
    expect(result.snapshot.players[0]?.inventory.transferable.energy).toBe(expectedEnergy);
    expect(result.snapshot.players[0]?.earnedResources.energy).toBe(expectedEnergy);
    expect(result.snapshot.structures[0]?.lastProductionTick).toBe(finalTick);
    expect(result.snapshot.structures[0]?.productionRemainderTicks).toBe(0);
  });

  it("rejects a production cursor beyond the immutable cutoff", () => {
    const ownerId = playerId("00000000-0000-8000-a000-000000000004");
    const world = createWorldDescriptor(
      worldId("00000000-0000-8000-a000-000000000005"),
      "invalid-cursor-test",
      BETA_V1_RULESET,
    );
    const snapshot: GameSnapshot = {
      world,
      players: [
        {
          id: ownerId,
          position: coordinate(1, 1),
          homePlot: [],
          inventory: { bound: resources(), transferable: resources() },
          discoveredTileKeys: [],
          cooldowns: {},
          joinedAtTick: tick(0),
          successfulMutations: 0,
          completedStructures: 0,
          earnedResources: resources(),
          combatInfluence: 0,
          combatAwardWindows: [],
          persistentTrustTier: 0,
        },
      ],
      structures: [
        {
          id: structureId("00000000-0000-8000-a000-000000000006"),
          ownerId,
          type: "generator",
          coordinate: coordinate(1, 1),
          status: "active",
          hp: 100,
          lastProductionTick: tick(601),
          productionRemainderTicks: 0,
        },
      ],
      hostilities: [],
    };

    expect(() => settleProductionThroughTick(snapshot, tick(600), BETA_V1_RULESET)).toThrow(
      /beyond the season cutoff/,
    );
  });
});

describe("parseTradeResources", () => {
  it("accepts a nonnegative safe-integer vector", () => {
    expect(parseTradeResources({ energy: 5, materials: 0, inference: 2 })).toEqual({
      energy: 5,
      materials: 0,
      inference: 2,
    });
  });

  const rejected: ReadonlyArray<readonly [string, Json]> = [
    ["a negative component", { energy: -5, materials: 0, inference: 0 }],
    ["a fractional component", { energy: 1.5, materials: 0, inference: 0 }],
    ["an unsafe integer", { energy: Number.MAX_SAFE_INTEGER + 1, materials: 0, inference: 0 }],
    ["a missing component", { energy: 1, materials: 0 }],
    ["a string component", { energy: "5", materials: 0, inference: 0 }],
    ["an array", [5, 0, 0]],
    ["null", null],
  ];
  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => parseTradeResources(value)).toThrow(/invalid offered resource vector/);
    });
  }
});

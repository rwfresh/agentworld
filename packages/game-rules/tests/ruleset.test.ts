import { describe, expect, it } from "vitest";

import {
  BETA_V1_RULESET,
  canAfford,
  debitResources,
  inventoryTotal,
  playerId,
  resourceAmount,
  resources,
  tick,
  validateRuleset,
} from "../src/index.ts";

describe("beta-v1 ruleset", () => {
  it("contains the agreed beta balance", () => {
    expect(BETA_V1_RULESET.generation.algorithm).toBe("fnv1a-32-v1");
    expect(BETA_V1_RULESET.map).toMatchObject({
      width: 192,
      height: 192,
      regionSize: 16,
      starterReserveSize: 64,
      maxStarterPlots: 512,
    });
    expect(BETA_V1_RULESET.startingResources).toEqual(resources(100, 100, 50));
    expect(BETA_V1_RULESET.structures.generator).toMatchObject({
      cost: resources(10, 60, 0),
      buildTimeTicks: 120,
      maxHp: 100,
      production: { resource: "energy", amount: 5 },
      influence: 10,
    });
    expect(BETA_V1_RULESET.structures.extractor).toMatchObject({
      cost: resources(20, 75, 0),
      buildTimeTicks: 180,
      maxHp: 120,
      production: { resource: "materials", amount: 3 },
      influence: 15,
    });
    expect(BETA_V1_RULESET.structures["compute-node"]).toMatchObject({
      cost: resources(40, 80, 0),
      buildTimeTicks: 300,
      maxHp: 90,
      production: { resource: "inference", amount: 2 },
      influence: 20,
    });
    expect(BETA_V1_RULESET.structures["defense-node"]).toMatchObject({
      cost: resources(60, 120, 20),
      buildTimeTicks: 480,
      maxHp: 180,
      influence: 25,
    });
    expect(validateRuleset(BETA_V1_RULESET)).toEqual([]);
  });
});

describe("resource arithmetic", () => {
  it("spends non-transferable starter resources before transferable resources", () => {
    const inventory = {
      bound: resources(100, 30, 0),
      transferable: resources(10, 100, 20),
    };
    expect(canAfford(inventory, resources(105, 60, 10))).toBe(true);
    const result = debitResources(inventory, resources(105, 60, 10));
    expect(result.inventory.bound).toEqual(resources(0, 0, 0));
    expect(result.inventory.transferable).toEqual(resources(5, 70, 10));
    expect(result.spentBound).toEqual(resources(100, 30, 0));
    expect(inventoryTotal(result.inventory)).toEqual(resources(5, 70, 10));
  });

  it("rejects negative, fractional, and unsafe resource amounts", () => {
    expect(() => resourceAmount(-1)).toThrow(RangeError);
    expect(() => resourceAmount(1.5)).toThrow(RangeError);
    expect(() => resourceAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("domain primitives", () => {
  it("brands normalized non-empty IDs and non-negative integer ticks", () => {
    expect(playerId("  player-7  ")).toBe("player-7");
    expect(() => playerId("   ")).toThrow(RangeError);
    expect(tick(0)).toBe(0);
    expect(() => tick(-1)).toThrow(RangeError);
    expect(() => tick(0.5)).toThrow(RangeError);
  });
});

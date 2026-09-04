import { describe, expect, it } from "vitest";

import {
  assertValidRuleset,
  BETA_V1_RULESET,
  canAfford,
  DEFAULT_ALLIANCE_RULES,
  DEFAULT_TRADE_RULES,
  debitResources,
  inventoryTotal,
  playerId,
  resolveRuleset,
  resourceAmount,
  resources,
  tick,
  validateRuleset,
} from "../src/index.ts";

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy of `value` with the dotted `path` replaced by `leaf`, sharing every untouched branch. */
function setPath(value: unknown, path: string, leaf: unknown): unknown {
  const [head, ...rest] = path.split(".");
  if (head === undefined || head === "") return leaf;
  if (!isRecord(value)) throw new Error(`cannot descend into ${path}`);
  return { ...value, [head]: setPath(value[head], rest.join("."), leaf) };
}

/** A copy of `value` without the dotted `path`. */
function deletePath(value: unknown, path: string): unknown {
  const [head, ...rest] = path.split(".");
  if (head === undefined || !isRecord(value)) throw new Error(`cannot delete ${path}`);
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== head));
  }
  return { ...value, [head]: deletePath(value[head], rest.join(".")) };
}

function leafPaths(value: unknown, prefix = ""): readonly string[] {
  if (!isRecord(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

const issuePaths = (value: unknown): readonly string[] =>
  validateRuleset(value).map((issue) => issue.path);

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
    expect(BETA_V1_RULESET.alliance).toEqual({ maxMembers: 20, inviteTtlTicks: 86_400 });
    expect(BETA_V1_RULESET.trade).toEqual({ offerTtlTicks: 86_400 });
    expect(validateRuleset(BETA_V1_RULESET)).toEqual([]);
  });
});

describe("optional ruleset sections", () => {
  const withoutSocial = deletePath(deletePath(BETA_V1_RULESET, "alliance"), "trade");

  it("accepts rulesets persisted before the alliance and trade sections existed", () => {
    expect(validateRuleset(deletePath(BETA_V1_RULESET, "alliance"))).toEqual([]);
    expect(validateRuleset(deletePath(BETA_V1_RULESET, "trade"))).toEqual([]);
    expect(validateRuleset(withoutSocial)).toEqual([]);
  });

  it("resolves missing sections to defaults that reproduce beta-v1", () => {
    const resolved = resolveRuleset(assertValidRuleset(withoutSocial));
    expect(resolved.alliance).toBe(DEFAULT_ALLIANCE_RULES);
    expect(resolved.trade).toBe(DEFAULT_TRADE_RULES);
    expect(resolved).toEqual(BETA_V1_RULESET);
  });

  it("keeps explicit section values when resolving", () => {
    const custom = assertValidRuleset(
      setPath(setPath(BETA_V1_RULESET, "alliance.maxMembers", 5), "trade.offerTtlTicks", 60),
    );
    expect(resolveRuleset(custom)).toMatchObject({
      alliance: { maxMembers: 5, inviteTtlTicks: 86_400 },
      trade: { offerTtlTicks: 60 },
    });
    expect(resolveRuleset(BETA_V1_RULESET)).toEqual(BETA_V1_RULESET);
  });

  it("requires every field of a present section and rejects non-object sections", () => {
    expect(validateRuleset(deletePath(BETA_V1_RULESET, "alliance.inviteTtlTicks"))).toEqual([
      { path: "alliance.inviteTtlTicks", message: "is required" },
    ]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "alliance", null))).toEqual([
      { path: "alliance", message: "must be an object" },
    ]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "trade", []))).toEqual([
      { path: "trade", message: "must be an object" },
    ]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "trade.offerTtlTicks", "86400"))).toEqual([
      { path: "trade.offerTtlTicks", message: "must be a number" },
    ]);
  });
});

describe("ruleset shape validation", () => {
  it("rejects roots that are not objects without dereferencing them", () => {
    expect(validateRuleset(undefined)).toEqual([{ path: "ruleset", message: "is required" }]);
    expect(validateRuleset(null)).toEqual([{ path: "ruleset", message: "must be an object" }]);
    expect(validateRuleset([])).toEqual([{ path: "ruleset", message: "must be an object" }]);
    expect(validateRuleset("beta-v1")).toEqual([{ path: "ruleset", message: "must be an object" }]);
  });

  it("reports a missing section by path instead of throwing", () => {
    expect(validateRuleset(deletePath(BETA_V1_RULESET, "trust"))).toEqual([
      { path: "trust", message: "is required" },
    ]);
    expect(validateRuleset(deletePath(BETA_V1_RULESET, "movement.terrainEnergyCost"))).toEqual([
      { path: "movement.terrainEnergyCost", message: "is required" },
    ]);
  });

  it("rejects structures given as an array", () => {
    expect(validateRuleset(setPath(BETA_V1_RULESET, "structures", []))).toEqual([
      { path: "structures", message: "must be an object" },
    ]);
  });

  it("rejects a string where a number belongs", () => {
    expect(validateRuleset(setPath(BETA_V1_RULESET, "combat.baseDamage", "30"))).toEqual([
      { path: "combat.baseDamage", message: "must be a number" },
    ]);
    expect(
      validateRuleset(setPath(BETA_V1_RULESET, "structures.generator.cost.materials", "60")),
    ).toEqual([{ path: "structures.generator.cost.materials", message: "must be a number" }]);
  });

  it("rejects unknown structure types and terrains", () => {
    const barracks = { cost: resources(), buildTimeTicks: 1, maxHp: 1, influence: 0 };
    expect(validateRuleset(setPath(BETA_V1_RULESET, "structures.barracks", barracks))).toEqual([
      { path: "structures.barracks", message: "is not a known structure type" },
    ]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "movement.terrainEnergyCost.lava", 9))).toEqual(
      [{ path: "movement.terrainEnergyCost.lava", message: "is not a known terrain" }],
    );
  });

  it("validates optional structure fields and the pinned generator", () => {
    expect(
      validateRuleset(setPath(BETA_V1_RULESET, "structures.generator.production.resource", "gold")),
    ).toEqual([
      {
        path: "structures.generator.production.resource",
        message: "must be one of energy, materials, inference",
      },
    ]);
    expect(
      validateRuleset(setPath(BETA_V1_RULESET, "structures.command-node.starterOnly", "yes")),
    ).toEqual([{ path: "structures.command-node.starterOnly", message: "must be a boolean" }]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "generation.algorithm", "perlin"))).toEqual([
      { path: "generation.algorithm", message: "must name a supported, immutable map generator" },
    ]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "id", ""))).toEqual([
      { path: "id", message: "must be a non-empty string" },
    ]);
  });

  it("requires every leaf of the beta ruleset except the optional starter flag", () => {
    const optional = new Set(["structures.command-node.starterOnly"]);
    for (const path of leafPaths(BETA_V1_RULESET)) {
      const paths = issuePaths(deletePath(BETA_V1_RULESET, path));
      if (optional.has(path)) {
        expect(paths).toEqual([]);
      } else if (!paths.includes(path)) {
        throw new Error(`deleting ${path} was not reported (got ${paths.join(", ") || "none"})`);
      }
    }
  });

  it("type-checks every numeric leaf before any arithmetic runs", () => {
    const record = BETA_V1_RULESET as unknown as UnknownRecord;
    const numericLeaves = leafPaths(record).filter((path) => {
      const value = path.split(".").reduce<unknown>((cursor, key) => {
        return isRecord(cursor) ? cursor[key] : undefined;
      }, record);
      return typeof value === "number";
    });
    expect(numericLeaves.length).toBeGreaterThan(60);
    for (const path of numericLeaves) {
      expect(validateRuleset(setPath(BETA_V1_RULESET, path, "1"))).toEqual([
        { path, message: "must be a number" },
      ]);
    }
  });

  it("narrows unknown input through assertValidRuleset and lists every issue on failure", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(BETA_V1_RULESET));
    expect(assertValidRuleset(parsed)).toBe(parsed);
    expect(() => assertValidRuleset(deletePath(BETA_V1_RULESET, "scoring"))).toThrow(
      "scoring: is required",
    );
    expect(() =>
      assertValidRuleset(
        setPath(setPath(BETA_V1_RULESET, "trust.tier2AgeTicks", -1), "scoring.energyPerPoint", 0),
      ),
    ).toThrow(
      "trust.tier2AgeTicks: must be a non-negative safe integer; scoring.energyPerPoint: must be a positive safe integer",
    );
  });
});

describe("ruleset value validation", () => {
  it.each([
    ["combat.retaliationAfterWithdrawalTicks", -1],
    ["combat.influencePerDestruction", -25],
    ["combat.influencePerOpponentWindow", 1.5],
    ["combat.influenceWindowTicks", 0],
    ["combat.weakOpponentPowerRatio", 1.5],
    ["combat.weakOpponentPowerRatio", Number.NaN],
    ["trust.tier1SuccessfulMutations", -1],
    ["trust.tier1CompletedStructures", 0.5],
    ["trust.tier2AgeTicks", -3_600],
    ["trust.tier2SuccessfulMutations", Number.POSITIVE_INFINITY],
    ["trust.tier2EarnedResources", -100],
    ["scoring.contestedTile", -10],
    ["scoring.frontierTile", 2.5],
    ["scoring.energyPerPoint", 0],
    ["scoring.materialsPerPoint", -50],
    ["scoring.inferencePerPoint", 0],
    ["look.radius", 193],
    ["scan.radius", 500],
    ["alliance.maxMembers", 0],
    ["alliance.maxMembers", 2.5],
    ["alliance.inviteTtlTicks", -1],
    ["trade.offerTtlTicks", 0],
    ["trade.offerTtlTicks", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("rejects %s = %s", (path, value) => {
    expect(issuePaths(setPath(BETA_V1_RULESET, path, value))).toEqual([path]);
  });

  it("accepts boundary values that the rules can evaluate", () => {
    const zeroed = ["combat.retaliationAfterWithdrawalTicks", "combat.influencePerDestruction"];
    for (const path of zeroed) {
      expect(validateRuleset(setPath(BETA_V1_RULESET, path, 0))).toEqual([]);
    }
    expect(validateRuleset(setPath(BETA_V1_RULESET, "look.radius", 192))).toEqual([]);
    expect(validateRuleset(setPath(BETA_V1_RULESET, "trust.tier1SuccessfulMutations", 0))).toEqual(
      [],
    );
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

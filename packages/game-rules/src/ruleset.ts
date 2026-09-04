import { type ResourceKind, type ResourceVector, resources } from "./resources.ts";

export type StructureType =
  | "command-node"
  | "generator"
  | "extractor"
  | "compute-node"
  | "defense-node";

export type Terrain = "plains" | "forest" | "hills" | "wetlands";

export interface ProductionRule {
  readonly resource: ResourceKind;
  readonly amount: number;
}

export interface StructureRule {
  readonly cost: ResourceVector;
  readonly buildTimeTicks: number;
  readonly maxHp: number;
  readonly production?: ProductionRule;
  readonly influence: number;
  readonly starterOnly?: boolean;
}

export interface Ruleset {
  readonly id: string;
  /** Pins map generation so an active world's ruleset hash also pins its terrain algorithm. */
  readonly generation: {
    readonly algorithm: "fnv1a-32-v1";
  };
  readonly ticksPerSecond: number;
  readonly map: {
    readonly width: number;
    readonly height: number;
    readonly regionSize: number;
    readonly starterReserveSize: number;
    readonly contestedSize: number;
    readonly starterPlotSize: number;
    readonly maxStarterPlots: number;
  };
  readonly startingResources: ResourceVector;
  readonly structures: Readonly<Record<StructureType, StructureRule>>;
  readonly movement: {
    readonly cooldownTicks: number;
    readonly terrainEnergyCost: Readonly<Record<Terrain, number>>;
  };
  readonly construction: {
    readonly concurrentLimit: number;
  };
  readonly production: {
    readonly intervalTicks: number;
    readonly offlineCapTicks: number;
  };
  readonly look: {
    readonly radius: number;
  };
  readonly scan: {
    readonly radius: number;
    readonly inferenceCost: number;
    readonly cooldownTicks: number;
  };
  readonly harvest: {
    readonly energyCost: number;
    readonly baseYield: number;
    readonly cooldownTicks: number;
  };
  readonly combat: {
    readonly hostilityWarmupTicks: number;
    readonly retaliationAfterWithdrawalTicks: number;
    readonly attackCooldownTicks: number;
    readonly energyCost: number;
    readonly inferenceCost: number;
    readonly baseDamage: number;
    readonly maxBonusInference: number;
    readonly damagePerBonusInference: number;
    readonly defenseReduction: number;
    readonly minimumDamage: number;
    readonly weakOpponentPowerRatio: number;
    readonly influencePerDestruction: number;
    readonly influencePerOpponentWindow: number;
    readonly influenceWindowTicks: number;
  };
  readonly trust: {
    readonly tier1SuccessfulMutations: number;
    readonly tier1CompletedStructures: number;
    readonly tier2AgeTicks: number;
    readonly tier2SuccessfulMutations: number;
    readonly tier2EarnedResources: number;
  };
  readonly scoring: {
    readonly contestedTile: number;
    readonly frontierTile: number;
    readonly energyPerPoint: number;
    readonly materialsPerPoint: number;
    readonly inferencePerPoint: number;
  };
  readonly season: {
    readonly durationTicks: number;
    readonly allianceFreezeTicks: number;
  };
}

export const BETA_V1_RULESET: Ruleset = {
  id: "beta-v1",
  generation: { algorithm: "fnv1a-32-v1" },
  ticksPerSecond: 1,
  map: {
    width: 192,
    height: 192,
    regionSize: 16,
    starterReserveSize: 64,
    contestedSize: 128,
    starterPlotSize: 2,
    maxStarterPlots: 512,
  },
  startingResources: resources(100, 100, 50),
  structures: {
    "command-node": {
      cost: resources(),
      buildTimeTicks: 0,
      maxHp: 250,
      influence: 0,
      starterOnly: true,
    },
    generator: {
      cost: resources(10, 60, 0),
      buildTimeTicks: 120,
      maxHp: 100,
      production: { resource: "energy", amount: 5 },
      influence: 10,
    },
    extractor: {
      cost: resources(20, 75, 0),
      buildTimeTicks: 180,
      maxHp: 120,
      production: { resource: "materials", amount: 3 },
      influence: 15,
    },
    "compute-node": {
      cost: resources(40, 80, 0),
      buildTimeTicks: 300,
      maxHp: 90,
      production: { resource: "inference", amount: 2 },
      influence: 20,
    },
    "defense-node": {
      cost: resources(60, 120, 20),
      buildTimeTicks: 480,
      maxHp: 180,
      influence: 25,
    },
  },
  movement: {
    cooldownTicks: 2,
    terrainEnergyCost: { plains: 1, forest: 2, hills: 3, wetlands: 4 },
  },
  construction: { concurrentLimit: 2 },
  production: { intervalTicks: 600, offlineCapTicks: 86_400 },
  look: { radius: 1 },
  scan: { radius: 3, inferenceCost: 5, cooldownTicks: 30 },
  harvest: { energyCost: 3, baseYield: 5, cooldownTicks: 60 },
  combat: {
    hostilityWarmupTicks: 900,
    retaliationAfterWithdrawalTicks: 900,
    attackCooldownTicks: 120,
    energyCost: 20,
    inferenceCost: 5,
    baseDamage: 30,
    maxBonusInference: 10,
    damagePerBonusInference: 2,
    defenseReduction: 15,
    minimumDamage: 1,
    weakOpponentPowerRatio: 0.5,
    influencePerDestruction: 25,
    influencePerOpponentWindow: 100,
    influenceWindowTicks: 86_400,
  },
  trust: {
    tier1SuccessfulMutations: 5,
    tier1CompletedStructures: 1,
    tier2AgeTicks: 3_600,
    tier2SuccessfulMutations: 20,
    tier2EarnedResources: 100,
  },
  scoring: {
    contestedTile: 10,
    frontierTile: 25,
    energyPerPoint: 100,
    materialsPerPoint: 50,
    inferencePerPoint: 25,
  },
  season: { durationTicks: 2_419_200, allianceFreezeTicks: 259_200 },
};

export interface RulesetIssue {
  readonly path: string;
  readonly message: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// `satisfies Record<Union, true>` keeps each key list exhaustive and free of typos at compile time.
const STRUCTURE_TYPES: readonly string[] = Object.keys({
  "command-node": true,
  generator: true,
  extractor: true,
  "compute-node": true,
  "defense-node": true,
} satisfies Readonly<Record<StructureType, true>>);

const TERRAINS: readonly string[] = Object.keys({
  plains: true,
  forest: true,
  hills: true,
  wetlands: true,
} satisfies Readonly<Record<Terrain, true>>);

const RESOURCE_KINDS: readonly string[] = Object.keys({
  energy: true,
  materials: true,
  inference: true,
} satisfies Readonly<Record<ResourceKind, true>>);

type NumericSection =
  | "map"
  | "startingResources"
  | "construction"
  | "production"
  | "look"
  | "scan"
  | "harvest"
  | "combat"
  | "trust"
  | "scoring"
  | "season";

/** Sections whose leaves are all numbers; every listed field must exist before arithmetic runs. */
const NUMERIC_SECTIONS = {
  map: [
    "width",
    "height",
    "regionSize",
    "starterReserveSize",
    "contestedSize",
    "starterPlotSize",
    "maxStarterPlots",
  ],
  startingResources: ["energy", "materials", "inference"],
  construction: ["concurrentLimit"],
  production: ["intervalTicks", "offlineCapTicks"],
  look: ["radius"],
  scan: ["radius", "inferenceCost", "cooldownTicks"],
  harvest: ["energyCost", "baseYield", "cooldownTicks"],
  combat: [
    "hostilityWarmupTicks",
    "retaliationAfterWithdrawalTicks",
    "attackCooldownTicks",
    "energyCost",
    "inferenceCost",
    "baseDamage",
    "maxBonusInference",
    "damagePerBonusInference",
    "defenseReduction",
    "minimumDamage",
    "weakOpponentPowerRatio",
    "influencePerDestruction",
    "influencePerOpponentWindow",
    "influenceWindowTicks",
  ],
  trust: [
    "tier1SuccessfulMutations",
    "tier1CompletedStructures",
    "tier2AgeTicks",
    "tier2SuccessfulMutations",
    "tier2EarnedResources",
  ],
  scoring: [
    "contestedTile",
    "frontierTile",
    "energyPerPoint",
    "materialsPerPoint",
    "inferencePerPoint",
  ],
  season: ["durationTicks", "allianceFreezeTicks"],
} as const satisfies { readonly [K in NumericSection]: readonly (keyof Ruleset[K])[] };

/**
 * Verifies that `value` has the shape of a `Ruleset`: the root, every required section, and every
 * required primitive, with closed records for structures and terrain. It performs no arithmetic,
 * so malformed input yields precise issues instead of type errors.
 */
function rulesetShapeIssues(value: unknown): readonly RulesetIssue[] {
  const issues: RulesetIssue[] = [];
  const report = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  const wrongType = (path: string, actual: unknown, expected: string): void => {
    report(path, actual === undefined ? "is required" : `must be ${expected}`);
  };
  const object = (path: string, actual: unknown): UnknownRecord | undefined => {
    if (isRecord(actual)) return actual;
    wrongType(path, actual, "an object");
    return undefined;
  };
  const number = (path: string, actual: unknown): void => {
    if (typeof actual !== "number") wrongType(path, actual, "a number");
  };
  const numbers = (path: string, actual: unknown, fields: readonly string[]): void => {
    const record = object(path, actual);
    if (record === undefined) return;
    for (const field of fields) number(`${path}.${field}`, record[field]);
  };
  const closedRecord = (
    path: string,
    actual: unknown,
    keys: readonly string[],
    kind: string,
  ): UnknownRecord | undefined => {
    const record = object(path, actual);
    if (record === undefined) return undefined;
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) report(`${path}.${key}`, `is not a known ${kind}`);
    }
    return record;
  };
  const structureRule = (path: string, actual: unknown): void => {
    const rule = object(path, actual);
    if (rule === undefined) return;
    numbers(`${path}.cost`, rule.cost, RESOURCE_KINDS);
    number(`${path}.buildTimeTicks`, rule.buildTimeTicks);
    number(`${path}.maxHp`, rule.maxHp);
    number(`${path}.influence`, rule.influence);
    if (rule.production !== undefined) {
      const production = object(`${path}.production`, rule.production);
      if (production !== undefined) {
        if (
          typeof production.resource !== "string" ||
          !RESOURCE_KINDS.includes(production.resource)
        ) {
          report(`${path}.production.resource`, `must be one of ${RESOURCE_KINDS.join(", ")}`);
        }
        number(`${path}.production.amount`, production.amount);
      }
    }
    if (rule.starterOnly !== undefined && typeof rule.starterOnly !== "boolean") {
      report(`${path}.starterOnly`, "must be a boolean");
    }
  };

  const root = object("ruleset", value);
  if (root === undefined) return issues;
  if (typeof root.id !== "string" || root.id.length === 0) {
    wrongType("id", root.id, "a non-empty string");
  }
  number("ticksPerSecond", root.ticksPerSecond);
  const generation = object("generation", root.generation);
  if (generation !== undefined && generation.algorithm !== "fnv1a-32-v1") {
    report("generation.algorithm", "must name a supported, immutable map generator");
  }
  for (const [section, fields] of Object.entries(NUMERIC_SECTIONS)) {
    numbers(section, root[section], fields);
  }
  const movement = object("movement", root.movement);
  if (movement !== undefined) {
    number("movement.cooldownTicks", movement.cooldownTicks);
    const costs = closedRecord(
      "movement.terrainEnergyCost",
      movement.terrainEnergyCost,
      TERRAINS,
      "terrain",
    );
    if (costs !== undefined) {
      for (const terrain of TERRAINS) {
        number(`movement.terrainEnergyCost.${terrain}`, costs[terrain]);
      }
    }
  }
  const structures = closedRecord("structures", root.structures, STRUCTURE_TYPES, "structure type");
  if (structures !== undefined) {
    for (const type of STRUCTURE_TYPES) structureRule(`structures.${type}`, structures[type]);
  }
  return issues;
}

export function validateRuleset(value: unknown): readonly RulesetIssue[] {
  const shapeIssues = rulesetShapeIssues(value);
  if (shapeIssues.length > 0) return shapeIssues;
  // The shape pass verified every section and primitive the checks below dereference.
  const ruleset = value as Ruleset;
  const issues: RulesetIssue[] = [];
  const positiveInteger = (path: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      issues.push({ path, message: "must be a positive safe integer" });
    }
  };
  const nonNegativeInteger = (path: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push({ path, message: "must be a non-negative safe integer" });
    }
  };
  const resourceVector = (path: string, value: ResourceVector): void => {
    nonNegativeInteger(`${path}.energy`, value.energy);
    nonNegativeInteger(`${path}.materials`, value.materials);
    nonNegativeInteger(`${path}.inference`, value.inference);
  };
  positiveInteger("ticksPerSecond", ruleset.ticksPerSecond);
  positiveInteger("map.width", ruleset.map.width);
  positiveInteger("map.height", ruleset.map.height);
  positiveInteger("map.regionSize", ruleset.map.regionSize);
  positiveInteger("map.starterReserveSize", ruleset.map.starterReserveSize);
  positiveInteger("map.contestedSize", ruleset.map.contestedSize);
  positiveInteger("map.starterPlotSize", ruleset.map.starterPlotSize);
  positiveInteger("map.maxStarterPlots", ruleset.map.maxStarterPlots);
  positiveInteger("production.intervalTicks", ruleset.production.intervalTicks);
  positiveInteger("production.offlineCapTicks", ruleset.production.offlineCapTicks);
  resourceVector("startingResources", ruleset.startingResources);
  if (
    ruleset.map.starterReserveSize > ruleset.map.contestedSize ||
    ruleset.map.contestedSize > Math.min(ruleset.map.width, ruleset.map.height)
  ) {
    issues.push({ path: "map", message: "zone sizes must nest inside the world" });
  }
  if (
    ruleset.map.starterReserveSize % ruleset.map.starterPlotSize !== 0 ||
    ruleset.map.width % ruleset.map.regionSize !== 0 ||
    ruleset.map.height % ruleset.map.regionSize !== 0
  ) {
    issues.push({ path: "map", message: "map dimensions must divide into regions and plots" });
  }
  const plotsPerAxis = ruleset.map.starterReserveSize / ruleset.map.starterPlotSize;
  if (ruleset.map.maxStarterPlots > plotsPerAxis * plotsPerAxis) {
    issues.push({ path: "map.maxStarterPlots", message: "exceeds the starter reserve capacity" });
  }
  for (const [type, rule] of Object.entries(ruleset.structures)) {
    resourceVector(`structures.${type}.cost`, rule.cost);
    if (rule.maxHp <= 0 || !Number.isSafeInteger(rule.maxHp)) {
      issues.push({ path: `structures.${type}.maxHp`, message: "must be a positive integer" });
    }
    if (rule.buildTimeTicks < 0 || !Number.isSafeInteger(rule.buildTimeTicks)) {
      issues.push({
        path: `structures.${type}.buildTimeTicks`,
        message: "must be a non-negative integer",
      });
    }
    nonNegativeInteger(`structures.${type}.influence`, rule.influence);
    if (rule.production !== undefined) {
      positiveInteger(`structures.${type}.production.amount`, rule.production.amount);
    }
  }
  positiveInteger("movement.cooldownTicks", ruleset.movement.cooldownTicks);
  for (const [terrain, cost] of Object.entries(ruleset.movement.terrainEnergyCost)) {
    positiveInteger(`movement.terrainEnergyCost.${terrain}`, cost);
  }
  positiveInteger("construction.concurrentLimit", ruleset.construction.concurrentLimit);
  const largestDimension = Math.max(ruleset.map.width, ruleset.map.height);
  positiveInteger("look.radius", ruleset.look.radius);
  positiveInteger("scan.radius", ruleset.scan.radius);
  if (ruleset.look.radius > largestDimension) {
    issues.push({ path: "look.radius", message: "must not exceed the largest map dimension" });
  }
  if (ruleset.scan.radius > largestDimension) {
    issues.push({ path: "scan.radius", message: "must not exceed the largest map dimension" });
  }
  nonNegativeInteger("scan.inferenceCost", ruleset.scan.inferenceCost);
  positiveInteger("scan.cooldownTicks", ruleset.scan.cooldownTicks);
  nonNegativeInteger("harvest.energyCost", ruleset.harvest.energyCost);
  positiveInteger("harvest.baseYield", ruleset.harvest.baseYield);
  positiveInteger("harvest.cooldownTicks", ruleset.harvest.cooldownTicks);
  positiveInteger("combat.hostilityWarmupTicks", ruleset.combat.hostilityWarmupTicks);
  nonNegativeInteger(
    "combat.retaliationAfterWithdrawalTicks",
    ruleset.combat.retaliationAfterWithdrawalTicks,
  );
  positiveInteger("combat.attackCooldownTicks", ruleset.combat.attackCooldownTicks);
  nonNegativeInteger("combat.energyCost", ruleset.combat.energyCost);
  nonNegativeInteger("combat.inferenceCost", ruleset.combat.inferenceCost);
  positiveInteger("combat.baseDamage", ruleset.combat.baseDamage);
  nonNegativeInteger("combat.maxBonusInference", ruleset.combat.maxBonusInference);
  positiveInteger("combat.damagePerBonusInference", ruleset.combat.damagePerBonusInference);
  nonNegativeInteger("combat.defenseReduction", ruleset.combat.defenseReduction);
  positiveInteger("combat.minimumDamage", ruleset.combat.minimumDamage);
  if (
    !Number.isFinite(ruleset.combat.weakOpponentPowerRatio) ||
    ruleset.combat.weakOpponentPowerRatio < 0 ||
    ruleset.combat.weakOpponentPowerRatio > 1
  ) {
    issues.push({ path: "combat.weakOpponentPowerRatio", message: "must be between 0 and 1" });
  }
  nonNegativeInteger("combat.influencePerDestruction", ruleset.combat.influencePerDestruction);
  nonNegativeInteger(
    "combat.influencePerOpponentWindow",
    ruleset.combat.influencePerOpponentWindow,
  );
  positiveInteger("combat.influenceWindowTicks", ruleset.combat.influenceWindowTicks);
  nonNegativeInteger("trust.tier1SuccessfulMutations", ruleset.trust.tier1SuccessfulMutations);
  nonNegativeInteger("trust.tier1CompletedStructures", ruleset.trust.tier1CompletedStructures);
  nonNegativeInteger("trust.tier2AgeTicks", ruleset.trust.tier2AgeTicks);
  nonNegativeInteger("trust.tier2SuccessfulMutations", ruleset.trust.tier2SuccessfulMutations);
  nonNegativeInteger("trust.tier2EarnedResources", ruleset.trust.tier2EarnedResources);
  nonNegativeInteger("scoring.contestedTile", ruleset.scoring.contestedTile);
  nonNegativeInteger("scoring.frontierTile", ruleset.scoring.frontierTile);
  positiveInteger("scoring.energyPerPoint", ruleset.scoring.energyPerPoint);
  positiveInteger("scoring.materialsPerPoint", ruleset.scoring.materialsPerPoint);
  positiveInteger("scoring.inferencePerPoint", ruleset.scoring.inferencePerPoint);
  positiveInteger("season.durationTicks", ruleset.season.durationTicks);
  nonNegativeInteger("season.allianceFreezeTicks", ruleset.season.allianceFreezeTicks);
  if (ruleset.season.allianceFreezeTicks >= ruleset.season.durationTicks) {
    issues.push({ path: "season.allianceFreezeTicks", message: "must be shorter than the season" });
  }
  return issues;
}

/** Narrows arbitrary parsed configuration to a `Ruleset`, or throws listing every issue. */
export function assertValidRuleset(value: unknown): Ruleset {
  const issues = validateRuleset(value);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  return value as Ruleset;
}

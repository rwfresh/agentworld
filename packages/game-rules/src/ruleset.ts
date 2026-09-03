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

export function validateRuleset(ruleset: Ruleset): readonly RulesetIssue[] {
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
  if (ruleset.generation.algorithm !== "fnv1a-32-v1") {
    issues.push({
      path: "generation.algorithm",
      message: "must name a supported, immutable map generator",
    });
  }
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
  positiveInteger("look.radius", ruleset.look.radius);
  positiveInteger("scan.radius", ruleset.scan.radius);
  nonNegativeInteger("scan.inferenceCost", ruleset.scan.inferenceCost);
  positiveInteger("scan.cooldownTicks", ruleset.scan.cooldownTicks);
  nonNegativeInteger("harvest.energyCost", ruleset.harvest.energyCost);
  positiveInteger("harvest.baseYield", ruleset.harvest.baseYield);
  positiveInteger("harvest.cooldownTicks", ruleset.harvest.cooldownTicks);
  positiveInteger("combat.hostilityWarmupTicks", ruleset.combat.hostilityWarmupTicks);
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
  positiveInteger("season.durationTicks", ruleset.season.durationTicks);
  nonNegativeInteger("season.allianceFreezeTicks", ruleset.season.allianceFreezeTicks);
  if (ruleset.season.allianceFreezeTicks >= ruleset.season.durationTicks) {
    issues.push({ path: "season.allianceFreezeTicks", message: "must be shorter than the season" });
  }
  return issues;
}

export function assertValidRuleset(ruleset: Ruleset): Ruleset {
  const issues = validateRuleset(ruleset);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  return ruleset;
}

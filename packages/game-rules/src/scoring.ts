import type { Ruleset } from "./ruleset.ts";
import type { CivilizationState, GameSnapshot, TrustTier } from "./state.ts";
import type { PlayerId, Tick } from "./types.ts";
import { zoneAt } from "./world.ts";

export interface InfluenceBreakdown {
  readonly territory: number;
  readonly structures: number;
  readonly economy: number;
  readonly combat: number;
  readonly total: number;
}

export function scorePlayer(
  snapshot: GameSnapshot,
  id: PlayerId,
  ruleset: Ruleset,
): InfluenceBreakdown {
  const player = snapshot.players.find((candidate) => candidate.id === id);
  if (player === undefined) throw new RangeError("player not found");
  let territory = 0;
  let structures = 0;
  for (const structure of snapshot.structures) {
    if (structure.ownerId !== id || structure.status !== "active") continue;
    structures += ruleset.structures[structure.type].influence;
    const zone = zoneAt(snapshot.world, structure.coordinate, ruleset);
    if (zone === "contested") territory += ruleset.scoring.contestedTile;
    if (zone === "frontier") territory += ruleset.scoring.frontierTile;
  }
  const economy =
    Math.floor(player.earnedResources.energy / ruleset.scoring.energyPerPoint) +
    Math.floor(player.earnedResources.materials / ruleset.scoring.materialsPerPoint) +
    Math.floor(player.earnedResources.inference / ruleset.scoring.inferencePerPoint);
  const total = territory + structures + economy + player.combatInfluence;
  return { territory, structures, economy, combat: player.combatInfluence, total };
}

/** Combat power is intentionally based on deployed active infrastructure, not resource holdings. */
export function combatPower(snapshot: GameSnapshot, id: PlayerId, ruleset: Ruleset): number {
  return snapshot.structures.reduce((power, structure) => {
    if (structure.ownerId !== id || structure.status !== "active") return power;
    return power + ruleset.structures[structure.type].maxHp;
  }, 0);
}

export type TrustProgress = Pick<
  CivilizationState,
  | "joinedAtTick"
  | "successfulMutations"
  | "completedStructures"
  | "earnedResources"
  | "persistentTrustTier"
>;

export function trustTierAt(
  player: TrustProgress,
  effectiveTick: Tick,
  ruleset: Ruleset,
): TrustTier {
  const earnedTotal =
    player.earnedResources.energy +
    player.earnedResources.materials +
    player.earnedResources.inference;
  const tier2 =
    effectiveTick - player.joinedAtTick >= ruleset.trust.tier2AgeTicks &&
    player.successfulMutations >= ruleset.trust.tier2SuccessfulMutations &&
    earnedTotal >= ruleset.trust.tier2EarnedResources;
  const tier1 =
    player.successfulMutations >= ruleset.trust.tier1SuccessfulMutations &&
    player.completedStructures >= ruleset.trust.tier1CompletedStructures;
  const earned: TrustTier = tier2 ? 2 : tier1 ? 1 : 0;
  return Math.max(player.persistentTrustTier, earned) as TrustTier;
}

import {
  BETA_V1_RULESET,
  createStarterStructures,
  createStartingCivilization,
  createWorldDescriptor,
  type GameSnapshot,
  playerId,
  starterPlotForSlot,
  structureId,
  tick,
  worldId,
} from "../src/index.ts";

export function startingSnapshot(): GameSnapshot {
  const world = createWorldDescriptor(worldId("world-test"), "fixed-test-seed", BETA_V1_RULESET);
  const ownerId = playerId("player-one");
  const plot = starterPlotForSlot(world, 0, BETA_V1_RULESET, ownerId);
  const player = createStartingCivilization(
    ownerId,
    plot,
    tick(0),
    BETA_V1_RULESET.startingResources,
  );
  const structures = createStarterStructures(
    ownerId,
    plot,
    {
      commandNode: structureId("starter-command"),
      generator: structureId("starter-generator"),
      extractor: structureId("starter-extractor"),
    },
    tick(0),
    BETA_V1_RULESET,
  );
  return { world, players: [player], structures, hostilities: [] };
}

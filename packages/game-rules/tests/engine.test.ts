import { describe, expect, it } from "vitest";

import {
  BETA_V1_RULESET,
  coordinate,
  decide,
  inventoryTotal,
  look,
  playerId,
  projectPlayerAt,
  settlePassiveProduction,
  structureId,
  tick,
  tileAt,
} from "../src/index.ts";
import { startingSnapshot } from "./fixtures.ts";

describe("the pure action reducer", () => {
  it("moves cardinally, charges terrain energy, reveals nearby tiles, and enforces cooldown", () => {
    const initial = startingSnapshot();
    const player = initial.players[0];
    if (player === undefined) throw new Error("fixture player missing");
    const destination = { x: player.position.x + 1, y: player.position.y };
    const expectedCost =
      BETA_V1_RULESET.movement.terrainEnergyCost[
        tileAt(initial.world, destination, BETA_V1_RULESET).terrain
      ];
    const result = decide(
      { type: "move", actorId: player.id, direction: "east" },
      initial,
      BETA_V1_RULESET,
      tick(0),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.players[0]?.position).toEqual(destination);
    expect(inventoryTotal(result.state.players[0]?.inventory ?? player.inventory).energy).toBe(
      100 - expectedCost,
    );
    expect(result.resourceChange.energy).toBe(-expectedCost);
    expect(initial.players[0]?.position).toEqual(player.position);

    const coolingDown = decide(
      { type: "move", actorId: player.id, direction: "east" },
      result.state,
      BETA_V1_RULESET,
      tick(1),
    );
    expect(coolingDown).toMatchObject({
      ok: false,
      violation: { code: "COOLDOWN_ACTIVE", retryAtTick: 2 },
    });
  });

  it("starts construction at half HP, reserves its tile, and completes on schedule", () => {
    const initial = startingSnapshot();
    const actorId = initial.players[0]?.id;
    if (actorId === undefined) throw new Error("fixture player missing");
    const id = structureId("new-generator");
    const started = decide(
      { type: "build", actorId, structureId: id, structureType: "generator" },
      initial,
      BETA_V1_RULESET,
      tick(0),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.completionTick).toBe(120);
    expect(started.state.structures.find((value) => value.id === id)).toMatchObject({
      status: "constructing",
      hp: 50,
      constructionCompleteTick: 120,
    });
    expect(started.state.players[0]?.inventory.bound).toMatchObject({
      energy: 90,
      materials: 40,
      inference: 50,
    });
    const duplicateTile = decide(
      {
        type: "build",
        actorId,
        structureId: structureId("other-generator"),
        structureType: "generator",
      },
      started.state,
      BETA_V1_RULESET,
      tick(1),
    );
    expect(duplicateTile).toMatchObject({ ok: false, violation: { code: "TILE_OCCUPIED" } });
    const early = decide(
      { type: "complete-construction", actorId, structureId: id },
      started.state,
      BETA_V1_RULESET,
      tick(119),
    );
    expect(early).toMatchObject({
      ok: false,
      violation: { code: "CONSTRUCTION_NOT_READY", retryAtTick: 120 },
    });
    const completed = decide(
      { type: "complete-construction", actorId, structureId: id },
      started.state,
      BETA_V1_RULESET,
      tick(120),
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.state.structures.find((value) => value.id === id)).toMatchObject({
      status: "active",
      hp: 100,
    });
    expect(completed.state.players[0]?.completedStructures).toBe(1);
  });

  it("never permits expansion into another player's protected starter plot", () => {
    const initial = startingSnapshot();
    const actor = initial.players[0];
    const anchor = initial.structures[0];
    if (actor === undefined || anchor === undefined) throw new Error("fixture is incomplete");
    const occupied = new Set(
      initial.structures.map((value) => `${value.coordinate.x},${value.coordinate.y}`),
    );
    const home = new Set(actor.homePlot.map((value) => `${value.x},${value.y}`));
    const target = [
      coordinate(anchor.coordinate.x + 1, anchor.coordinate.y),
      coordinate(anchor.coordinate.x - 1, anchor.coordinate.y),
      coordinate(anchor.coordinate.x, anchor.coordinate.y + 1),
      coordinate(anchor.coordinate.x, anchor.coordinate.y - 1),
    ].find(
      (value) =>
        value.x >= 0 &&
        value.y >= 0 &&
        value.x < initial.world.width &&
        value.y < initial.world.height &&
        !occupied.has(`${value.x},${value.y}`) &&
        !home.has(`${value.x},${value.y}`),
    );
    if (target === undefined) throw new Error("fixture has no expansion tile");
    const positionedActor = { ...actor, position: target };
    const build = {
      type: "build" as const,
      actorId: actor.id,
      structureId: structureId("protected-plot-build"),
      structureType: "generator" as const,
    };
    const expansionState = { ...initial, players: [positionedActor] };
    expect(decide(build, expansionState, BETA_V1_RULESET, tick(0)).ok).toBe(true);

    const protectedState = {
      ...expansionState,
      players: [
        positionedActor,
        {
          ...actor,
          id: playerId("player-two"),
          position: target,
          homePlot: [target],
          discoveredTileKeys: [],
        },
      ],
    };
    expect(decide(build, protectedState, BETA_V1_RULESET, tick(0))).toMatchObject({
      ok: false,
      violation: { code: "BUILD_LOCATION_INVALID" },
    });
  });

  it("settles deterministic production with a 24-hour offline cap and no double credit", () => {
    const initial = startingSnapshot();
    const actorId = initial.players[0]?.id;
    if (actorId === undefined) throw new Error("fixture player missing");
    const settled = settlePassiveProduction(initial, actorId, tick(100_000), BETA_V1_RULESET);
    expect(settled.produced).toMatchObject({ energy: 720, materials: 432, inference: 0 });
    expect(settled.state.players[0]?.inventory.transferable).toMatchObject({
      energy: 720,
      materials: 432,
      inference: 0,
    });
    const duplicate = settlePassiveProduction(
      settled.state,
      actorId,
      tick(100_000),
      BETA_V1_RULESET,
    );
    expect(duplicate.produced).toMatchObject({ energy: 0, materials: 0, inference: 0 });
    const nextInterval = settlePassiveProduction(
      duplicate.state,
      actorId,
      tick(100_600),
      BETA_V1_RULESET,
    );
    expect(nextInterval.produced).toMatchObject({ energy: 5, materials: 3, inference: 0 });
  });

  it("harvests the selected tile resource and scans radius three", () => {
    const initial = startingSnapshot();
    const actor = initial.players[0];
    if (actor === undefined) throw new Error("fixture player missing");
    const currentTile = tileAt(initial.world, actor.position, BETA_V1_RULESET);
    const harvested = decide(
      { type: "harvest", actorId: actor.id },
      initial,
      BETA_V1_RULESET,
      tick(0),
    );
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) return;
    const harvestEvent = harvested.events.find((event) => event.type === "RESOURCES_HARVESTED");
    expect(harvestEvent).toMatchObject({ resource: currentTile.dominantResource, amount: 5 });
    const repeated = decide(
      { type: "harvest", actorId: actor.id },
      harvested.state,
      BETA_V1_RULESET,
      tick(59),
    );
    expect(repeated).toMatchObject({
      ok: false,
      violation: { code: "COOLDOWN_ACTIVE", retryAtTick: 60 },
    });

    const scanned = decide({ type: "scan", actorId: actor.id }, initial, BETA_V1_RULESET, tick(0));
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.state.players[0]?.inventory.bound.inference).toBe(45);
    expect(scanned.state.players[0]?.discoveredTileKeys).toHaveLength(25);
  });

  it("keeps reads as projections without mutating the supplied snapshot", () => {
    const initial = startingSnapshot();
    const actor = initial.players[0];
    if (actor === undefined) throw new Error("fixture player missing");
    const before = JSON.stringify(initial);
    const view = look(initial, actor.id, BETA_V1_RULESET);
    expect("tiles" in view && view.tiles).toHaveLength(5);
    const projection = projectPlayerAt(initial, actor.id, tick(600), BETA_V1_RULESET);
    expect("inventory" in projection && projection.inventory.transferable).toMatchObject({
      energy: 5,
      materials: 3,
    });
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("is deterministic for equal commands and snapshots", () => {
    const initial = startingSnapshot();
    const actorId = initial.players[0]?.id;
    if (actorId === undefined) throw new Error("fixture player missing");
    const command = { type: "scan", actorId } as const;
    expect(decide(command, initial, BETA_V1_RULESET, tick(0))).toEqual(
      decide(command, initial, BETA_V1_RULESET, tick(0)),
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  BETA_V1_RULESET,
  coordinate,
  createStarterStructures,
  createStartingCivilization,
  decide,
  type GameSnapshot,
  inventoryTotal,
  look,
  playerId,
  projectPlayerAt,
  settlePassiveProduction,
  starterPlotForSlot,
  starterPlotSlotAt,
  structureId,
  tick,
  tileAt,
  zoneAt,
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

  describe("build locations", () => {
    const build = (snapshot: GameSnapshot, position: ReturnType<typeof coordinate>) => {
      const actor = snapshot.players[0];
      if (actor === undefined) throw new Error("fixture player missing");
      return decide(
        {
          type: "build",
          actorId: actor.id,
          structureId: structureId("candidate-site"),
          structureType: "generator",
        },
        {
          ...snapshot,
          players: snapshot.players.map((value) =>
            value.id === actor.id ? { ...value, position } : value,
          ),
        },
        BETA_V1_RULESET,
        tick(0),
      );
    };

    it("never permits building on another player's allocated starter plot", () => {
      const initial = startingSnapshot();
      const neighbourId = playerId("player-two");
      const neighbourPlot = starterPlotForSlot(initial.world, 1, BETA_V1_RULESET, neighbourId);
      const neighbour = createStartingCivilization(
        neighbourId,
        neighbourPlot,
        tick(0),
        BETA_V1_RULESET.startingResources,
      );
      const populated: GameSnapshot = {
        ...initial,
        players: [...initial.players, neighbour],
        structures: [
          ...initial.structures,
          ...createStarterStructures(
            neighbourId,
            neighbourPlot,
            {
              commandNode: structureId("two-command"),
              generator: structureId("two-generator"),
              extractor: structureId("two-extractor"),
            },
            tick(0),
            BETA_V1_RULESET,
          ),
        ],
      };
      // The neighbour's own empty plot tile is buildable for the neighbour but not for the actor.
      expect(build(populated, neighbour.position)).toMatchObject({
        ok: false,
        violation: {
          code: "BUILD_LOCATION_INVALID",
          message: "build on your own starter plot or in contested or frontier territory",
        },
      });
    });

    it("protects every unallocated starter plot so later spawns cannot be blocked", () => {
      const initial = startingSnapshot();
      const anchor = initial.structures[0];
      if (anchor === undefined) throw new Error("fixture is incomplete");
      // Directly east of the command node lies the first tile of the still-unclaimed slot 1: the
      // old adjacency rule allowed a structure there, which made the next spawn fail forever.
      const nextPlotTile = coordinate(anchor.coordinate.x + 2, anchor.coordinate.y);
      expect(starterPlotSlotAt(initial.world, nextPlotTile, BETA_V1_RULESET)).toBe(1);
      expect(build(initial, nextPlotTile)).toMatchObject({
        ok: false,
        violation: { code: "BUILD_LOCATION_INVALID" },
      });
      for (let slot = 1; slot < BETA_V1_RULESET.map.maxStarterPlots; slot += 1) {
        for (const tile of starterPlotForSlot(initial.world, slot, BETA_V1_RULESET).tiles) {
          const decision = build(initial, tile);
          if (decision.ok || decision.violation.code !== "BUILD_LOCATION_INVALID") {
            throw new Error(`slot ${slot} tile ${tile.x},${tile.y} was buildable`);
          }
        }
      }
    });

    it("rejects reserve tiles outside any plot and accepts the actor's own empty plot tile", () => {
      const initial = startingSnapshot();
      const actor = initial.players[0];
      if (actor === undefined) throw new Error("fixture player missing");
      const reserveBand = coordinate(96, 70);
      expect(zoneAt(initial.world, reserveBand, BETA_V1_RULESET)).toBe("starter");
      expect(starterPlotSlotAt(initial.world, reserveBand, BETA_V1_RULESET)).toBeUndefined();
      expect(build(initial, reserveBand)).toMatchObject({
        ok: false,
        violation: { code: "BUILD_LOCATION_INVALID" },
      });
      expect(build(initial, actor.position).ok).toBe(true);
    });

    it("allows founding a site on any unoccupied contested or frontier tile without adjacency", () => {
      const initial = startingSnapshot();
      const contested = coordinate(40, 96);
      const frontier = coordinate(0, 0);
      expect(zoneAt(initial.world, contested, BETA_V1_RULESET)).toBe("contested");
      expect(zoneAt(initial.world, frontier, BETA_V1_RULESET)).toBe("frontier");
      for (const site of [contested, frontier]) {
        const founded = build(initial, site);
        expect(founded.ok).toBe(true);
        if (!founded.ok) return;
        expect(founded.state.structures.at(-1)).toMatchObject({
          coordinate: site,
          status: "constructing",
        });
      }
      const occupied: GameSnapshot = {
        ...initial,
        structures: [
          ...initial.structures,
          {
            id: structureId("rival-outpost"),
            ownerId: playerId("rival"),
            type: "generator",
            coordinate: contested,
            status: "active",
            hp: 100,
            lastProductionTick: tick(0),
            productionRemainderTicks: 0,
          },
        ],
      };
      expect(build(occupied, contested)).toMatchObject({
        ok: false,
        violation: { code: "TILE_OCCUPIED" },
      });
    });
  });

  describe("passive production", () => {
    const cursorsOf = (snapshot: GameSnapshot) =>
      snapshot.structures
        .filter((structure) => structure.type !== "command-node")
        .map((structure) => [structure.lastProductionTick, structure.productionRemainderTicks]);

    it("credits complete intervals once and carries sub-interval ticks at the cursor", () => {
      const initial = startingSnapshot();
      const actorId = initial.players[0]?.id;
      if (actorId === undefined) throw new Error("fixture player missing");
      const almost = settlePassiveProduction(initial, actorId, tick(599), BETA_V1_RULESET);
      expect(almost.produced).toMatchObject({ energy: 0, materials: 0, inference: 0 });
      expect(almost.events).toEqual([]);
      expect(cursorsOf(almost.state)).toEqual([
        [599, 599],
        [599, 599],
      ]);
      const first = settlePassiveProduction(almost.state, actorId, tick(600), BETA_V1_RULESET);
      expect(first.produced).toMatchObject({ energy: 5, materials: 3, inference: 0 });
      expect(first.events).toEqual([
        {
          type: "RESOURCES_PRODUCED",
          tick: 600,
          actorId,
          resources: first.produced,
        },
      ]);
      expect(cursorsOf(first.state)).toEqual([
        [600, 0],
        [600, 0],
      ]);
      expect(first.state.players[0]?.inventory.transferable).toMatchObject({
        energy: 5,
        materials: 3,
      });
      expect(first.state.players[0]?.earnedResources).toMatchObject({ energy: 5, materials: 3 });
    });

    it("settles at most one 24-hour chunk per call and never discards the rest", () => {
      const initial = startingSnapshot();
      const actorId = initial.players[0]?.id;
      if (actorId === undefined) throw new Error("fixture player missing");
      const settled = settlePassiveProduction(initial, actorId, tick(100_000), BETA_V1_RULESET);
      expect(settled.produced).toMatchObject({ energy: 720, materials: 432, inference: 0 });
      expect(cursorsOf(settled.state)).toEqual([
        [86_400, 0],
        [86_400, 0],
      ]);
      // The 13,600 uncredited ticks were still ahead of the cursor: 22 intervals are credited and
      // the 400 sub-interval ticks stay recorded at the cursor.
      const remainder = settlePassiveProduction(
        settled.state,
        actorId,
        tick(100_000),
        BETA_V1_RULESET,
      );
      expect(remainder.produced).toMatchObject({ energy: 110, materials: 66, inference: 0 });
      expect(cursorsOf(remainder.state)).toEqual([
        [100_000, 400],
        [100_000, 400],
      ]);
      const duplicate = settlePassiveProduction(
        remainder.state,
        actorId,
        tick(100_000),
        BETA_V1_RULESET,
      );
      expect(duplicate.produced).toMatchObject({ energy: 0, materials: 0, inference: 0 });
      expect(duplicate.state).toBe(remainder.state);
      expect(duplicate.events).toEqual([]);
      const nextInterval = settlePassiveProduction(
        duplicate.state,
        actorId,
        tick(100_200),
        BETA_V1_RULESET,
      );
      expect(nextInterval.produced).toMatchObject({ energy: 5, materials: 3, inference: 0 });
      expect(cursorsOf(nextInterval.state)).toEqual([
        [100_200, 0],
        [100_200, 0],
      ]);
    });

    it("credits three idle days as three chunks at the same tick and nothing on a fourth", () => {
      const initial = startingSnapshot();
      const actorId = initial.players[0]?.id;
      if (actorId === undefined) throw new Error("fixture player missing");
      const cap = BETA_V1_RULESET.production.offlineCapTicks;
      const threeDays = tick(3 * cap);
      let state = initial;
      for (let chunk = 1; chunk <= 3; chunk += 1) {
        const settlement = settlePassiveProduction(state, actorId, threeDays, BETA_V1_RULESET);
        expect(settlement.produced).toMatchObject({ energy: 720, materials: 432, inference: 0 });
        expect(settlement.events).toHaveLength(1);
        expect(cursorsOf(settlement.state)).toEqual([
          [chunk * cap, 0],
          [chunk * cap, 0],
        ]);
        state = settlement.state;
      }
      const fourth = settlePassiveProduction(state, actorId, threeDays, BETA_V1_RULESET);
      expect(fourth.produced).toMatchObject({ energy: 0, materials: 0, inference: 0 });
      expect(fourth.events).toEqual([]);
      expect(fourth.state).toBe(state);
      expect(state.players[0]?.inventory.transferable).toMatchObject({
        energy: 2_160,
        materials: 1_296,
        inference: 0,
      });
    });
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
    // A projection shows exactly one settlement chunk, like the settlement a mutation would run.
    const threeDays = tick(3 * BETA_V1_RULESET.production.offlineCapTicks);
    const idle = projectPlayerAt(initial, actor.id, threeDays, BETA_V1_RULESET);
    expect("inventory" in idle && idle.inventory.transferable).toMatchObject({
      energy: 720,
      materials: 432,
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

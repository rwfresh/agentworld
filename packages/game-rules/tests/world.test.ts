import { describe, expect, it } from "vitest";

import {
  BETA_V1_RULESET,
  coordinate,
  coordinatesWithinRadius,
  createWorldDescriptor,
  generateWorldTiles,
  playerId,
  starterPlotForSlot,
  starterPlotSlotAt,
  tileAt,
  worldId,
  zoneAt,
} from "../src/index.ts";

describe("deterministic world generation", () => {
  const world = createWorldDescriptor(worldId("world-one"), "season-seed", BETA_V1_RULESET);

  it("generates the same tiles for the same seed", () => {
    const coordinates = [coordinate(0, 0), coordinate(47, 32), coordinate(96, 96)];
    const first = coordinates.map((value) => tileAt(world, value, BETA_V1_RULESET));
    const secondWorld = createWorldDescriptor(worldId("world-two"), "season-seed", BETA_V1_RULESET);
    const second = coordinates.map((value) => tileAt(secondWorld, value, BETA_V1_RULESET));
    expect(second).toEqual(first);
  });

  it("applies safe, contested, and frontier richness bands", () => {
    const safe = tileAt(world, coordinate(96, 96), BETA_V1_RULESET);
    const contested = tileAt(world, coordinate(40, 96), BETA_V1_RULESET);
    const frontier = tileAt(world, coordinate(0, 0), BETA_V1_RULESET);
    expect(zoneAt(world, safe.coordinate, BETA_V1_RULESET)).toBe("starter");
    expect(Object.values(safe.richness)).toEqual([1, 1, 1]);
    expect(zoneAt(world, contested.coordinate, BETA_V1_RULESET)).toBe("contested");
    expect(Object.values(contested.richness).every((value) => value >= 1 && value <= 2)).toBe(true);
    expect(zoneAt(world, frontier.coordinate, BETA_V1_RULESET)).toBe("frontier");
    expect(Object.values(frontier.richness).every((value) => value >= 2 && value <= 3)).toBe(true);
  });

  it("places 512 non-overflowing two-by-two plots in the center reserve", () => {
    const first = starterPlotForSlot(world, 0, BETA_V1_RULESET, playerId("first"));
    const last = starterPlotForSlot(world, 511, BETA_V1_RULESET, playerId("last"));
    expect(first.origin).toEqual(coordinate(64, 80));
    expect(last.origin).toEqual(coordinate(126, 110));
    expect(first.tiles).toHaveLength(4);
    expect(last.tiles.every((value) => zoneAt(world, value, BETA_V1_RULESET) === "starter")).toBe(
      true,
    );
    expect(() => starterPlotForSlot(world, 512, BETA_V1_RULESET)).toThrow(RangeError);
  });

  it("maps every plot tile back to its slot and nothing else to any slot", () => {
    for (let slot = 0; slot < BETA_V1_RULESET.map.maxStarterPlots; slot += 1) {
      for (const tile of starterPlotForSlot(world, slot, BETA_V1_RULESET).tiles) {
        if (starterPlotSlotAt(world, tile, BETA_V1_RULESET) !== slot) {
          throw new Error(`tile ${tile.x},${tile.y} did not map back to slot ${slot}`);
        }
      }
    }
    expect(starterPlotSlotAt(world, coordinate(64, 111), BETA_V1_RULESET)).toBe(480);
    // Reserve rows above and below the 16 used plot rows hold no plot.
    expect(zoneAt(world, coordinate(96, 70), BETA_V1_RULESET)).toBe("starter");
    expect(starterPlotSlotAt(world, coordinate(96, 70), BETA_V1_RULESET)).toBeUndefined();
    expect(starterPlotSlotAt(world, coordinate(64, 112), BETA_V1_RULESET)).toBeUndefined();
    // Tiles just outside the reserve on either side belong to no plot either.
    expect(starterPlotSlotAt(world, coordinate(63, 80), BETA_V1_RULESET)).toBeUndefined();
    expect(starterPlotSlotAt(world, coordinate(128, 80), BETA_V1_RULESET)).toBeUndefined();
    expect(starterPlotSlotAt(world, coordinate(40, 96), BETA_V1_RULESET)).toBeUndefined();
    expect(starterPlotSlotAt(world, coordinate(0, 0), BETA_V1_RULESET)).toBeUndefined();
  });

  it("uses cardinal-distance visibility and clips it at map edges", () => {
    expect(coordinatesWithinRadius(world, coordinate(96, 96), 3)).toHaveLength(25);
    expect(coordinatesWithinRadius(world, coordinate(0, 0), 3)).toHaveLength(10);
    expect(coordinatesWithinRadius(world, coordinate(-2, 0), 3)).toEqual([
      coordinate(0, 0),
      coordinate(1, 0),
      coordinate(0, 1),
    ]);
  });

  it("bounds visibility work by the world rather than by the requested radius", () => {
    // Without clamping, this would iterate a (2 × 10⁶ + 1)² square before filtering.
    const everything = coordinatesWithinRadius(world, coordinate(0, 0), 1_000_000);
    expect(everything).toHaveLength(192 * 192);
    expect(new Set(everything.map((value) => `${value.x},${value.y}`)).size).toBe(192 * 192);
    expect(
      coordinatesWithinRadius(world, coordinate(96, 96), Number.MAX_SAFE_INTEGER),
    ).toHaveLength(192 * 192);
  });

  it("can materialize every tile exactly once", () => {
    const tiles = generateWorldTiles(world, BETA_V1_RULESET);
    expect(tiles).toHaveLength(192 * 192);
    expect(new Set(tiles.map((tile) => `${tile.coordinate.x},${tile.coordinate.y}`)).size).toBe(
      tiles.length,
    );
  });
});

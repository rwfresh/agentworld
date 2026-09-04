import { describe, expect, it } from "vitest";

import {
  allianceId,
  BETA_V1_RULESET,
  type CivilizationState,
  coordinate,
  decide,
  type GameSnapshot,
  playerId,
  resources,
  type StructureState,
  scorePlayer,
  structureId,
  tick,
  tileAt,
  trustTierAt,
} from "../src/index.ts";
import { startingSnapshot } from "./fixtures.ts";

function combatSnapshot(): GameSnapshot {
  const base = startingSnapshot();
  const template = base.players[0];
  if (template === undefined) throw new Error("fixture player missing");
  const attackerId = playerId("attacker");
  const defenderId = playerId("defender");
  const player = (
    id: typeof attackerId,
    position: ReturnType<typeof coordinate>,
  ): CivilizationState => ({
    ...template,
    id,
    position,
    homePlot: [],
    inventory: { bound: resources(1_000, 1_000, 1_000), transferable: resources() },
    discoveredTileKeys: [],
    persistentTrustTier: 2,
  });
  const structure = (
    id: string,
    ownerId: typeof attackerId,
    position: ReturnType<typeof coordinate>,
    hp = 100,
  ): StructureState => ({
    id: structureId(id),
    ownerId,
    type: "generator",
    coordinate: position,
    status: "active",
    hp,
    lastProductionTick: tick(0),
    productionRemainderTicks: 0,
  });
  return {
    world: base.world,
    players: [player(attackerId, coordinate(50, 50)), player(defenderId, coordinate(52, 50))],
    structures: [
      structure("attacker-generator", attackerId, coordinate(49, 50)),
      structure("target-generator", defenderId, coordinate(51, 50), 30),
    ],
    hostilities: [],
  };
}

describe("hostility and deterministic combat", () => {
  it("gives the aggressor a 15-minute warmup and allows immediate defender retaliation", () => {
    const initial = combatSnapshot();
    const attackerId = initial.players[0]?.id;
    const defenderId = initial.players[1]?.id;
    if (attackerId === undefined || defenderId === undefined) throw new Error("players missing");
    const declared = decide(
      { type: "declare-hostility", actorId: attackerId, defenderId },
      initial,
      BETA_V1_RULESET,
      tick(0),
    );
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    const earlyAttack = decide(
      {
        type: "attack",
        actorId: attackerId,
        targetStructureId: structureId("target-generator"),
      },
      declared.state,
      BETA_V1_RULESET,
      tick(899),
    );
    expect(earlyAttack).toMatchObject({
      ok: false,
      violation: { code: "HOSTILITY_WARMUP", retryAtTick: 900 },
    });
    const attackerStructure = declared.state.structures.find(
      (value) => value.id === structureId("attacker-generator"),
    );
    if (attackerStructure === undefined) throw new Error("attacker structure missing");
    const retaliationState: GameSnapshot = {
      ...declared.state,
      players: declared.state.players.map((value) =>
        value.id === defenderId ? { ...value, position: coordinate(48, 50) } : value,
      ),
    };
    const retaliation = decide(
      {
        type: "attack",
        actorId: defenderId,
        targetStructureId: attackerStructure.id,
      },
      retaliationState,
      BETA_V1_RULESET,
      tick(1),
    );
    expect(retaliation.ok).toBe(true);
  });

  it("keeps the defender's immediate retaliation when both sides have declared", () => {
    const initial = combatSnapshot();
    const attackerId = initial.players[0]?.id;
    const defenderId = initial.players[1]?.id;
    if (attackerId === undefined || defenderId === undefined) throw new Error("players missing");
    const declared = decide(
      { type: "declare-hostility", actorId: attackerId, defenderId },
      initial,
      BETA_V1_RULESET,
      tick(0),
    );
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    const counterDeclared = decide(
      { type: "declare-hostility", actorId: defenderId, defenderId: attackerId },
      declared.state,
      BETA_V1_RULESET,
      tick(10),
    );
    expect(counterDeclared.ok).toBe(true);
    if (!counterDeclared.ok) return;
    const mutual: GameSnapshot = {
      ...counterDeclared.state,
      players: counterDeclared.state.players.map((value) =>
        value.id === defenderId ? { ...value, position: coordinate(48, 50) } : value,
      ),
    };
    // The defender's own declaration (still in warmup) must not cost them their retaliation right.
    const retaliation = decide(
      { type: "attack", actorId: defenderId, targetStructureId: structureId("attacker-generator") },
      mutual,
      BETA_V1_RULESET,
      tick(20),
    );
    expect(retaliation.ok).toBe(true);
    const aggression = decide(
      { type: "attack", actorId: attackerId, targetStructureId: structureId("target-generator") },
      mutual,
      BETA_V1_RULESET,
      tick(20),
    );
    expect(aggression).toMatchObject({
      ok: false,
      violation: { code: "HOSTILITY_WARMUP", retryAtTick: 900 },
    });
  });

  it("never lets withdrawing or re-declaring beat the aggressor's warmup", () => {
    const initial = combatSnapshot();
    const attackerId = initial.players[0]?.id;
    const defenderId = initial.players[1]?.id;
    if (attackerId === undefined || defenderId === undefined) throw new Error("players missing");
    const baited: GameSnapshot = {
      ...initial,
      players: initial.players.map((value) =>
        value.id === defenderId ? { ...value, position: coordinate(48, 50) } : value,
      ),
      hostilities: [
        { aggressorId: attackerId, defenderId, declaredAtTick: tick(0) },
        { aggressorId: defenderId, defenderId: attackerId, declaredAtTick: tick(10) },
      ],
    };
    const withdrawn = decide(
      { type: "withdraw-hostility", actorId: attackerId, defenderId },
      baited,
      BETA_V1_RULESET,
      tick(20),
    );
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    const strike = {
      type: "attack" as const,
      actorId: attackerId,
      targetStructureId: structureId("target-generator"),
    };
    // The standing counter-declaration grants the aggressor nothing after they withdraw...
    expect(decide(strike, withdrawn.state, BETA_V1_RULESET, tick(21))).toMatchObject({
      ok: false,
      violation: { code: "HOSTILITY_NOT_ACTIVE" },
    });
    // ...and the withdrawal is binding, so re-declaring cannot reset who declared first.
    const redeclare = { type: "declare-hostility" as const, actorId: attackerId, defenderId };
    expect(decide(redeclare, withdrawn.state, BETA_V1_RULESET, tick(21))).toMatchObject({
      ok: false,
      violation: { code: "COOLDOWN_ACTIVE", retryAtTick: 920 },
    });
    // The defender keeps retaliating meanwhile.
    expect(
      decide(
        {
          type: "attack",
          actorId: defenderId,
          targetStructureId: structureId("attacker-generator"),
        },
        withdrawn.state,
        BETA_V1_RULESET,
        tick(21),
      ).ok,
    ).toBe(true);
    const renewed = decide(redeclare, withdrawn.state, BETA_V1_RULESET, tick(920));
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    // By now the original warmup has long passed, so responding to the still-active
    // counter-declaration immediately gives away nothing.
    expect(decide(strike, renewed.state, BETA_V1_RULESET, tick(920)).ok).toBe(true);
  });

  it("treats a declaration made after the actor withdrew as fresh aggression", () => {
    const initial = combatSnapshot();
    const attackerId = initial.players[0]?.id;
    const defenderId = initial.players[1]?.id;
    if (attackerId === undefined || defenderId === undefined) throw new Error("players missing");
    const reversed: GameSnapshot = {
      ...initial,
      hostilities: [
        { aggressorId: attackerId, defenderId, declaredAtTick: tick(0), withdrawnAtTick: tick(5) },
        { aggressorId: defenderId, defenderId: attackerId, declaredAtTick: tick(10) },
      ],
    };
    expect(
      decide(
        { type: "attack", actorId: attackerId, targetStructureId: structureId("target-generator") },
        reversed,
        BETA_V1_RULESET,
        tick(11),
      ).ok,
    ).toBe(true);
    const simultaneous: GameSnapshot = {
      ...reversed,
      players: reversed.players.map((value) =>
        value.id === defenderId ? { ...value, position: coordinate(48, 50) } : value,
      ),
      hostilities: [
        { aggressorId: attackerId, defenderId, declaredAtTick: tick(0) },
        { aggressorId: defenderId, defenderId: attackerId, declaredAtTick: tick(0) },
      ],
    };
    for (const [actorId, target] of [
      [attackerId, "target-generator"],
      [defenderId, "attacker-generator"],
    ] as const) {
      expect(
        decide(
          { type: "attack", actorId, targetStructureId: structureId(target) },
          simultaneous,
          BETA_V1_RULESET,
          tick(20),
        ),
      ).toMatchObject({ ok: false, violation: { code: "HOSTILITY_WARMUP", retryAtTick: 900 } });
    }
  });

  it("reports structures that are neither adjacent nor discovered exactly like unknown IDs", () => {
    const initial = combatSnapshot();
    const attacker = initial.players[0];
    const defender = initial.players[1];
    if (attacker === undefined || defender === undefined) throw new Error("players missing");
    const hiddenSite = coordinate(60, 60);
    const hidden: StructureState = {
      id: structureId("hidden-generator"),
      ownerId: defender.id,
      type: "generator",
      coordinate: hiddenSite,
      status: "active",
      hp: 100,
      lastProductionTick: tick(0),
      productionRemainderTicks: 0,
    };
    const hostile: GameSnapshot = {
      ...initial,
      structures: [...initial.structures, hidden],
      hostilities: [{ aggressorId: attacker.id, defenderId: defender.id, declaredAtTick: tick(0) }],
    };
    const attackHidden = {
      type: "attack" as const,
      actorId: attacker.id,
      targetStructureId: hidden.id,
    };
    const unknown = decide(
      { ...attackHidden, targetStructureId: structureId("no-such-structure") },
      hostile,
      BETA_V1_RULESET,
      tick(900),
    );
    const undiscovered = decide(attackHidden, hostile, BETA_V1_RULESET, tick(900));
    expect(undiscovered).toMatchObject({ ok: false, violation: { code: "TARGET_NOT_FOUND" } });
    expect(undiscovered).toEqual(unknown);
    const destroyedHidden: GameSnapshot = {
      ...hostile,
      structures: hostile.structures.map((value) =>
        value.id === hidden.id ? { ...value, status: "destroyed" as const, hp: 0 } : value,
      ),
    };
    expect(decide(attackHidden, destroyedHidden, BETA_V1_RULESET, tick(900))).toEqual(unknown);

    const discovered: GameSnapshot = {
      ...hostile,
      players: hostile.players.map((value) =>
        value.id === attacker.id
          ? { ...value, discoveredTileKeys: [`${hiddenSite.x},${hiddenSite.y}`] }
          : value,
      ),
    };
    expect(decide(attackHidden, discovered, BETA_V1_RULESET, tick(900))).toMatchObject({
      ok: false,
      violation: { code: "TARGET_NOT_ADJACENT" },
    });
    // Adjacent structures are visible through `look`, so they proceed without prior discovery.
    expect(attacker.discoveredTileKeys).toEqual([]);
    expect(
      decide(
        { ...attackHidden, targetStructureId: structureId("target-generator") },
        hostile,
        BETA_V1_RULESET,
        tick(900),
      ).ok,
    ).toBe(true);
  });

  it("destroys an eligible target, spends attack resources, and awards capped combat influence", () => {
    const initial = combatSnapshot();
    const attacker = initial.players[0];
    const defender = initial.players[1];
    if (attacker === undefined || defender === undefined) throw new Error("players missing");
    const hostile: GameSnapshot = {
      ...initial,
      hostilities: [{ aggressorId: attacker.id, defenderId: defender.id, declaredAtTick: tick(0) }],
    };
    const attacked = decide(
      {
        type: "attack",
        actorId: attacker.id,
        targetStructureId: structureId("target-generator"),
      },
      hostile,
      BETA_V1_RULESET,
      tick(900),
    );
    expect(attacked.ok).toBe(true);
    if (!attacked.ok) return;
    const producedEnergy =
      5 * tileAt(initial.world, coordinate(49, 50), BETA_V1_RULESET).richness.energy;
    expect(attacked.resourceChange).toMatchObject({ energy: producedEnergy - 20, inference: -5 });
    expect(
      attacked.state.structures.find((value) => value.id === structureId("target-generator")),
    ).toMatchObject({ status: "destroyed", hp: 0 });
    expect(attacked.state.players.find((value) => value.id === attacker.id)?.combatInfluence).toBe(
      25,
    );
    expect(
      attacked.state.players.find((value) => value.id === defender.id)?.inventory.transferable
        .energy,
    ).toBeGreaterThan(0);
    expect(
      attacked.state.structures.find((value) => value.id === structureId("target-generator"))
        ?.lastProductionTick,
    ).toBe(900);
  });

  it("applies non-stacking defense and rejects allied combat", () => {
    const initial = combatSnapshot();
    const attacker = initial.players[0];
    const defender = initial.players[1];
    if (attacker === undefined || defender === undefined) throw new Error("players missing");
    const defense = (id: string, position: ReturnType<typeof coordinate>): StructureState => ({
      id: structureId(id),
      ownerId: defender.id,
      type: "defense-node",
      coordinate: position,
      status: "active",
      hp: 180,
      lastProductionTick: tick(0),
      productionRemainderTicks: 0,
    });
    const defended: GameSnapshot = {
      ...initial,
      structures: [
        ...initial.structures.map((value) =>
          value.id === structureId("target-generator") ? { ...value, hp: 100 } : value,
        ),
        defense("defense-one", coordinate(52, 50)),
        defense("defense-two", coordinate(51, 51)),
      ],
      hostilities: [{ aggressorId: attacker.id, defenderId: defender.id, declaredAtTick: tick(0) }],
    };
    const attacked = decide(
      {
        type: "attack",
        actorId: attacker.id,
        targetStructureId: structureId("target-generator"),
      },
      defended,
      BETA_V1_RULESET,
      tick(900),
    );
    expect(attacked.ok).toBe(true);
    if (!attacked.ok) return;
    expect(
      attacked.state.structures.find((value) => value.id === structureId("target-generator"))?.hp,
    ).toBe(85);

    const allied: GameSnapshot = {
      ...initial,
      players: initial.players.map((value) => ({ ...value, allianceId: allianceId("alliance") })),
      hostilities: [{ aggressorId: attacker.id, defenderId: defender.id, declaredAtTick: tick(0) }],
    };
    expect(
      decide(
        {
          type: "attack",
          actorId: attacker.id,
          targetStructureId: structureId("target-generator"),
        },
        allied,
        BETA_V1_RULESET,
        tick(900),
      ),
    ).toMatchObject({ ok: false, violation: { code: "ALLIED_TARGET" } });
  });
});

describe("influence and trust", () => {
  it("scores territory, active structures, generated resources, and combat", () => {
    const initial = combatSnapshot();
    const player = initial.players[0];
    if (player === undefined) throw new Error("player missing");
    const scoredPlayer: CivilizationState = {
      ...player,
      earnedResources: resources(100, 100, 50),
      combatInfluence: 25,
    };
    const frontierStructure: StructureState = {
      id: structureId("frontier-extractor"),
      ownerId: player.id,
      type: "extractor",
      coordinate: coordinate(0, 0),
      status: "active",
      hp: 120,
      lastProductionTick: tick(0),
      productionRemainderTicks: 0,
    };
    const snapshot: GameSnapshot = {
      ...initial,
      players: initial.players.map((value) => (value.id === player.id ? scoredPlayer : value)),
      structures: [...initial.structures, frontierStructure],
    };
    expect(scorePlayer(snapshot, player.id, BETA_V1_RULESET)).toEqual({
      territory: 35,
      structures: 25,
      economy: 5,
      combat: 25,
      total: 90,
    });
  });

  it("derives trust from all configured thresholds while preserving earned trust", () => {
    const player = combatSnapshot().players[0];
    if (player === undefined) throw new Error("player missing");
    const fresh = { ...player, persistentTrustTier: 0 as const };
    expect(trustTierAt(fresh, tick(10_000), BETA_V1_RULESET)).toBe(0);
    expect(
      trustTierAt(
        { ...fresh, successfulMutations: 5, completedStructures: 1 },
        tick(10_000),
        BETA_V1_RULESET,
      ),
    ).toBe(1);
    expect(
      trustTierAt(
        {
          ...fresh,
          successfulMutations: 20,
          completedStructures: 1,
          earnedResources: resources(40, 40, 20),
        },
        tick(3_600),
        BETA_V1_RULESET,
      ),
    ).toBe(2);
    expect(trustTierAt({ ...fresh, persistentTrustTier: 2 }, tick(0), BETA_V1_RULESET)).toBe(2);
  });
});

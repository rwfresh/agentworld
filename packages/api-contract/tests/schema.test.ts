import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  AllianceAdministrationResponse,
  AllianceInviteAcceptResponse,
  AllianceInviteResponse,
  AttackRequest,
  InstallationDiscovery,
  InventoryResponse,
  LeaderboardResponse,
  ScanActionReceipt,
  Terrain,
  Zone,
} from "../src/index.ts";

function literalValues(schema: unknown): string[] {
  const union = schema as { readonly anyOf: readonly { readonly const: string }[] };
  return union.anyOf.map((member) => member.const);
}

describe("public game schemas", () => {
  it("keeps terrain synchronized with the rules vocabulary", () => {
    expect(literalValues(Terrain)).toEqual(["plains", "forest", "hills", "wetlands"]);
  });

  it("translates the starter area to the public safe-zone vocabulary", () => {
    expect(literalValues(Zone)).toEqual(["safe", "contested", "frontier"]);
    expect(literalValues(Zone)).not.toContain("starter");
  });

  it("requires a concrete look result on scan receipts", () => {
    expect(ScanActionReceipt.required).toContain("result");
    expect(ScanActionReceipt.properties.result).toMatchObject({ $id: "LookResponse" });
  });

  it("publishes the complete inventory projection", () => {
    expect(InventoryResponse.required).toEqual([
      "total",
      "transferable",
      "bound",
      "escrowed",
      "tick",
    ]);
  });

  it("publishes ranked leaderboard entries with an influence breakdown", () => {
    const entry = LeaderboardResponse.properties.items.items;
    expect(entry.required).toEqual(["rank", "playerId", "name", "influence"]);
    expect(entry.properties.influence.required).toEqual([
      "territory",
      "structures",
      "economy",
      "combat",
      "total",
    ]);
  });

  it("types alliance invitation receipts", () => {
    expect(AllianceInviteResponse.required).toEqual(["inviteId", "expiresAt"]);
  });

  it("types alliance invitation acceptance receipts", () => {
    expect(AllianceInviteAcceptResponse.required).toEqual(["accepted", "allianceId"]);
    expect(AllianceInviteAcceptResponse.properties.accepted).toMatchObject({ const: true });
    expect(AllianceInviteAcceptResponse.additionalProperties).toBe(false);
  });

  it("types alliance administration receipts", () => {
    expect(AllianceAdministrationResponse.required).toEqual(["ok", "operation", "allianceId"]);
    expect(AllianceAdministrationResponse.required).not.toContain("playerId");
    expect(AllianceAdministrationResponse.properties.ok).toMatchObject({ const: true });
    expect(literalValues(AllianceAdministrationResponse.properties.operation)).toEqual([
      "leave",
      "leadership",
      "disband",
    ]);
    expect(Value.Check(AllianceAdministrationResponse.properties.operation, "merge")).toBe(false);
  });

  it("leaves the attack bonus ceiling to the ruleset", () => {
    const bonus = AttackRequest.properties.bonusInference;
    expect(AttackRequest.required).toEqual(["targetStructureId"]);
    expect(bonus).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(Value.Check(bonus, 0)).toBe(true);
    expect(Value.Check(bonus, 11)).toBe(true);
    expect(Value.Check(bonus, Number.MAX_SAFE_INTEGER)).toBe(true);
    for (const rejected of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "4"]) {
      expect(Value.Check(bonus, rejected)).toBe(false);
    }
  });

  it("advertises the endpoints required by OAuth device clients", () => {
    expect(InstallationDiscovery.required).toEqual(
      expect.arrayContaining(["authIssuer", "device_authorization_endpoint", "token_endpoint"]),
    );
  });
});

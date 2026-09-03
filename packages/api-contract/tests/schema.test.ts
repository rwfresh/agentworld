import { describe, expect, it } from "vitest";
import {
  AllianceInviteResponse,
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

  it("advertises the endpoints required by OAuth device clients", () => {
    expect(InstallationDiscovery.required).toEqual(
      expect.arrayContaining(["authIssuer", "device_authorization_endpoint", "token_endpoint"]),
    );
  });
});

import { describe, expect, it } from "vitest";
import { parseInvitationCommand } from "./create-invite.ts";

describe("parseInvitationCommand", () => {
  it("uses secure single-use, seven-day defaults", () => {
    expect(parseInvitationCommand([], { INVITE_CREATED_BY: "ops-primary" })).toEqual({
      kind: "create",
      createdBy: "ops-primary",
      maxUses: 1,
      expiresInHours: 168,
      json: false,
    });
  });

  it("lets explicit options override environment values", () => {
    expect(
      parseInvitationCommand(
        ["--created-by", "release-bot", "--max-uses", "4", "--expires-in-hours", "24", "--json"],
        {
          INVITE_CREATED_BY: "ignored",
          INVITE_MAX_USES: "2",
          INVITE_EXPIRES_HOURS: "48",
        },
      ),
    ).toEqual({
      kind: "create",
      createdBy: "release-bot",
      maxUses: 4,
      expiresInHours: 24,
      json: true,
    });
  });

  it("rejects missing attribution and unsafe bounds", () => {
    expect(() => parseInvitationCommand([], {})).toThrow(/created-by/);
    expect(() => parseInvitationCommand(["--created-by", "ops", "--max-uses", "0"], {})).toThrow(
      /positive integer/,
    );
    expect(() =>
      parseInvitationCommand(["--created-by", "ops", "--expires-in-hours", "8761"], {}),
    ).toThrow(/at most/);
  });

  it("shows help without requiring environment configuration", () => {
    expect(parseInvitationCommand(["--help"], {})).toEqual({ kind: "help" });
  });
});

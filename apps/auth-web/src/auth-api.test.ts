import { describe, expect, it, vi } from "vitest";
import {
  AuthApi,
  authErrorMessage,
  deviceCodeFromLocation,
  normalizeDeviceCode,
  portalReturnUrl,
  registrationNotice,
  safeLocalCallback,
} from "./auth-api.ts";

describe("auth portal boundaries", () => {
  it("normalizes only complete, non-executable device codes", () => {
    expect(normalizeDeviceCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizeDeviceCode("<img src=x>")).toBeUndefined();
    expect(deviceCodeFromLocation("?user_code=AB12-CD34")).toBe("AB12-CD34");
  });

  it("rejects callbacks to a different origin", () => {
    expect(safeLocalCallback("https://evil.test/collect", "https://play.example.test")).toBe(
      "https://play.example.test/authorized",
    );
    expect(safeLocalCallback("/device?user_code=ABCD-EFGH", "https://play.example.test")).toBe(
      "https://play.example.test/device?user_code=ABCD-EFGH",
    );
  });

  it("returns failed sign-ins to this page without stale error parameters", () => {
    expect(
      portalReturnUrl(
        "https://play.example.test/device?user_code=ABCD-EFGH&error=INVITATION_REQUIRED&error_description=x#frag",
        "https://play.example.test",
      ),
    ).toBe("https://play.example.test/device?user_code=ABCD-EFGH");
    expect(portalReturnUrl("https://evil.test/", "https://play.example.test")).toBe(
      "https://play.example.test/",
    );
    expect(portalReturnUrl("http://", "https://play.example.test")).toBe(
      "https://play.example.test/",
    );
  });

  it("posts an approved code with credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const api = new AuthApi(fetchMock);
    await api.decideDevice("abcdefgh", "approve");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/device/approve",
      expect.objectContaining({
        body: JSON.stringify({ userCode: "ABCDEFGH" }),
        credentials: "include",
      }),
    );
  });

  it("sends the error return URL with GitHub and magic-link sign-ins", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ url: "https://github.com/login" })));
    const api = new AuthApi(fetchMock);
    await api.magicLink(
      "player@example.test",
      "https://play.example.test/authorized",
      "AW-CODE",
      "https://play.example.test/",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/sign-in/magic-link",
      expect.objectContaining({
        body: JSON.stringify({
          email: "player@example.test",
          callbackURL: "https://play.example.test/authorized",
          errorCallbackURL: "https://play.example.test/",
          inviteCode: "AW-CODE",
        }),
      }),
    );
  });
});

describe("registration discovery", () => {
  it("reads the registration mode from installation discovery and tolerates failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "Hosted Beta", registration: "invite" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ registration: "sometimes" })))
      .mockRejectedValueOnce(new TypeError("offline"));
    const api = new AuthApi(fetchMock);
    expect(await api.discovery()).toEqual({ name: "Hosted Beta", registration: "invite" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/.well-known/agentworld",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(await api.discovery()).toEqual({});
    expect(await api.discovery()).toBeUndefined();
  });

  it("explains the first-time sign-in path for invite and closed installations", () => {
    expect(registrationNotice("open")).toBeUndefined();
    expect(registrationNotice(undefined)).toBeUndefined();
    expect(registrationNotice("invite")).toMatch(
      /email link .*invitation code.*GitHub sign-in works once/,
    );
    expect(registrationNotice("closed")).toMatch(/Registration is closed/);
  });

  it("maps server error codes to guidance and sanitizes unknown codes", () => {
    expect(authErrorMessage("?user_code=ABCD-EFGH")).toBeUndefined();
    expect(authErrorMessage("?error=INVITATION_REQUIRED")).toMatch(/invitation code/);
    expect(authErrorMessage("?error=REGISTRATION_CLOSED")).toMatch(/closed/);
    expect(authErrorMessage("?error=unable_to_create_user")).toMatch(/invite-only/);
    expect(authErrorMessage("?error=INVALID_TOKEN")).toMatch(/link/);
    expect(authErrorMessage("?error=%3Cimg%20src%3Dx%3E&error_description=ignored")).toBe(
      "Sign-in failed (imgsrcx).",
    );
  });
});

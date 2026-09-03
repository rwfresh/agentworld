import { describe, expect, it, vi } from "vitest";
import {
  AuthApi,
  deviceCodeFromLocation,
  normalizeDeviceCode,
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
});

import { describe, expect, it, vi } from "vitest";
import { AgentWorldHttpClient } from "./http.ts";

describe("AgentWorld HTTP client", () => {
  it("adds authentication, query values, and mutation idempotency", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new AgentWorldHttpClient("https://play.example.test/", "token", fetchMock);
    await client.request("POST", "/v1/worlds/one/actions/move", {
      query: { wait: false },
      body: { direction: "north" },
      idempotencyKey: "action-one",
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://play.example.test/v1/worlds/one/actions/move?wait=false");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer token");
    expect(new Headers(request?.headers).get("idempotency-key")).toBe("action-one");
  });

  it("maps problem responses to stable CLI errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ title: "Too fast", code: "rate_limited" }), { status: 429 }),
      );
    const client = new AgentWorldHttpClient("https://play.example.test", undefined, fetchMock);
    await expect(client.request("GET", "/v1/worlds")).rejects.toMatchObject({
      exitCode: 5,
      problem: { code: "rate_limited", status: 429 },
    });
  });

  it("retries one transport failure with the same mutation idempotency key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new AgentWorldHttpClient("https://play.example.test", "token", fetchMock);

    await client.request("POST", "/v1/worlds/one/actions/scan", { body: {} });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstKey = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key");
    const secondKey = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key");
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it("bounds transport attempts", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    const client = new AgentWorldHttpClient("https://play.example.test", undefined, fetchMock);

    await expect(client.request("GET", "/v1/worlds")).rejects.toMatchObject({
      exitCode: 6,
      problem: { code: "network_error", retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

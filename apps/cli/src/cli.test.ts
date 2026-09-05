import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { createCli } from "./cli.ts";
import { ConfigStore, FileCredentialStore } from "./config.ts";
import { CliError } from "./errors.ts";

const server = "https://play.example.test";

/** A profile bound to world `beta`, with captured output and an optional deadline override. */
async function worldCli(options: {
  readonly fetchMock: Mock<typeof fetch>;
  readonly timeoutMs?: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-world-"));
  const config = new ConfigStore(directory);
  const credentials = new FileCredentialStore(directory);
  await config.putProfile("test", { server, world: "beta" }, true);
  await credentials.set("test", { accessToken: "token", server });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cli = createCli({
    config,
    credentials,
    fetchImplementation: options.fetchMock,
    writer: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { cli, stdout, stderr };
}

function requestBody(fetchMock: Mock<typeof fetch>, call = 0): unknown {
  const body = fetchMock.mock.calls[call]?.[1]?.body;
  return body === undefined ? undefined : JSON.parse(String(body));
}

describe("CLI commands", () => {
  it("never attaches profile credentials to an ad-hoc server override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-origin-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test" }, true);
    await credentials.set("test", {
      accessToken: "origin-bound-secret",
      server: "https://play.example.test",
    });
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(JSON.stringify({ items: [] }));
    });
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: () => undefined, stderr: () => undefined },
    });

    await cli.parseAsync([
      "node",
      "agentworld",
      "--server",
      "https://other.example.test",
      "worlds",
    ]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://other.example.test/v1/worlds");
  });

  it("deletes origin-bound credentials when a profile server changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-profile-origin-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test" }, true);
    await credentials.set("test", {
      accessToken: "origin-bound-secret",
      server: "https://play.example.test",
    });
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: vi.fn<typeof fetch>(),
      writer: { stdout: () => undefined, stderr: () => undefined },
    });

    await cli.parseAsync([
      "node",
      "agentworld",
      "--server",
      "https://other.example.test",
      "profile",
      "add",
      "test",
    ]);

    expect(await credentials.get("test")).toBeUndefined();
    const saved = (await config.load()).profiles.test;
    if (!saved) throw new Error("updated profile is missing");
    expect(saved.server).toBe("https://other.example.test");
  });

  it("sends action JSON to the selected world and emits only JSON to stdout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-command-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test", world: "beta" }, true);
    await credentials.set("test", {
      accessToken: "token",
      server: "https://play.example.test",
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "accepted", actionId: "seven" }), { status: 200 }),
      );
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    });

    await cli.parseAsync(["node", "agentworld", "--json", "move", "north"]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://play.example.test/v1/worlds/beta/actions/move",
    );
    expect(
      await new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]).json(),
    ).toEqual({
      direction: "north",
    });
    expect(JSON.parse(stdout.join(""))).toEqual({ actionId: "seven", status: "accepted" });
    expect(stderr).toEqual([]);
  });

  it.each([
    ["compute-node", "compute_node"],
    ["defense-node", "defense_node"],
  ])("normalizes the %s structure name for the wire", async (input, expected) => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-build-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test", world: "beta" }, true);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "scheduled" }), { status: 200 }));
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: () => undefined, stderr: () => undefined },
    });

    await cli.parseAsync(["node", "agentworld", "build", input]);

    expect(
      await new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]).json(),
    ).toEqual({ structure: expected });
  });

  it.each([
    [
      ["alliances", "accept", "invite-one"],
      "POST",
      "https://play.example.test/v1/worlds/beta/alliance-invites/invite-one/accept",
      {},
    ],
    [
      ["alliances", "leave", "alliance-one"],
      "POST",
      "https://play.example.test/v1/worlds/beta/alliances/alliance-one/leave",
      {},
    ],
    [
      ["alliances", "leadership", "alliance-one", "player-two"],
      "POST",
      "https://play.example.test/v1/worlds/beta/alliances/alliance-one/leadership",
      { playerId: "player-two" },
    ],
    [
      ["alliances", "disband", "alliance-one"],
      "DELETE",
      "https://play.example.test/v1/worlds/beta/alliances/alliance-one",
      undefined,
    ],
  ])("uses the canonical alliance endpoint for %j", async (arguments_, method, url, body) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { cli } = await worldCli({ fetchMock });

    await cli.parseAsync(["node", "agentworld", ...arguments_]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(url);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe(method);
    expect(requestBody(fetchMock)).toEqual(body);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBeTruthy();
  });

  it.each([
    [["alliances", "invites"], "https://play.example.test/v1/worlds/beta/alliance-invites"],
    [["alliance", "invites"], "https://play.example.test/v1/worlds/beta/alliance-invites"],
    [["hostility", "list"], "https://play.example.test/v1/worlds/beta/relationships"],
  ])("issues %j as a plain read and prints the page", async (arguments_, url) => {
    const page = { items: [{ role: "defender", state: "warmup" }] };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));
    const { cli, stdout, stderr } = await worldCli({ fetchMock });

    await cli.parseAsync(["node", "agentworld", "--json", ...arguments_]);

    const [requestUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(url);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("idempotency-key")).toBe(false);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(stdout.join(""))).toEqual(page);
    expect(stderr).toEqual([]);
  });

  it("keeps look a read and no longer offers --scan", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ tiles: [] }), { status: 200 }));
    const { cli } = await worldCli({ fetchMock });

    await cli.parseAsync(["node", "agentworld", "look"]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://play.example.test/v1/worlds/beta/look");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("user-agent")).toBe("agentworld-cli/0.1.0");

    const { cli: second, stderr } = await worldCli({ fetchMock });
    await expect(second.parseAsync(["node", "agentworld", "look", "--scan"])).rejects.toMatchObject(
      { code: "commander.unknownOption" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stderr.join("\n")).toContain("unknown option");
  });

  it.each([
    ["harvest", [], {}],
    ["harvest", ["materials"], { resource: "materials" }],
  ])("sends the typed %s body for %j", async (command, extra, body) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "completed" }), { status: 200 }));
    const { cli } = await worldCli({ fetchMock });

    await cli.parseAsync(["node", "agentworld", command, ...extra]);

    expect(requestBody(fetchMock)).toEqual(body);
  });

  it.each([
    ["move", "up"],
    ["build", "castle"],
    ["harvest", "gold"],
  ])("rejects an unknown %s value locally as a usage error", async (command, value) => {
    const fetchMock = vi.fn<typeof fetch>();
    const { cli } = await worldCli({ fetchMock });

    await expect(cli.parseAsync(["node", "agentworld", command, value])).rejects.toMatchObject({
      exitCode: 2,
      problem: { code: "usage_error" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a non-JSON gateway failure into a network-category problem with the request id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html", "x-request-id": "edge-1" },
      }),
    );
    const { cli, stdout } = await worldCli({ fetchMock });

    await expect(cli.parseAsync(["node", "agentworld", "status"])).rejects.toMatchObject({
      exitCode: 6,
      problem: {
        title: "Request failed (502)",
        status: 502,
        code: "HTTP_502",
        requestId: "edge-1",
        retryable: true,
      },
    });
    expect(stdout).toEqual([]);
  });

  it("applies a per-attempt deadline, retries once with the same key, then fails as a timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const { cli } = await worldCli({ fetchMock, timeoutMs: 5 });

    await expect(cli.parseAsync(["node", "agentworld", "move", "north"])).rejects.toMatchObject({
      exitCode: 6,
      problem: { code: "request_timeout", retryable: true, detail: "No response within 5 ms." },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("idempotency-key"),
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("validates AGENTWORLD_TIMEOUT_MS once at startup", () => {
    vi.stubEnv("AGENTWORLD_TIMEOUT_MS", "soon");
    try {
      expect(() =>
        createCli({ writer: { stdout: () => undefined, stderr: () => undefined } }),
      ).toThrow(CliError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refreshes after a 401, persists rotated credentials, and reuses the mutation key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-refresh-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test", world: "beta" }, true);
    await credentials.set("test", {
      accessToken: "old-access",
      server: "https://play.example.test",
      refreshToken: "old-refresh",
      expiresAt: "2099-09-02T12:00:00.000Z",
    });
    const actionKeys: Array<string | null> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/worlds/beta/actions/move")) {
        actionKeys.push(new Headers(init?.headers).get("idempotency-key"));
        return actionKeys.length === 1
          ? new Response(JSON.stringify({ title: "Expired", code: "INVALID_ACCESS_TOKEN" }), {
              status: 401,
            })
          : new Response(JSON.stringify({ status: "accepted" }));
      }
      if (url.endsWith("/.well-known/agentworld")) {
        return new Response(
          JSON.stringify({
            authIssuer: "https://play.example.test/api/auth",
            token_endpoint: "https://play.example.test/api/auth/oauth2/token",
          }),
        );
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            token_endpoint: "https://play.example.test/api/auth/oauth2/token",
            revocation_endpoint: "https://play.example.test/api/auth/oauth2/revoke",
          }),
        );
      }
      if (url.endsWith("/api/auth/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 600,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: () => undefined, stderr: () => undefined },
    });

    await cli.parseAsync(["node", "agentworld", "move", "north"]);

    expect(actionKeys).toHaveLength(2);
    expect(actionKeys[0]).toBeTruthy();
    expect(actionKeys[1]).toBe(actionKeys[0]);
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe(
      "Bearer new-access",
    );
    expect(await credentials.get("test")).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });

  it("refreshes an access token before an authenticated request when it is expiring", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-preemptive-refresh-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test" }, true);
    await credentials.set("test", {
      accessToken: "old-access",
      server: "https://play.example.test",
      refreshToken: "old-refresh",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/agentworld")) {
        return new Response(
          JSON.stringify({
            token_endpoint: "https://play.example.test/api/auth/oauth2/token",
          }),
        );
      }
      if (url.endsWith("/api/auth/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh" }),
        );
      }
      expect(url).toBe("https://play.example.test/v1/worlds");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-access");
      return new Response(JSON.stringify({ items: [] }));
    });
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: () => undefined, stderr: () => undefined },
    });

    await cli.parseAsync(["node", "agentworld", "worlds"]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await credentials.get("test")).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
  });

  it("revokes the remote refresh token before deleting local credentials on logout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-logout-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test" }, true);
    await credentials.set("test", {
      accessToken: "access",
      server: "https://play.example.test",
      refreshToken: "refresh",
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/agentworld")) {
        return new Response(JSON.stringify({ authIssuer: "https://play.example.test/api/auth" }));
      }
      if (url === "https://play.example.test/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({
            revocation_endpoint: "https://play.example.test/api/auth/oauth2/revoke",
          }),
        );
      }
      expect(url).toBe("https://play.example.test/api/auth/oauth2/revoke");
      expect(new URLSearchParams(String(init?.body)).get("token")).toBe("refresh");
      return new Response(null, { status: 200 });
    });
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: () => undefined, stderr: () => undefined },
    });

    await cli.parseAsync(["node", "agentworld", "logout"]);

    expect(await credentials.get("test")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still removes local credentials when remote revocation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-offline-logout-"));
    const config = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);
    await config.putProfile("test", { server: "https://play.example.test" }, true);
    await credentials.set("test", {
      accessToken: "access",
      server: "https://play.example.test",
      refreshToken: "refresh",
    });
    const stderr: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/agentworld")) {
        return new Response(JSON.stringify({ authIssuer: "https://play.example.test/api/auth" }));
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            revocation_endpoint: "https://play.example.test/api/auth/oauth2/revoke",
          }),
        );
      }
      throw new TypeError("offline");
    });
    const cli = createCli({
      config,
      credentials,
      fetchImplementation: fetchMock,
      writer: { stdout: () => undefined, stderr: (text) => stderr.push(text) },
    });

    await cli.parseAsync(["node", "agentworld", "logout"]);

    expect(await credentials.get("test")).toBeUndefined();
    expect(stderr).toEqual([
      "The authorization server could not revoke the session; local credentials were removed.",
    ]);
  });
});

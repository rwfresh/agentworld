import { AgentWorldApiError } from "@agentworld/api-client";
import { describe, expect, it, vi } from "vitest";
import { CliError, ExitCode } from "./errors.ts";
import {
  callApi,
  defaultTimeoutMs,
  maxTimeoutMs,
  requestTimeoutMs,
  transportFailure,
  withTimeout,
} from "./http.ts";

function capture(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to throw");
}

const timeoutError = () =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

describe("request deadlines", () => {
  it("defaults to thirty seconds and accepts a positive whole-millisecond override", () => {
    expect(defaultTimeoutMs).toBe(30_000);
    expect(requestTimeoutMs({})).toBe(defaultTimeoutMs);
    expect(requestTimeoutMs({ AGENTWORLD_TIMEOUT_MS: "" })).toBe(defaultTimeoutMs);
    expect(requestTimeoutMs({ AGENTWORLD_TIMEOUT_MS: " 45000 " })).toBe(45_000);
    expect(requestTimeoutMs({ AGENTWORLD_TIMEOUT_MS: "1" })).toBe(1);
    expect(requestTimeoutMs({ AGENTWORLD_TIMEOUT_MS: String(maxTimeoutMs) })).toBe(maxTimeoutMs);
  });

  it.each(["0", "-5", "1.5", "abc", "1e3", "0x10", "2147483648", "9007199254740993"])(
    "rejects AGENTWORLD_TIMEOUT_MS=%s as a usage error",
    (value) => {
      const error = capture(() => requestTimeoutMs({ AGENTWORLD_TIMEOUT_MS: value }));
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({
        exitCode: ExitCode.usage,
        problem: { code: "invalid_configuration", retryable: false },
      });
    },
  );

  it("attaches a fresh deadline to every call and keeps the caller's signal", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const timed = withTimeout(fetchMock, 5_000);
    const controller = new AbortController();

    await timed("https://play.example.test/v1/worlds");
    await timed("https://play.example.test/v1/worlds", { signal: controller.signal });

    const first = fetchMock.mock.calls[0]?.[1]?.signal;
    const second = fetchMock.mock.calls[1]?.[1]?.signal;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    expect(second).not.toBe(first);
    controller.abort();
    expect(second?.aborted).toBe(true);
    expect(first?.aborted).toBe(false);
  });

  it("aborts a call that outlives its deadline with a timeout error", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const timed = withTimeout(fetchMock, 1);

    await expect(timed("https://play.example.test/v1/worlds")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("API failure mapping", () => {
  it("passes CLI errors through untouched", async () => {
    const original = new CliError(ExitCode.usage, { title: "Nope", code: "usage_error" });
    await expect(callApi(() => Promise.reject(original), 30_000)).rejects.toBe(original);
  });

  it("maps API problems onto the documented exit categories", async () => {
    const problem = {
      type: "about:blank",
      title: "Too fast",
      status: 429,
      code: "RATE_LIMITED",
      detail: "Slow down.",
      requestId: "req-429",
      retryable: true,
      retryAfter: 3,
    };

    const error = await callApi(
      () => Promise.reject(new AgentWorldApiError(problem)),
      30_000,
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: ExitCode.rateLimit, problem });
  });

  it.each([
    [401, ExitCode.auth],
    [403, ExitCode.auth],
    [400, ExitCode.rule],
    [404, ExitCode.rule],
    [409, ExitCode.rule],
    [422, ExitCode.rule],
    [429, ExitCode.rateLimit],
    [500, ExitCode.network],
    [502, ExitCode.network],
  ])("maps HTTP %i to exit code %i", async (status, exitCode) => {
    const problem = {
      type: "about:blank",
      title: `Request failed (${status})`,
      status,
      code: `HTTP_${status}`,
      detail: "",
      requestId: "",
      retryable: status >= 500,
    };
    await expect(
      callApi(() => Promise.reject(new AgentWorldApiError(problem)), 30_000),
    ).rejects.toMatchObject({ exitCode, problem: { status, code: `HTTP_${status}` } });
  });

  it("maps deadlines to a retryable timeout problem in the network category", async () => {
    expect(transportFailure(timeoutError(), 250)).toMatchObject({
      exitCode: ExitCode.network,
      problem: {
        title: "Could not reach AgentWorld",
        detail: "No response within 250 ms.",
        code: "request_timeout",
        retryable: true,
      },
    });
    await expect(callApi(() => Promise.reject(timeoutError()), 250)).rejects.toMatchObject({
      exitCode: ExitCode.network,
      problem: { code: "request_timeout" },
    });
  });

  it("maps other transport failures to network errors and honours caller titles and codes", () => {
    expect(transportFailure(new TypeError("fetch failed"), 30_000)).toMatchObject({
      exitCode: ExitCode.network,
      problem: { code: "network_error", detail: "fetch failed", retryable: true },
    });
    expect(
      transportFailure(new TypeError("offline"), 30_000, {
        title: "Could not reach the authorization server",
        code: "authorization_network_error",
      }),
    ).toMatchObject({
      problem: {
        title: "Could not reach the authorization server",
        code: "authorization_network_error",
      },
    });
    expect(
      transportFailure(timeoutError(), 30_000, { code: "authorization_network_error" }),
    ).toMatchObject({ problem: { code: "request_timeout" } });
  });
});

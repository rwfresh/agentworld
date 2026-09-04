import { AgentWorldApiError } from "@agentworld/api-client";
import { CliError, ExitCode, exitCodeForStatus } from "./errors.ts";

export type FetchImplementation = typeof globalThis.fetch;

/** Default per-attempt deadline for every outbound request. */
export const defaultTimeoutMs = 30_000;
/** Longest delay Node timers honour; larger values silently collapse to one millisecond. */
export const maxTimeoutMs = 2_147_483_647;

/** Resolve the configured deadline once at startup; a malformed override is a usage error. */
export function requestTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.AGENTWORLD_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return defaultTimeoutMs;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxTimeoutMs) {
    throw new CliError(ExitCode.usage, {
      title: "Invalid CLI configuration",
      detail: `AGENTWORLD_TIMEOUT_MS must be a whole number of milliseconds from 1 to ${maxTimeoutMs}.`,
      code: "invalid_configuration",
      retryable: false,
    });
  }
  return parsed;
}

/** Give every call its own deadline while still honouring a signal the caller attached. */
export function withTimeout(
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
): FetchImplementation {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetchImplementation(input, { ...init, signal });
  };
}

export function isTimeoutError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "TimeoutError"
  );
}

export interface TransportFailureOptions {
  readonly title?: string;
  readonly code?: string;
}

/** Map a failed fetch to the network exit category, distinguishing deadlines from other failures. */
export function transportFailure(
  error: unknown,
  timeoutMs: number,
  options: TransportFailureOptions = {},
): CliError {
  const title = options.title ?? "Could not reach AgentWorld";
  if (isTimeoutError(error)) {
    return new CliError(ExitCode.network, {
      title,
      detail: `No response within ${timeoutMs} ms.`,
      code: "request_timeout",
      retryable: true,
    });
  }
  return new CliError(ExitCode.network, {
    title,
    detail: error instanceof Error ? error.message : String(error),
    code: options.code ?? "network_error",
    retryable: true,
  });
}

/** Run one API client call, translating its failures into CLI exit categories. */
export async function callApi<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof AgentWorldApiError) {
      throw new CliError(exitCodeForStatus(error.problem.status), error.problem);
    }
    throw transportFailure(error, timeoutMs);
  }
}

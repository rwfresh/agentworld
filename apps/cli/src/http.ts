import { randomUUID } from "node:crypto";
import { CliError, ExitCode, exitCodeForStatus, type ProblemDetails } from "./errors.ts";

export type FetchImplementation = typeof globalThis.fetch;

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly authenticated?: boolean;
  readonly idempotencyKey?: string;
}

function problemFromResponse(
  status: number,
  value: unknown,
  requestId: string | null,
): ProblemDetails {
  const input =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  return {
    title: typeof input?.title === "string" ? input.title : `Request failed (${status})`,
    status,
    ...(typeof input?.detail === "string" ? { detail: input.detail } : {}),
    ...(typeof input?.code === "string" ? { code: input.code } : {}),
    ...(typeof input?.requestId === "string"
      ? { requestId: input.requestId }
      : requestId
        ? { requestId }
        : {}),
    ...(typeof input?.retryable === "boolean" ? { retryable: input.retryable } : {}),
    ...(typeof input?.retryAfter === "number" ? { retryAfter: input.retryAfter } : {}),
  };
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return { ok: true };
  const text = await response.text();
  if (text.length === 0) return { ok: true };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export class AgentWorldHttpClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImplementation: FetchImplementation;

  public constructor(
    baseUrl: string,
    token?: string,
    fetchImplementation: FetchImplementation = globalThis.fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetchImplementation = (input, init) => fetchImplementation(input, init);
  }

  public async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.token && options.authenticated !== false) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (method !== "GET") {
      headers.set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
    }

    const requestInit: RequestInit = {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    };
    let response: Response | undefined;
    let transportError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetchImplementation(url, requestInit);
        break;
      } catch (error) {
        transportError = error;
        if (
          typeof DOMException !== "undefined" &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          break;
        }
      }
    }
    if (!response) {
      throw new CliError(ExitCode.network, {
        title: "Could not reach AgentWorld",
        detail: transportError instanceof Error ? transportError.message : String(transportError),
        code: "network_error",
        retryable: true,
      });
    }

    const body = await responseBody(response);
    if (!response.ok) {
      throw new CliError(
        exitCodeForStatus(response.status),
        problemFromResponse(response.status, body, response.headers.get("x-request-id")),
      );
    }
    return body as T;
  }
}

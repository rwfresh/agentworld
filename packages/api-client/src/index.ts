import type {
  ActionReceipt,
  AllianceAdministrationResponse,
  AllianceCreateRequest,
  AllianceInviteAcceptResponse,
  AllianceInviteRequest,
  AllianceInviteResponse,
  AllianceInviteView,
  AllianceLeadershipRequest,
  AllianceView,
  AttackRequest,
  BuildRequest,
  EventSummary,
  HarvestRequest,
  InstallationDiscovery,
  InventoryResponse,
  LeaderboardResponse,
  LookResponse,
  MessageSendReceipt,
  MessageView,
  ModerationState,
  MoveRequest,
  MuteState,
  PlayerStatus,
  PlayerSummary,
  ProblemDetails,
  RelationshipView,
  ReportReceipt,
  ReportRequest,
  ScanActionReceipt,
  SendMessageRequest,
  SpawnRequest,
  TradeOfferRequest,
  TradeView,
  WorldSummary,
} from "@agentworld/api-contract";

/** Per-attempt deadline applied when `ClientOptions.timeoutMs` is omitted. */
export const defaultTimeoutMs = 30_000;
/** Longest delay Node timers honour; larger values silently collapse to one millisecond. */
const maxTimeoutMs = 2_147_483_647;

export interface ClientOptions {
  baseUrl: string;
  accessToken?: string | (() => string | undefined | Promise<string | undefined>);
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  /** Deadline for each transport attempt in milliseconds (1 to 2^31-1); defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Caller-owned cancellation. Aborting rejects with the abort reason and skips the retry. */
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export class AgentWorldApiError extends Error {
  public readonly problem: ProblemDetails;

  public constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = "AgentWorldApiError";
    this.problem = problem;
  }

  public get status(): number {
    return this.problem.status;
  }

  public get code(): string {
    return this.problem.code;
  }

  public get requestId(): string {
    return this.problem.requestId;
  }

  public get retryable(): boolean {
    return this.problem.retryable;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("AgentWorld servers must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new TypeError("Server URLs cannot embed credentials");
  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new TypeError("Remote AgentWorld servers must use HTTPS");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
    throw new TypeError(`timeoutMs must be an integer between 1 and ${maxTimeoutMs} milliseconds`);
  }
  return timeoutMs;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

/**
 * Build a complete problem document from whatever the server sent. Gateways and
 * crashed processes answer with HTML or nothing, so every field falls back to the
 * transport facts: the HTTP status and the `x-request-id` header.
 */
function problemFromResponse(response: Response, payload: unknown): ProblemDetails {
  const status = response.status;
  const input = isRecord(payload) ? payload : {};
  const headerRequestId = response.headers.get("x-request-id");
  const retryAfter = input.retryAfter;
  return {
    type: typeof input.type === "string" ? input.type : "about:blank",
    title: typeof input.title === "string" ? input.title : `Request failed (${status})`,
    status,
    code: typeof input.code === "string" && input.code.length > 0 ? input.code : `HTTP_${status}`,
    detail:
      typeof input.detail === "string"
        ? input.detail
        : typeof input.message === "string"
          ? input.message
          : `The server returned HTTP ${status} without a problem document.`,
    requestId: typeof input.requestId === "string" ? input.requestId : (headerRequestId ?? ""),
    retryable:
      typeof input.retryable === "boolean" ? input.retryable : status >= 500 || status === 429,
    ...(typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter >= 0
      ? { retryAfter }
      : {}),
  };
}

async function decode<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;
  let parsed = false;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (!response.ok) {
    throw new AgentWorldApiError(problemFromResponse(response, parsed ? payload : undefined));
  }
  if (text.length > 0 && !parsed) {
    throw new TypeError(`AgentWorld returned a non-JSON response body (HTTP ${response.status})`);
  }
  return payload as T;
}

function attemptSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * At most two attempts, each with its own deadline and the same headers, so a
 * retried mutation replays the same Idempotency-Key. A caller-owned abort is
 * propagated immediately and never retried.
 */
async function fetchWithTransportRetry(
  fetchImplementation: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  signal?.throwIfAborted();
  try {
    return await fetchImplementation(input, { ...init, signal: attemptSignal(signal, timeoutMs) });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return fetchImplementation(input, { ...init, signal: attemptSignal(signal, timeoutMs) });
  }
}

interface TransportOptions extends RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  query?: URLSearchParams;
}

export class AgentWorldClient {
  readonly #baseUrl: string;
  readonly #token: ClientOptions["accessToken"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string | undefined;
  readonly #timeoutMs: number;

  public constructor(options: ClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = options.accessToken;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImplementation(input, init);
    this.#userAgent = options.userAgent;
    this.#timeoutMs = normalizeTimeout(options.timeoutMs);
  }

  async #resolveToken(): Promise<string | undefined> {
    return typeof this.#token === "function" ? this.#token() : this.#token;
  }

  async #request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: TransportOptions = {},
  ): Promise<T> {
    const token = await this.#resolveToken();
    const headers = new Headers({ accept: "application/json" });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    if (this.#userAgent && "process" in globalThis) headers.set("user-agent", this.#userAgent);

    const query = options.query?.toString();
    const response = await fetchWithTransportRetry(
      this.#fetch,
      `${this.#baseUrl}${path}${query ? `?${query}` : ""}`,
      {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      this.#timeoutMs,
      options.signal,
    );
    return decode<T>(response);
  }

  #page<T>(
    worldId: string,
    resource: string,
    cursor: string | undefined,
    options: RequestOptions | undefined,
  ): Promise<Page<T>> {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/${resource}`, {
      query,
      ...options,
    });
  }

  #action<T extends ActionReceipt = ActionReceipt>(
    worldId: string,
    action: string,
    body: unknown,
    key: string,
    options: RequestOptions | undefined,
  ): Promise<T> {
    return this.#request<T>("POST", `/v1/worlds/${encodePath(worldId)}/actions/${action}`, {
      body,
      idempotencyKey: key,
      ...options,
    });
  }

  public discover(options?: RequestOptions): Promise<InstallationDiscovery> {
    return this.#request("GET", "/.well-known/agentworld", { ...options });
  }

  public worlds(options?: RequestOptions): Promise<Page<WorldSummary>> {
    return this.#request("GET", "/v1/worlds", { ...options });
  }

  public spawn(
    worldId: string,
    request: SpawnRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<PlayerSummary> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/players`, {
      body: request,
      idempotencyKey: key,
      ...options,
    });
  }

  public status(worldId: string, options?: RequestOptions): Promise<PlayerStatus> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/me/status`, { ...options });
  }

  public inventory(worldId: string, options?: RequestOptions): Promise<InventoryResponse> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/me/inventory`, {
      ...options,
    });
  }

  public look(worldId: string, options?: RequestOptions): Promise<LookResponse> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/look`, { ...options });
  }

  public map(
    worldId: string,
    cursor?: string,
    options?: RequestOptions,
  ): Promise<Page<LookResponse["tiles"][number]>> {
    return this.#page(worldId, "map", cursor, options);
  }

  public players(
    worldId: string,
    cursor?: string,
    options?: RequestOptions,
  ): Promise<Page<PlayerSummary>> {
    return this.#page(worldId, "players", cursor, options);
  }

  public events(
    worldId: string,
    cursor?: string,
    options?: RequestOptions,
  ): Promise<Page<EventSummary>> {
    return this.#page(worldId, "events", cursor, options);
  }

  public leaderboard(worldId: string, options?: RequestOptions): Promise<LeaderboardResponse> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/leaderboard`, { ...options });
  }

  public move(
    worldId: string,
    request: MoveRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<ActionReceipt> {
    return this.#action(worldId, "move", request, key, options);
  }

  public build(
    worldId: string,
    request: BuildRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<ActionReceipt> {
    return this.#action(worldId, "build", request, key, options);
  }

  public harvest(
    worldId: string,
    request: HarvestRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<ActionReceipt> {
    return this.#action(worldId, "harvest", request, key, options);
  }

  public scan(worldId: string, key: string, options?: RequestOptions): Promise<ScanActionReceipt> {
    return this.#action<ScanActionReceipt>(worldId, "scan", {}, key, options);
  }

  public attack(
    worldId: string,
    request: AttackRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<ActionReceipt> {
    return this.#action(worldId, "attack", request, key, options);
  }

  public messages(
    worldId: string,
    cursor?: string,
    options?: RequestOptions,
  ): Promise<Page<MessageView>> {
    return this.#page(worldId, "messages", cursor, options);
  }

  public sendMessage(
    worldId: string,
    request: SendMessageRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<MessageSendReceipt> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/messages`, {
      body: request,
      idempotencyKey: key,
      ...options,
    });
  }

  public setBlock(
    worldId: string,
    playerId: string,
    blocked: boolean,
    key: string,
    options?: RequestOptions,
  ): Promise<ModerationState> {
    return this.#request(
      blocked ? "PUT" : "DELETE",
      `/v1/worlds/${encodePath(worldId)}/blocks/${encodePath(playerId)}`,
      { idempotencyKey: key, ...options },
    );
  }

  public setMute(
    worldId: string,
    channelId: string,
    muted: boolean,
    key: string,
    options?: RequestOptions,
  ): Promise<MuteState> {
    return this.#request(
      muted ? "PUT" : "DELETE",
      `/v1/worlds/${encodePath(worldId)}/mutes/${encodePath(channelId)}`,
      { idempotencyKey: key, ...options },
    );
  }

  public report(
    worldId: string,
    report: ReportRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<ReportReceipt> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/reports`, {
      body: report,
      idempotencyKey: key,
      ...options,
    });
  }

  public trades(worldId: string, options?: RequestOptions): Promise<Page<TradeView>> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/trades`, { ...options });
  }

  public offerTrade(
    worldId: string,
    request: TradeOfferRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<TradeView> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/trades`, {
      body: request,
      idempotencyKey: key,
      ...options,
    });
  }

  public resolveTrade(
    worldId: string,
    tradeId: string,
    resolution: "accept" | "cancel",
    key: string,
    options?: RequestOptions,
  ): Promise<TradeView> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/trades/${encodePath(tradeId)}/${resolution}`,
      { body: {}, idempotencyKey: key, ...options },
    );
  }

  public alliances(worldId: string, options?: RequestOptions): Promise<Page<AllianceView>> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/alliances`, { ...options });
  }

  /** The caller's pending, unexpired alliance invitations. */
  public allianceInvites(
    worldId: string,
    options?: RequestOptions,
  ): Promise<Page<AllianceInviteView>> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/alliance-invites`, {
      ...options,
    });
  }

  public createAlliance(
    worldId: string,
    request: AllianceCreateRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<AllianceView> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/alliances`, {
      body: request,
      idempotencyKey: key,
      ...options,
    });
  }

  public inviteToAlliance(
    worldId: string,
    allianceId: string,
    request: AllianceInviteRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<AllianceInviteResponse> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/alliances/${encodePath(allianceId)}/invites`,
      { body: request, idempotencyKey: key, ...options },
    );
  }

  public acceptAllianceInvite(
    worldId: string,
    inviteId: string,
    key: string,
    options?: RequestOptions,
  ): Promise<AllianceInviteAcceptResponse> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/alliance-invites/${encodePath(inviteId)}/accept`,
      { body: {}, idempotencyKey: key, ...options },
    );
  }

  public leaveAlliance(
    worldId: string,
    allianceId: string,
    key: string,
    options?: RequestOptions,
  ): Promise<AllianceAdministrationResponse> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/alliances/${encodePath(allianceId)}/leave`,
      { body: {}, idempotencyKey: key, ...options },
    );
  }

  public transferAllianceLeadership(
    worldId: string,
    allianceId: string,
    request: AllianceLeadershipRequest,
    key: string,
    options?: RequestOptions,
  ): Promise<AllianceAdministrationResponse> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/alliances/${encodePath(allianceId)}/leadership`,
      { body: request, idempotencyKey: key, ...options },
    );
  }

  public disbandAlliance(
    worldId: string,
    allianceId: string,
    key: string,
    options?: RequestOptions,
  ): Promise<AllianceAdministrationResponse> {
    return this.#request(
      "DELETE",
      `/v1/worlds/${encodePath(worldId)}/alliances/${encodePath(allianceId)}`,
      { idempotencyKey: key, ...options },
    );
  }

  /** Every hostility declaration in which the caller is the aggressor or the defender. */
  public relationships(worldId: string, options?: RequestOptions): Promise<Page<RelationshipView>> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/relationships`, {
      ...options,
    });
  }

  public setHostility(
    worldId: string,
    playerId: string,
    hostile: boolean,
    key: string,
    options?: RequestOptions,
  ): Promise<ActionReceipt> {
    return this.#request(
      hostile ? "PUT" : "DELETE",
      `/v1/worlds/${encodePath(worldId)}/relationships/${encodePath(playerId)}/hostility`,
      { body: hostile ? {} : undefined, idempotencyKey: key, ...options },
    );
  }
}

export function createClient(options: ClientOptions): AgentWorldClient {
  return new AgentWorldClient(options);
}

export type * from "@agentworld/api-contract";

import type {
  ActionReceipt,
  AllianceCreateRequest,
  AllianceInviteRequest,
  AllianceInviteResponse,
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
  ReportReceipt,
  ReportRequest,
  ScanActionReceipt,
  SendMessageRequest,
  SpawnRequest,
  TradeOfferRequest,
  TradeView,
  WorldSummary,
} from "@agentworld/api-contract";

export interface ClientOptions {
  baseUrl: string;
  accessToken?: string | (() => string | undefined | Promise<string | undefined>);
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
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

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

async function fetchWithTransportRetry(
  fetchImplementation: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImplementation(input, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fetchImplementation(input, init);
  }
}

export class AgentWorldClient {
  readonly #baseUrl: string;
  readonly #token: ClientOptions["accessToken"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string | undefined;

  public constructor(options: ClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = options.accessToken;
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImplementation(input, init);
    this.#userAgent = options.userAgent;
  }

  async #resolveToken(): Promise<string | undefined> {
    return typeof this.#token === "function" ? this.#token() : this.#token;
  }

  async #request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { body?: unknown; idempotencyKey?: string; query?: URLSearchParams } = {},
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
    );

    const payload: unknown = response.status === 204 ? undefined : await response.json();
    if (!response.ok) throw new AgentWorldApiError(payload as ProblemDetails);
    return payload as T;
  }

  public discover(): Promise<InstallationDiscovery> {
    return this.#request("GET", "/.well-known/agentworld");
  }

  public worlds(): Promise<Page<WorldSummary>> {
    return this.#request("GET", "/v1/worlds");
  }

  public spawn(worldId: string, request: SpawnRequest, key: string): Promise<PlayerSummary> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/players`, {
      body: request,
      idempotencyKey: key,
    });
  }

  public status(worldId: string): Promise<PlayerStatus> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/me/status`);
  }

  public inventory(worldId: string): Promise<InventoryResponse> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/me/inventory`);
  }

  public look(worldId: string): Promise<LookResponse> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/look`);
  }

  public map(worldId: string, cursor?: string): Promise<Page<LookResponse["tiles"][number]>> {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/map`, { query });
  }

  public players(worldId: string, cursor?: string): Promise<Page<PlayerSummary>> {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/players`, { query });
  }

  public events(worldId: string, cursor?: string): Promise<Page<EventSummary>> {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/events`, { query });
  }

  public leaderboard(worldId: string): Promise<LeaderboardResponse> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/leaderboard`);
  }

  public move(worldId: string, request: MoveRequest, key: string): Promise<ActionReceipt> {
    return this.#action(worldId, "move", request, key);
  }

  public build(worldId: string, request: BuildRequest, key: string): Promise<ActionReceipt> {
    return this.#action(worldId, "build", request, key);
  }

  public harvest(worldId: string, request: HarvestRequest, key: string): Promise<ActionReceipt> {
    return this.#action(worldId, "harvest", request, key);
  }

  public scan(worldId: string, key: string): Promise<ScanActionReceipt> {
    return this.#action<ScanActionReceipt>(worldId, "scan", {}, key);
  }

  public attack(worldId: string, request: AttackRequest, key: string): Promise<ActionReceipt> {
    return this.#action(worldId, "attack", request, key);
  }

  #action<T extends ActionReceipt = ActionReceipt>(
    worldId: string,
    action: string,
    body: unknown,
    key: string,
  ): Promise<T> {
    return this.#request<T>("POST", `/v1/worlds/${encodePath(worldId)}/actions/${action}`, {
      body,
      idempotencyKey: key,
    });
  }

  public messages(worldId: string, cursor?: string): Promise<Page<MessageView>> {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/messages`, { query });
  }

  public sendMessage(
    worldId: string,
    request: SendMessageRequest,
    key: string,
  ): Promise<MessageSendReceipt> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/messages`, {
      body: request,
      idempotencyKey: key,
    });
  }

  public setBlock(
    worldId: string,
    playerId: string,
    blocked: boolean,
    key: string,
  ): Promise<ModerationState> {
    return this.#request(
      blocked ? "PUT" : "DELETE",
      `/v1/worlds/${encodePath(worldId)}/blocks/${encodePath(playerId)}`,
      { idempotencyKey: key },
    );
  }

  public setMute(
    worldId: string,
    channelId: string,
    muted: boolean,
    key: string,
  ): Promise<MuteState> {
    return this.#request(
      muted ? "PUT" : "DELETE",
      `/v1/worlds/${encodePath(worldId)}/mutes/${encodePath(channelId)}`,
      { idempotencyKey: key },
    );
  }

  public report(worldId: string, report: ReportRequest, key: string): Promise<ReportReceipt> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/reports`, {
      body: report,
      idempotencyKey: key,
    });
  }

  public trades(worldId: string): Promise<Page<TradeView>> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/trades`);
  }

  public offerTrade(worldId: string, request: TradeOfferRequest, key: string): Promise<TradeView> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/trades`, {
      body: request,
      idempotencyKey: key,
    });
  }

  public resolveTrade(
    worldId: string,
    tradeId: string,
    resolution: "accept" | "cancel",
    key: string,
  ): Promise<TradeView> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/trades/${encodePath(tradeId)}/${resolution}`,
      { body: {}, idempotencyKey: key },
    );
  }

  public alliances(worldId: string): Promise<Page<AllianceView>> {
    return this.#request("GET", `/v1/worlds/${encodePath(worldId)}/alliances`);
  }

  public createAlliance(
    worldId: string,
    request: AllianceCreateRequest,
    key: string,
  ): Promise<AllianceView> {
    return this.#request("POST", `/v1/worlds/${encodePath(worldId)}/alliances`, {
      body: request,
      idempotencyKey: key,
    });
  }

  public inviteToAlliance(
    worldId: string,
    allianceId: string,
    request: AllianceInviteRequest,
    key: string,
  ): Promise<AllianceInviteResponse> {
    return this.#request(
      "POST",
      `/v1/worlds/${encodePath(worldId)}/alliances/${encodePath(allianceId)}/invites`,
      { body: request, idempotencyKey: key },
    );
  }

  public setHostility(
    worldId: string,
    playerId: string,
    hostile: boolean,
    key: string,
  ): Promise<ActionReceipt> {
    return this.#request(
      hostile ? "PUT" : "DELETE",
      `/v1/worlds/${encodePath(worldId)}/relationships/${encodePath(playerId)}/hostility`,
      { body: hostile ? {} : undefined, idempotencyKey: key },
    );
  }
}

export function createClient(options: ClientOptions): AgentWorldClient {
  return new AgentWorldClient(options);
}

export type * from "@agentworld/api-contract";

import type { StoredCredentials } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import {
  defaultTimeoutMs,
  type FetchImplementation,
  transportFailure,
  withTimeout,
} from "./http.ts";

const clientId = "agentworld-cli";
const refreshLeewayMilliseconds = 30_000;
const authorizationServerTitle = "Could not reach the authorization server";

interface AgentWorldDiscovery {
  readonly authIssuer?: string;
  readonly token_endpoint?: string;
  readonly revocation_endpoint?: string;
}

interface AuthorizationServerMetadata {
  readonly token_endpoint?: string;
  readonly revocation_endpoint?: string;
}

interface OAuthEndpoints {
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
}

export interface RefreshCredentialsOptions {
  readonly server: string;
  readonly credentials: StoredCredentials;
  readonly fetchImplementation?: FetchImplementation;
  readonly now?: () => number;
  /** Per-request deadline in milliseconds; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export interface RevokeCredentialsOptions {
  readonly server: string;
  readonly credentials: StoredCredentials;
  readonly fetchImplementation?: FetchImplementation;
  /** Per-request deadline in milliseconds; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export type RevocationResult = "revoked" | "unavailable" | "failed";

function authError(title: string, detail: string, code: string): CliError {
  return new CliError(ExitCode.auth, { title, detail, code, retryable: false });
}

function networkError(error: unknown, timeoutMs: number): CliError {
  return transportFailure(error, timeoutMs, {
    title: authorizationServerTitle,
    code: "authorization_network_error",
  });
}

async function decodeObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function webEndpoint(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const endpoint = new URL(value, `${base.replace(/\/$/, "")}/`);
    const server = new URL(base);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return undefined;
    if (server.protocol === "https:" && endpoint.protocol !== "https:") return undefined;
    return endpoint.toString();
  } catch {
    return undefined;
  }
}

async function optionalJson(
  url: string,
  fetchImplementation: FetchImplementation,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchImplementation(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    return response.ok ? await decodeObject(response) : undefined;
  } catch {
    return undefined;
  }
}

async function discoverOAuthEndpoints(
  serverValue: string,
  fetchImplementation: FetchImplementation,
  requiredEndpoint: "token" | "revocation",
): Promise<OAuthEndpoints> {
  const server = serverValue.replace(/\/$/, "");
  const installation = (await optionalJson(
    `${server}/.well-known/agentworld`,
    fetchImplementation,
  )) as AgentWorldDiscovery | undefined;
  const authIssuer = webEndpoint(installation?.authIssuer, server) ?? server;
  let tokenEndpoint = webEndpoint(installation?.token_endpoint, authIssuer);
  let revocationEndpoint = webEndpoint(installation?.revocation_endpoint, authIssuer);

  if (
    (requiredEndpoint === "token" && tokenEndpoint) ||
    (requiredEndpoint === "revocation" && revocationEndpoint)
  ) {
    return {
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
    };
  }

  const metadataUrls = new Set<string>([
    `${server}/.well-known/oauth-authorization-server`,
    new URL(
      ".well-known/oauth-authorization-server",
      `${authIssuer.replace(/\/$/, "")}/`,
    ).toString(),
  ]);
  for (const metadataUrl of metadataUrls) {
    const metadata = (await optionalJson(metadataUrl, fetchImplementation)) as
      | AuthorizationServerMetadata
      | undefined;
    tokenEndpoint ??= webEndpoint(metadata?.token_endpoint, authIssuer);
    revocationEndpoint ??= webEndpoint(metadata?.revocation_endpoint, authIssuer);
    if (
      (requiredEndpoint === "token" && tokenEndpoint) ||
      (requiredEndpoint === "revocation" && revocationEndpoint)
    ) {
      break;
    }
  }

  return {
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
  };
}

export function shouldRefreshCredentials(
  credentials: StoredCredentials,
  now = Date.now(),
): boolean {
  if (!credentials.refreshToken || credentials.expiresAt === undefined) return false;
  const expiresAt = Date.parse(credentials.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now + refreshLeewayMilliseconds;
}

export async function refreshCredentials(
  options: RefreshCredentialsOptions,
): Promise<StoredCredentials> {
  if (!options.credentials.refreshToken) {
    throw authError(
      "Login required",
      "The stored session cannot be refreshed. Run 'agentworld login' again.",
      "refresh_token_missing",
    );
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const fetchImplementation = withTimeout(
    options.fetchImplementation ?? globalThis.fetch,
    timeoutMs,
  );
  const endpoints = await discoverOAuthEndpoints(options.server, fetchImplementation, "token");
  if (!endpoints.tokenEndpoint) {
    throw authError(
      "Login required",
      "The server did not advertise an OAuth token endpoint. Run 'agentworld login' again.",
      "token_endpoint_unavailable",
    );
  }

  let response: Response;
  try {
    response = await fetchImplementation(endpoints.tokenEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: options.credentials.refreshToken,
        client_id: clientId,
        resource: options.server.replace(/\/$/, ""),
      }),
      redirect: "error",
    });
  } catch (error) {
    throw networkError(error, timeoutMs);
  }
  const body = await decodeObject(response);
  if (!response.ok) {
    const oauthCode = typeof body.error === "string" ? body.error : "refresh_failed";
    throw authError(
      "Login required",
      oauthCode === "invalid_grant"
        ? "The saved session has expired or was revoked. Run 'agentworld login' again."
        : typeof body.error_description === "string"
          ? body.error_description
          : `The authorization server returned ${response.status}.`,
      oauthCode,
    );
  }

  const accessToken = body.access_token ?? body.accessToken;
  const tokenType = body.token_type ?? body.tokenType;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer")
  ) {
    throw authError(
      "Invalid authorization response",
      "The authorization server returned an invalid access token response.",
      "invalid_token_response",
    );
  }

  const refreshToken = body.refresh_token ?? body.refreshToken;
  const expiresIn = body.expires_in ?? body.expiresIn;
  const scope = body.scope;
  const now = options.now ?? Date.now;
  const expiration =
    typeof expiresIn === "number" && Number.isSafeInteger(expiresIn) && expiresIn > 0
      ? new Date(now() + expiresIn * 1_000)
      : undefined;
  const expiresAt =
    expiration && Number.isFinite(expiration.getTime()) ? expiration.toISOString() : undefined;
  return {
    accessToken,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.length > 0
        ? refreshToken
        : options.credentials.refreshToken,
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof scope === "string"
      ? { scope }
      : options.credentials.scope
        ? { scope: options.credentials.scope }
        : {}),
  };
}

export async function revokeCredentials(
  options: RevokeCredentialsOptions,
): Promise<RevocationResult> {
  const token = options.credentials.refreshToken ?? options.credentials.accessToken;
  if (!token) return "unavailable";
  const fetchImplementation = withTimeout(
    options.fetchImplementation ?? globalThis.fetch,
    options.timeoutMs ?? defaultTimeoutMs,
  );
  try {
    const endpoints = await discoverOAuthEndpoints(
      options.server,
      fetchImplementation,
      "revocation",
    );
    if (!endpoints.revocationEndpoint) return "unavailable";
    const response = await fetchImplementation(endpoints.revocationEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        token,
        token_type_hint: options.credentials.refreshToken ? "refresh_token" : "access_token",
      }),
      redirect: "error",
    });
    return response.ok ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}

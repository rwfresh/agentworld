import { spawn } from "node:child_process";
import { CliError, ExitCode } from "./errors.ts";
import type { FetchImplementation } from "./http.ts";

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly scope?: string;
}

interface DiscoveryDocument {
  readonly authIssuer?: string;
  readonly device_authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly auth?: {
    readonly deviceAuthorizationEndpoint?: string;
    readonly tokenEndpoint?: string;
  };
}

export interface DeviceFlowOptions {
  readonly server: string;
  readonly scopes: readonly string[];
  readonly fetchImplementation?: FetchImplementation;
  readonly openBrowser?: (url: string) => Promise<void>;
  readonly notify?: (message: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

function authError(title: string, detail: string, code: string): CliError {
  return new CliError(ExitCode.auth, { title, detail, code, retryable: false });
}

function absoluteWebEndpoint(base: string, endpoint: string, resourceServer: string): string {
  let resolved: URL;
  try {
    resolved = new URL(endpoint, `${base.replace(/\/$/, "")}/`);
  } catch {
    throw authError(
      "Invalid authorization endpoint",
      "The server advertised a malformed authorization URL.",
      "invalid_authorization_endpoint",
    );
  }
  const resourceProtocol = new URL(resourceServer).protocol;
  if (
    (resolved.protocol !== "https:" && resolved.protocol !== "http:") ||
    (resourceProtocol === "https:" && resolved.protocol !== "https:")
  ) {
    throw authError(
      "Unsafe authorization endpoint",
      "An HTTPS server may advertise only HTTPS authorization URLs.",
      "invalid_authorization_endpoint",
    );
  }
  return resolved.toString();
}

async function decodeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function requiredString(input: Record<string, unknown>, snake: string, camel: string): string {
  const value = input[snake] ?? input[camel];
  if (typeof value !== "string" || value.length === 0) {
    throw authError(
      "Invalid authorization response",
      `Missing '${snake}'.`,
      "invalid_device_response",
    );
  }
  return value;
}

export function parseDeviceAuthorization(input: Record<string, unknown>): DeviceAuthorization {
  const complete = input.verification_uri_complete ?? input.verificationUriComplete;
  const expires = input.expires_in ?? input.expiresIn;
  const interval = input.interval;
  return {
    deviceCode: requiredString(input, "device_code", "deviceCode"),
    userCode: requiredString(input, "user_code", "userCode"),
    verificationUri: requiredString(input, "verification_uri", "verificationUri"),
    ...(typeof complete === "string" ? { verificationUriComplete: complete } : {}),
    expiresIn: typeof expires === "number" && expires > 0 ? expires : 600,
    interval: typeof interval === "number" && interval > 0 ? interval : 5,
  };
}

export async function openSystemBrowser(url: string): Promise<void> {
  const [command, arguments_] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  await new Promise<void>((resolve) => {
    const child = spawn(command, arguments_, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function loginWithDevice(options: DeviceFlowOptions): Promise<TokenSet> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const notify = options.notify ?? (() => undefined);
  const server = options.server.replace(/\/$/, "");

  let discovery: DiscoveryDocument = {};
  try {
    const response = await fetchImplementation(`${server}/.well-known/agentworld`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) discovery = (await response.json()) as DiscoveryDocument;
  } catch {
    // The documented local defaults still allow development servers without discovery.
  }

  const authServer = absoluteWebEndpoint(server, discovery.authIssuer ?? server, server);
  const deviceEndpoint = absoluteWebEndpoint(
    authServer,
    discovery.device_authorization_endpoint ??
      discovery.auth?.deviceAuthorizationEndpoint ??
      "/api/auth/device/code",
    server,
  );
  const tokenEndpoint = absoluteWebEndpoint(
    authServer,
    discovery.token_endpoint ?? discovery.auth?.tokenEndpoint ?? "/api/auth/device/token",
    server,
  );
  const requestedScopes = [...new Set([...options.scopes, "offline_access"])];
  const requestBody = new URLSearchParams({
    client_id: "agentworld-cli",
    scope: requestedScopes.join(" "),
    resource: server,
  });
  const deviceResponse = await fetchImplementation(deviceEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: requestBody,
  });
  const deviceBody = await decodeJson(deviceResponse);
  if (!deviceResponse.ok) {
    throw authError(
      "Could not start device login",
      typeof deviceBody.error_description === "string"
        ? deviceBody.error_description
        : `Authorization server returned ${deviceResponse.status}.`,
      typeof deviceBody.error === "string" ? deviceBody.error : "device_authorization_failed",
    );
  }

  const authorization = parseDeviceAuthorization(deviceBody);
  const approvalUrl = authorization.verificationUriComplete ?? authorization.verificationUri;
  const parsedApprovalUrl = absoluteWebEndpoint(authServer, approvalUrl, server);
  const verificationUrl = absoluteWebEndpoint(authServer, authorization.verificationUri, server);
  notify(`Open ${verificationUrl} and confirm code ${authorization.userCode}`);
  if (options.openBrowser) await options.openBrowser(parsedApprovalUrl);

  const deadline = now() + authorization.expiresIn * 1_000;
  let interval = authorization.interval;
  while (now() < deadline) {
    await sleep(interval * 1_000);
    const response = await fetchImplementation(tokenEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: authorization.deviceCode,
        client_id: "agentworld-cli",
        resource: server,
      }),
    });
    const body = await decodeJson(response);
    if (response.ok) {
      const expiresIn = body.expires_in ?? body.expiresIn;
      const refreshToken = body.refresh_token ?? body.refreshToken;
      return {
        accessToken: requiredString(body, "access_token", "accessToken"),
        ...(typeof refreshToken === "string" ? { refreshToken } : {}),
        ...(typeof expiresIn === "number" ? { expiresIn } : {}),
        ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      };
    }

    const error = body.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") {
      throw authError("Login denied", "The device request was denied.", "access_denied");
    }
    if (error === "expired_token") break;
    throw authError(
      "Device login failed",
      typeof body.error_description === "string"
        ? body.error_description
        : `Authorization server returned ${response.status}.`,
      typeof error === "string" ? error : "token_request_failed",
    );
  }
  throw authError(
    "Device code expired",
    "Run 'agentworld login' to request a new code.",
    "expired_token",
  );
}

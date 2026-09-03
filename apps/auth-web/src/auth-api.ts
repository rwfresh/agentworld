export type AuthFetch = typeof globalThis.fetch;

export class AuthApiError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
  }
}

export interface Session {
  readonly user?: {
    readonly name?: string;
    readonly email?: string;
  };
}

export interface DeviceRequest {
  readonly user_code: string;
  readonly status: "pending" | "approved" | "denied";
  readonly client_id?: string;
  readonly scope?: string;
}

async function responseValue(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorMessage(value: Record<string, unknown>, fallback: string): string {
  if (typeof value.message === "string") return value.message;
  if (typeof value.error_description === "string") return value.error_description;
  if (typeof value.error === "string") return value.error;
  return fallback;
}

export function normalizeDeviceCode(value: string): string | undefined {
  const compact = value.toUpperCase().replaceAll(/[\s-]/g, "");
  if (!/^[A-Z0-9]{8}$/.test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function deviceCodeForRequest(value: string): string | undefined {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{8}$/.test(code) || /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : undefined;
}

export function deviceCodeFromLocation(search: string): string | undefined {
  const raw = new URLSearchParams(search).get("user_code");
  return raw ? normalizeDeviceCode(raw) : undefined;
}

export function safeLocalCallback(value: string | null, origin: string): string {
  if (!value) return `${origin}/authorized`;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.toString() : `${origin}/authorized`;
  } catch {
    return `${origin}/authorized`;
  }
}

export class AuthApi {
  private readonly basePath: string;
  private readonly fetchImplementation: AuthFetch;

  public constructor(fetchImplementation: AuthFetch = globalThis.fetch, basePath = "/api/auth") {
    this.fetchImplementation = (input, init) => fetchImplementation(input, init);
    this.basePath = basePath.replace(/\/$/, "");
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImplementation(`${this.basePath}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await responseValue(response);
    if (!response.ok) {
      throw new AuthApiError(
        errorMessage(value, `Authorization failed (${response.status}).`),
        response.status,
      );
    }
    return value;
  }

  public async session(): Promise<Session | undefined> {
    const response = await this.fetchImplementation(`${this.basePath}/get-session`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 404) return undefined;
    if (!response.ok) return undefined;
    const value = await responseValue(response);
    return value as Session;
  }

  public async device(userCode: string): Promise<DeviceRequest> {
    const requestCode = deviceCodeForRequest(userCode);
    if (!requestCode)
      throw new AuthApiError("Enter the complete eight-character device code.", 400);
    const query = new URLSearchParams({ user_code: requestCode });
    const response = await this.fetchImplementation(`${this.basePath}/device?${query.toString()}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const value = await responseValue(response);
    if (!response.ok) {
      throw new AuthApiError(
        errorMessage(value, `Could not inspect the device request (${response.status}).`),
        response.status,
      );
    }
    return value as unknown as DeviceRequest;
  }

  public async github(callbackURL: string): Promise<string> {
    const value = await this.post("/sign-in/social", {
      provider: "github",
      callbackURL,
      disableRedirect: true,
    });
    if (typeof value.url !== "string") {
      throw new AuthApiError("The authorization service did not return a GitHub sign-in URL.", 502);
    }
    const url = new URL(value.url, window.location.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new AuthApiError("The authorization service returned an unsafe sign-in URL.", 502);
    }
    return url.toString();
  }

  public async magicLink(email: string, callbackURL: string, inviteCode?: string): Promise<void> {
    await this.post("/sign-in/magic-link", {
      email,
      callbackURL,
      ...(inviteCode ? { inviteCode } : {}),
    });
  }

  public async decideDevice(userCode: string, decision: "approve" | "deny"): Promise<void> {
    const requestCode = deviceCodeForRequest(userCode);
    if (!requestCode)
      throw new AuthApiError("Enter the complete eight-character device code.", 400);
    await this.post(`/device/${decision}`, { userCode: requestCode });
  }
}

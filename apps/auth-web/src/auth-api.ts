export type AuthFetch = typeof globalThis.fetch;

export type RegistrationMode = "open" | "invite" | "closed";

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

/** The subset of `GET /.well-known/agentworld` the portal acts on. */
export interface InstallationDiscovery {
  readonly name?: string;
  readonly registration?: RegistrationMode;
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

function registrationMode(value: unknown): RegistrationMode | undefined {
  return value === "open" || value === "invite" || value === "closed" ? value : undefined;
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

/** Where a failed sign-in returns: this page on the same origin, without stale error parameters. */
export function portalReturnUrl(href: string, origin: string): string {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return `${origin}/`;
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    url.hash = "";
    return url.toString();
  } catch {
    return `${origin}/`;
  }
}

const invitationRequiredMessage =
  "No account exists for this identity yet. Request the email link with a valid invitation code first; GitHub sign-in works once the account exists.";
const registrationClosedMessage =
  "Registration is closed on this installation. Only existing accounts can sign in.";
const creationFailedMessage =
  "The account could not be created. On an invite-only installation, request the email link with an invitation code first.";

const authErrorMessages: Readonly<Record<string, string>> = {
  INVITATION_REQUIRED: invitationRequiredMessage,
  REGISTRATION_CLOSED: registrationClosedMessage,
  new_user_signup_disabled: registrationClosedMessage,
  signup_disabled: registrationClosedMessage,
  unable_to_create_user: creationFailedMessage,
  failed_to_create_user: creationFailedMessage,
  INVALID_TOKEN: "This sign-in link is invalid or has already been used. Request a new one.",
  EXPIRED_TOKEN: "This sign-in link has expired. Request a new one.",
  access_denied: "Sign-in was cancelled at the identity provider.",
};

/**
 * Better Auth sends the browser back with `?error=<code>` after a rejected sign-up or callback.
 * Known codes map to explicit guidance; unknown codes are shown as a sanitized identifier only.
 */
export function authErrorMessage(search: string): string | undefined {
  const code = new URLSearchParams(search).get("error");
  if (!code) return undefined;
  const known = authErrorMessages[code];
  if (known) return known;
  const safeCode = code.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "unknown";
  return `Sign-in failed (${safeCode}).`;
}

export function registrationNotice(registration: RegistrationMode | undefined): string | undefined {
  switch (registration) {
    case "invite":
      return "Invite-only installation: a first-time sign-in must use the email link together with an invitation code. GitHub sign-in works once your account exists.";
    case "closed":
      return "Registration is closed on this installation. Existing accounts can still sign in; new accounts are not created.";
    default:
      return undefined;
  }
}

export class AuthApi {
  private readonly basePath: string;
  private readonly discoveryPath: string;
  private readonly fetchImplementation: AuthFetch;

  public constructor(
    fetchImplementation: AuthFetch = globalThis.fetch,
    basePath = "/api/auth",
    discoveryPath = "/.well-known/agentworld",
  ) {
    this.fetchImplementation = (input, init) => fetchImplementation(input, init);
    this.basePath = basePath.replace(/\/$/, "");
    this.discoveryPath = discoveryPath;
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

  /** Unauthenticated installation metadata; failures degrade to the open-registration UI. */
  public async discovery(): Promise<InstallationDiscovery | undefined> {
    try {
      const response = await this.fetchImplementation(this.discoveryPath, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return undefined;
      const value = await responseValue(response);
      const registration = registrationMode(value.registration);
      return {
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(registration ? { registration } : {}),
      };
    } catch {
      return undefined;
    }
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

  public async github(callbackURL: string, errorCallbackURL?: string): Promise<string> {
    const value = await this.post("/sign-in/social", {
      provider: "github",
      callbackURL,
      ...(errorCallbackURL ? { errorCallbackURL } : {}),
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

  public async magicLink(
    email: string,
    callbackURL: string,
    inviteCode?: string,
    errorCallbackURL?: string,
  ): Promise<void> {
    await this.post("/sign-in/magic-link", {
      email,
      callbackURL,
      ...(errorCallbackURL ? { errorCallbackURL } : {}),
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

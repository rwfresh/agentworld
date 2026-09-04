import { createPool } from "@agentworld/db";
import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { jwt, magicLink } from "better-auth/plugins";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import nodemailer from "nodemailer";
import { v7 as uuidv7 } from "uuid";
import type { AppConfig, RegistrationMode } from "./config.ts";
import { emailHash, invitationHash, normalizeEmail } from "./invitation-code.ts";
import { HttpProblem } from "./problem.ts";

export const gameScopes = [
  "world:read",
  "world:act",
  "social:write",
  "trade:write",
  "combat:write",
] as const;
export type GameScope = (typeof gameScopes)[number];

export interface Principal {
  readonly userId: string;
  readonly scopes: ReadonlySet<string>;
}

export interface AuthRuntime {
  readonly mode: AppConfig["authMode"];
  authenticate(request: FastifyRequest, requiredScopes: readonly GameScope[]): Promise<Principal>;
  registerRoutes(app: FastifyInstance): Promise<void>;
  close(): Promise<void>;
}

export interface InvitationQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

/** The narrow slice of a `pg` pool or client that the invitation flow depends on. */
export interface InvitationQueryRunner {
  query(text: string, values?: readonly unknown[]): Promise<InvitationQueryResult>;
}

export interface InvitationConnectionPool extends InvitationQueryRunner {
  connect(): Promise<InvitationQueryRunner & { release(error?: Error): void }>;
}

/** Runs as Better Auth's `user.create.before` hook; it throws instead of returning `false` so the failure reason survives. */
export type RegistrationGate = (user: { readonly email: string }) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length).trim();
}

function scopedPrincipal(userId: string, scope: unknown): Principal {
  const scopes = new Set(
    Array.isArray(scope)
      ? scope.filter((value): value is string => typeof value === "string")
      : typeof scope === "string"
        ? scope.split(" ").filter(Boolean)
        : [],
  );
  return { userId, scopes };
}

function assertScopes(principal: Principal, required: readonly GameScope[]): void {
  const missing = required.filter((scope) => !principal.scopes.has(scope));
  if (missing.length > 0) {
    throw new HttpProblem(
      403,
      "INSUFFICIENT_SCOPE",
      `Missing required scope: ${missing.join(" ")}`,
    );
  }
}

function registerDevelopmentRoutes(app: FastifyInstance, config: AppConfig): void {
  app.post("/api/auth/device/code", async () => ({
    device_code: "local-development-device",
    user_code: "LOCAL-DEV",
    verification_uri: `${config.baseUrl}/device?user_code=LOCAL-DEV`,
    verification_uri_complete: `${config.baseUrl}/device?user_code=LOCAL-DEV`,
    expires_in: 600,
    interval: 1,
  }));
  app.post("/api/auth/device/token", async () => ({
    access_token: "dev:local-user",
    token_type: "Bearer",
    expires_in: 36_000,
    scope: gameScopes.join(" "),
  }));
  app.get("/api/auth/get-session", async () => ({
    user: { id: "local-user", name: "Local Operator", email: "local@agentworld.invalid" },
  }));
  app.post("/api/auth/device/approve", async () => ({ success: true }));
  app.post("/api/auth/device/deny", async () => ({ success: true }));
  app.post("/api/auth/sign-in/magic-link", async () => ({ success: true }));
}

function withAuthSearchPath(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c search_path=auth");
  return url.toString();
}

export function canonicalAuthRequestUrl(baseUrl: string, requestTarget: string): URL {
  const configuredOrigin = new URL(baseUrl).origin;
  const url = new URL(requestTarget, `${configuredOrigin}/`);
  if (url.origin !== configuredOrigin) {
    throw new HttpProblem(400, "INVALID_AUTH_REQUEST_URL", "The auth request URL is invalid");
  }
  return url;
}

function stringField(result: InvitationQueryResult, field: string): string | undefined {
  const value = result.rows[0]?.[field];
  return typeof value === "string" ? value : undefined;
}

/** Returns the id of an unexpired reservation for the hashed email, if one exists. */
export async function findActiveReservation(
  runner: InvitationQueryRunner,
  hashedEmail: string,
): Promise<string | undefined> {
  const result = await runner.query(
    `select id from public.invitation_reservations
     where email_hash = $1 and expires_at > now()
     order by expires_at desc limit 1`,
    [hashedEmail],
  );
  return stringField(result, "id");
}

/**
 * Consumes one invitation use and binds it to the normalized email for 24 hours. Repeated requests
 * inside that window reuse the reservation. Only the SHA-256 email digest is stored; the audit row
 * references the invitation and reservation, never the address.
 */
export async function reserveInvitation(
  pool: InvitationConnectionPool,
  emailValue: string,
  codeValue: unknown,
): Promise<void> {
  const hashedEmail = emailHash(emailValue);
  if (typeof codeValue !== "string" || codeValue.trim().length < 4) {
    throw new HttpProblem(403, "INVITATION_REQUIRED", "A valid invitation code is required");
  }
  const client = await pool.connect();
  let connectionFailure: Error | undefined;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `agentworld-invite:${hashedEmail}`,
    ]);
    if ((await findActiveReservation(client, hashedEmail)) === undefined) {
      const invitation = await client.query(
        `update public.invitations set uses = uses + 1
         where code_hash = $1 and revoked_at is null
           and (expires_at is null or expires_at > now()) and uses < max_uses
         returning id`,
        [invitationHash(codeValue)],
      );
      const invitationId = stringField(invitation, "id");
      if (invitationId === undefined) {
        throw new HttpProblem(403, "INVITATION_INVALID", "The invitation is invalid or exhausted");
      }
      const reservation = await client.query(
        `insert into public.invitation_reservations
           (id, invitation_id, email_hash, reserved_at, expires_at)
         values ($1, $2, $3, now(), now() + interval '24 hours')
         on conflict (invitation_id, email_hash) do update
           set reserved_at = excluded.reserved_at, expires_at = excluded.expires_at
         returning id`,
        [uuidv7(), invitationId, hashedEmail],
      );
      await client.query(
        `insert into public.security_audit
           (id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, null, 'invitation_reserved', 'invitation', $2, $3::jsonb)`,
        [
          uuidv7(),
          invitationId,
          JSON.stringify({ reservationId: stringField(reservation, "id") ?? null }),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      // The original failure is the actionable one; a connection that cannot roll back is discarded.
      connectionFailure =
        rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    client.release(connectionFailure);
  }
}

/**
 * Fail-closed registration for every sign-up path, including first-time GitHub OAuth. Throwing a
 * coded `APIError` makes Better Auth redirect the browser back with `error=<code>`, whereas
 * returning `false` would surface only a generic user-creation failure.
 */
export function createRegistrationGate(
  mode: RegistrationMode,
  runner: InvitationQueryRunner,
): RegistrationGate {
  return async (user) => {
    if (mode === "open") return;
    if (mode === "closed") {
      throw APIError.from("FORBIDDEN", {
        code: "REGISTRATION_CLOSED",
        message: "Registration is closed; only existing accounts can sign in",
      });
    }
    if ((await findActiveReservation(runner, emailHash(user.email))) === undefined) {
      throw APIError.from("FORBIDDEN", {
        code: "INVITATION_REQUIRED",
        message:
          "First-time sign-in requires the email link with a valid invitation code; GitHub sign-in works once the account exists",
      });
    }
  };
}

export function createAuthRuntime(config: AppConfig): AuthRuntime {
  if (config.authMode === "development") {
    return {
      mode: "development",
      async authenticate(request, requiredScopes) {
        const token = bearerToken(request);
        if (!token?.startsWith("dev:") || token.length <= 4) {
          throw new HttpProblem(
            401,
            "AUTHENTICATION_REQUIRED",
            "Use a local development bearer token",
          );
        }
        const principal: Principal = { userId: token.slice(4), scopes: new Set(gameScopes) };
        assertScopes(principal, requiredScopes);
        return principal;
      },
      async registerRoutes(app) {
        registerDevelopmentRoutes(app, config);
      },
      async close() {},
    };
  }

  const authPool = createPool(withAuthSearchPath(config.databaseUrl));
  const transporter = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : undefined;
  const socialProviders =
    config.githubClientId && config.githubClientSecret
      ? {
          github: {
            clientId: config.githubClientId,
            clientSecret: config.githubClientSecret,
          },
        }
      : undefined;
  const auth = betterAuth({
    appName: "AgentWorld",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    database: authPool,
    secret: config.authSecret,
    trustedOrigins: [config.baseUrl],
    ...(config.registrationMode === "open"
      ? {}
      : {
          databaseHooks: {
            user: {
              create: {
                before: createRegistrationGate(config.registrationMode, authPool),
              },
            },
          },
        }),
    ...(socialProviders ? { socialProviders } : {}),
    plugins: [
      jwt(),
      magicLink({
        expiresIn: 600,
        storeToken: "hashed",
        disableSignUp: false,
        async sendMagicLink({ email, url }) {
          if (!transporter) {
            throw new Error("SMTP_URL is required to send a magic link");
          }
          await transporter.sendMail({
            from: config.emailFrom,
            to: email,
            subject: "Enter AgentWorld",
            text: `Your AgentWorld sign-in link is ${url}\n\nThis link expires in 10 minutes.`,
          });
        },
      }),
      oauthProvider({
        loginPage: "/",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "offline_access", ...gameScopes],
        resources: [
          {
            identifier: config.baseUrl,
            accessTokenTtl: 600,
            allowedScopes: [...gameScopes],
          },
        ],
        enforcePerClientResources: false,
        accessTokenExpiresIn: 600,
        refreshTokenExpiresIn: 7_776_000,
      }) as unknown as ReturnType<typeof jwt>,
      oauthDeviceAuthorization({
        verificationUri: "/device",
        expiresIn: "10m",
        interval: "5s",
      }) as unknown as ReturnType<typeof jwt>,
    ],
  });
  const verifyBearerToken = oauthProviderResourceClient(auth).getActions().verifyBearerToken;

  return {
    mode: "better-auth",
    async authenticate(request, requiredScopes) {
      const token = bearerToken(request);
      if (!token)
        throw new HttpProblem(401, "AUTHENTICATION_REQUIRED", "A bearer token is required");
      try {
        const claims = await verifyBearerToken(token, {
          verifyOptions: { audience: config.baseUrl },
          requiredScopes,
        });
        if (typeof claims.sub !== "string" || claims.sub.length === 0) {
          throw new Error("access token is missing its subject");
        }
        const principal = scopedPrincipal(claims.sub, claims.scope);
        assertScopes(principal, requiredScopes);
        return principal;
      } catch (error) {
        if (error instanceof HttpProblem) throw error;
        throw new HttpProblem(
          401,
          "INVALID_ACCESS_TOKEN",
          "The access token is invalid or expired",
        );
      }
    },
    async registerRoutes(app) {
      const forward = async (request: FastifyRequest, reply: FastifyReply, path = request.url) => {
        const isMagicLinkRequest =
          request.method === "POST" && path.startsWith("/api/auth/sign-in/magic-link");
        if (
          isMagicLinkRequest &&
          config.registrationMode !== "open" &&
          request.body &&
          typeof request.body === "object"
        ) {
          const input = request.body as Record<string, unknown>;
          if (typeof input.email === "string") {
            const email = normalizeEmail(input.email);
            const knownUser = await authPool.query(
              `select id from "user" where lower(email) = $1`,
              [email],
            );
            if (knownUser.rowCount === 0) {
              if (config.registrationMode === "closed") {
                return reply.code(200).send({ status: true });
              }
              try {
                await reserveInvitation(authPool, email, input.inviteCode);
              } catch (error) {
                if (error instanceof HttpProblem && error.status === 403) {
                  return reply.code(200).send({ status: true });
                }
                throw error;
              }
            }
          }
        }
        const url = canonicalAuthRequestUrl(config.baseUrl, path);
        const headers = fromNodeHeaders(request.headers);
        headers.delete("content-length");
        const body =
          request.body === undefined
            ? undefined
            : typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body);
        const response = await auth.handler(
          new Request(url, {
            method: request.method,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
        );
        if (isMagicLinkRequest && response.ok) {
          return reply.code(200).send({ status: true });
        }
        reply.code(response.status);
        for (const [key, value] of response.headers) reply.header(key, value);
        const setCookies = response.headers.getSetCookie();
        if (setCookies.length > 0) reply.header("set-cookie", setCookies);
        return reply.send(Buffer.from(await response.arrayBuffer()));
      };
      app.route({
        method: ["GET", "POST"],
        url: "/api/auth/*",
        config: { rateLimit: { max: 30, timeWindow: "1 minute", groupId: "auth" } },
        handler: forward,
      });
      app.get(
        "/.well-known/oauth-authorization-server",
        { config: { rateLimit: false } },
        (request, reply) =>
          forward(request, reply, "/api/auth/.well-known/oauth-authorization-server"),
      );
    },
    async close() {
      await authPool.end();
    },
  };
}

export function requireScopes(auth: AuthRuntime, scopes: readonly GameScope[]) {
  return async (request: FastifyRequest): Promise<void> => {
    request.principal = await auth.authenticate(request, scopes);
  };
}

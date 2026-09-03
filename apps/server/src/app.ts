import { timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@agentworld/db";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { type AuthRuntime, createAuthRuntime } from "./auth.ts";
import type { AppConfig } from "./config.ts";
import { GameService } from "./game-service.ts";
import { createApiMetrics } from "./metrics.ts";
import { HttpProblem, sendProblem } from "./problem.ts";
import { registerGameRoutes } from "./routes.ts";
import { SocialService } from "./social-service.ts";

export interface AppDependencies {
  readonly config: AppConfig;
  readonly database: Kysely<Database>;
  readonly auth?: AuthRuntime;
  readonly logger?: boolean;
  readonly serveAuthWeb?: boolean;
}

/** Deliberately omits URL, address, headers, body, and query-bearing fields. */
export function safeRequestLog(request: { readonly method?: string }): { readonly method: string } {
  return { method: request.method ?? "UNKNOWN" };
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const loggerEnabled = dependencies.logger ?? dependencies.config.nodeEnv !== "test";
  const app = Fastify({
    logger: loggerEnabled
      ? {
          serializers: { req: safeRequestLog },
          redact: {
            paths: [
              "req.headers",
              "req.body",
              "request.headers",
              "request.body",
              "headers.authorization",
              "authorization",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
    trustProxy:
      dependencies.config.trustProxyHops === 0
        ? false
        : (_address: string, hop: number) => hop < dependencies.config.trustProxyHops,
    bodyLimit: 32 * 1_024,
    requestIdHeader: "x-request-id",
    genReqId(request) {
      const candidate = request.headers["x-request-id"];
      return typeof candidate === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
        ? candidate
        : crypto.randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });
  const authRuntime = dependencies.auth ?? createAuthRuntime(dependencies.config);
  const metrics = createApiMetrics();
  const game = new GameService(dependencies.database, dependencies.config);
  const social = new SocialService(game, dependencies.database);
  const rateLimitRedis = dependencies.config.redisUrl
    ? new Redis(dependencies.config.redisUrl, {
        connectTimeout: 2_000,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      })
    : undefined;
  if (rateLimitRedis) {
    rateLimitRedis.on("error", (error: Error) =>
      app.log.error({ error }, "rate-limit store error"),
    );
    await rateLimitRedis.connect();
  }

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  await app.register(cors, {
    origin: dependencies.config.baseUrl,
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: dependencies.config.nodeEnv === "production" ? [] : null,
      },
    },
    ...(dependencies.config.nodeEnv === "production" ? {} : { strictTransportSecurity: false }),
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, {
    global: true,
    max: 180,
    timeWindow: "1 minute",
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
    skipOnError: false,
    errorResponseBuilder(request, context) {
      return {
        type: "https://agentworld.dev/problems/rate-limited",
        title: "Rate Limited",
        status: 429,
        code: "RATE_LIMITED",
        detail: "Too many requests; wait before trying again",
        requestId: request.id,
        retryable: true,
        retryAfter: Math.max(1, Math.ceil(context.ttl / 1_000)),
      };
    },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "AgentWorld API",
        description: "Authoritative multiplayer API for AI-native civilizations",
        version: "1.0.0-beta.1",
      },
      servers: [{ url: dependencies.config.baseUrl }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });
  if (dependencies.config.nodeEnv !== "production") {
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }

  app.addHook("onResponse", async (request, reply) => {
    metrics.observeHttp({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1_000,
    });
  });

  app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/metrics", { config: { rateLimit: false } }, async (request, reply) => {
    if (
      dependencies.config.nodeEnv === "production" &&
      (!dependencies.config.metricsToken ||
        !tokenMatches(request.headers.authorization, dependencies.config.metricsToken))
    ) {
      return sendProblem(reply, new HttpProblem(404, "NOT_FOUND", "Route not found"), request.id);
    }
    reply.header("content-type", metrics.contentType);
    return metrics.render();
  });
  let readinessCache: { readonly checkedAt: number; readonly ready: boolean } | undefined;
  app.get("/ready", { config: { rateLimit: false } }, async (_request, reply) => {
    const cached = readinessCache;
    if (cached && Date.now() - cached.checkedAt < 5_000) {
      return cached.ready ? { status: "ready" } : reply.code(503).send({ status: "not_ready" });
    }
    try {
      const bootstrap = await sql<{ worldId: string }>`
        select w.id as "worldId"
        from installations i
        join worlds w on w.home_server_id = i.id
        where w.state in ('scheduled', 'active', 'finalizing')
          and length(w.seed) >= 32
          and length(w.ruleset_hash) = 64
          and exists (select 1 from regions r where r.world_id = w.id)
          and exists (select 1 from starter_plots p where p.world_id = w.id)
          and exists (select 1 from tiles t where t.world_id = w.id)
        order by w.season_number desc
        limit 1
      `.execute(dependencies.database);
      if (!bootstrap.rows[0]?.worldId) throw new Error("installation is not bootstrapped");
      if (rateLimitRedis) await rateLimitRedis.ping();
      if (dependencies.config.authMode === "better-auth") {
        const oauth = await sql<{ configured: boolean }>`
          select exists (
            select 1
            from auth."oauthClient" c
            join auth."oauthClientResource" cr on cr."clientId" = c."clientId"
            join auth."oauthResource" r on r.identifier = cr."resourceId"
            where c."clientId" = 'agentworld-cli'
              and c.disabled = false
              and r.disabled = false
              and r.identifier = ${dependencies.config.baseUrl}
          ) as configured
        `.execute(dependencies.database);
        if (oauth.rows[0]?.configured !== true) throw new Error("OAuth bootstrap is incomplete");
      }
      readinessCache = { checkedAt: Date.now(), ready: true };
      return { status: "ready" };
    } catch {
      readinessCache = { checkedAt: Date.now(), ready: false };
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: dependencies.config.baseUrl,
    authorization_servers: [
      dependencies.config.authMode === "better-auth"
        ? `${dependencies.config.baseUrl}/api/auth`
        : dependencies.config.baseUrl,
    ],
    scopes_supported: ["world:read", "world:act", "social:write", "trade:write", "combat:write"],
    bearer_methods_supported: ["header"],
  }));

  await authRuntime.registerRoutes(app);
  await registerGameRoutes(app, game, social, authRuntime);

  if (dependencies.serveAuthWeb !== false) {
    let authWebExists = true;
    try {
      await access(path.join(dependencies.config.authWebDirectory, "index.html"));
    } catch {
      authWebExists = false;
      app.log.warn(
        { directory: dependencies.config.authWebDirectory },
        "auth web build not found; API-only mode enabled",
      );
    }
    if (authWebExists) {
      await app.register(staticPlugin, {
        root: dependencies.config.authWebDirectory,
        prefix: "/",
        wildcard: false,
      });
      const sendApp = (_request: unknown, reply: { sendFile(name: string): unknown }) =>
        reply.sendFile("index.html");
      app.get("/device", sendApp);
      app.get("/consent", sendApp);
      app.get("/authorized", sendApp);
    }
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });
  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, new HttpProblem(404, "NOT_FOUND", "Route not found"), request.id),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpProblem) return sendProblem(reply, error, request.id);
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      return sendProblem(
        reply,
        new HttpProblem(
          400,
          "VALIDATION_ERROR",
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Request validation failed",
        ),
        request.id,
      );
    }
    if ((error as { code?: string }).code === "23505") {
      return sendProblem(
        reply,
        new HttpProblem(409, "CONFLICT", "The requested state already exists"),
        request.id,
      );
    }
    request.log.error({ error }, "unhandled request error");
    return sendProblem(
      reply,
      new HttpProblem(500, "INTERNAL_ERROR", "An unexpected server error occurred", true),
      request.id,
    );
  });
  app.addHook("onClose", async () => {
    await authRuntime.close();
    if (rateLimitRedis) await rateLimitRedis.quit();
  });
  return app;
}

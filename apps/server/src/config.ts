import path from "node:path";
import { fileURLToPath } from "node:url";

export type AuthMode = "better-auth" | "development";
export type RegistrationMode = "open" | "invite" | "closed";

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly trustProxyHops: number;
  readonly databaseUrl: string;
  readonly redisUrl?: string;
  readonly baseUrl: string;
  readonly installationName: string;
  readonly authMode: AuthMode;
  readonly authSecret: string;
  readonly worldSeedSecret: string;
  readonly metricsToken?: string;
  readonly registrationMode: RegistrationMode;
  readonly githubClientId?: string;
  readonly githubClientSecret?: string;
  readonly smtpUrl?: string;
  readonly emailFrom: string;
  readonly authWebDirectory: string;
  readonly rulesetPath: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const LOCAL_DATABASE_URL = "postgres://agentworld:agentworld_dev@127.0.0.1:5432/agentworld";

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: string,
): value is Values[number] {
  return values.includes(value);
}

function enumValue<const Values extends readonly string[]>(
  env: Environment,
  key: string,
  values: Values,
  fallback: Values[number],
): Values[number] {
  const value = env[key] ?? fallback;
  if (!isOneOf(values, value)) throw new Error(`${key} must be one of: ${values.join(", ")}`);
  return value;
}

/** The Compose development credentials must never be reachable from a production process. */
function databaseUrl(value: string | undefined, nodeEnv: AppConfig["nodeEnv"]): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  if (nodeEnv === "production") {
    throw new Error("DATABASE_URL is required in production; no development fallback is applied");
  }
  return LOCAL_DATABASE_URL;
}

function portValue(value: string | undefined): number {
  const port = Number(value ?? 3_000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function trustProxyHops(value: string | undefined): number {
  const hops = Number(value ?? 0);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 2) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 2");
  }
  return hops;
}

function normalizedUrl(value: string, key: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
}

function optionalPair(
  env: Environment,
  first: string,
  second: string,
): readonly [string | undefined, string | undefined] {
  const left = env[first];
  const right = env[second];
  if ((left === undefined) !== (right === undefined)) {
    throw new Error(`${first} and ${second} must be configured together`);
  }
  return [left, right];
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function readConfig(env: Environment = process.env): AppConfig {
  const nodeEnv = enumValue(
    env,
    "NODE_ENV",
    ["development", "test", "production"] as const,
    "development",
  );
  const authMode = enumValue(
    env,
    "AUTH_MODE",
    ["better-auth", "development"] as const,
    "development",
  );
  const host = env.HOST ?? (authMode === "development" ? "127.0.0.1" : "0.0.0.0");
  if (authMode === "development" && (nodeEnv === "production" || !isLoopback(host))) {
    throw new Error("AUTH_MODE=development is allowed only outside production on a loopback host");
  }
  const baseUrl = normalizedUrl(env.BASE_URL ?? `http://${host}:${env.PORT ?? "3000"}`, "BASE_URL");
  if (nodeEnv === "production" && new URL(baseUrl).protocol !== "https:") {
    throw new Error("BASE_URL must use HTTPS in production");
  }
  const [githubClientId, githubClientSecret] = optionalPair(
    env,
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
  );
  const authSecret =
    env.AUTH_SECRET ??
    (nodeEnv === "production" ? "" : "development-only-secret-change-me-32-chars");
  if (authSecret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  const worldSeedSecret =
    env.WORLD_SEED_SECRET ??
    (nodeEnv === "production" ? "" : "agentworld-local-world-seed-only-2026");
  if (worldSeedSecret.length < 32) {
    throw new Error("WORLD_SEED_SECRET must contain at least 32 characters");
  }
  if (env.METRICS_TOKEN !== undefined && env.METRICS_TOKEN.length < 32) {
    throw new Error("METRICS_TOKEN must contain at least 32 characters when configured");
  }
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  return {
    nodeEnv,
    host,
    port: portValue(env.PORT),
    trustProxyHops: trustProxyHops(env.TRUST_PROXY_HOPS),
    databaseUrl: databaseUrl(env.DATABASE_URL, nodeEnv),
    ...(env.REDIS_URL ? { redisUrl: normalizedUrl(env.REDIS_URL, "REDIS_URL") } : {}),
    baseUrl,
    installationName: env.INSTALLATION_NAME ?? "Local AgentWorld",
    authMode,
    authSecret,
    worldSeedSecret,
    ...(env.METRICS_TOKEN ? { metricsToken: env.METRICS_TOKEN } : {}),
    registrationMode: enumValue(
      env,
      "REGISTRATION_MODE",
      ["open", "invite", "closed"] as const,
      nodeEnv === "production" ? "closed" : "open",
    ),
    ...(githubClientId ? { githubClientId } : {}),
    ...(githubClientSecret ? { githubClientSecret } : {}),
    ...(env.SMTP_URL ? { smtpUrl: env.SMTP_URL } : {}),
    emailFrom: env.EMAIL_FROM ?? "AgentWorld <agentworld@localhost>",
    authWebDirectory:
      env.AUTH_WEB_DIRECTORY ?? path.resolve(sourceDirectory, "../../auth-web/dist"),
    rulesetPath: path.resolve(
      sourceDirectory,
      "../../..",
      env.RULESET_PATH ?? "config/rulesets/beta-v1.yaml",
    ),
  };
}

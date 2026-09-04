import { createPool, resolvePoolSize } from "@agentworld/db";
import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";

const productionBase = {
  NODE_ENV: "production",
  AUTH_MODE: "better-auth",
  HOST: "0.0.0.0",
  AUTH_SECRET: "a-secure-production-secret-with-32-characters",
  WORLD_SEED_SECRET: "a-separate-private-world-secret-value-2026",
  BASE_URL: "https://game.example",
  DATABASE_URL: "postgresql://app:secret@db.internal:5432/agentworld",
} as const;

describe("readConfig", () => {
  it("provides safe loopback development defaults", () => {
    const config = readConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.authMode).toBe("development");
    expect(config.baseUrl).toBe("http://127.0.0.1:3000");
    expect(config.trustProxyHops).toBe(0);
    expect(config.databaseUrl).toBe(
      "postgres://agentworld:agentworld_dev@127.0.0.1:5432/agentworld",
    );
  });

  it("accepts only a narrow, explicit trusted-proxy hop count", () => {
    expect(readConfig({ TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    expect(() => readConfig({ TRUST_PROXY_HOPS: "3" })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it("refuses development identity selection on a public interface", () => {
    expect(() => readConfig({ AUTH_MODE: "development", HOST: "0.0.0.0" })).toThrow(/loopback/);
  });

  it("rejects enumerated values outside their allowed set", () => {
    expect(() => readConfig({ NODE_ENV: "staging" })).toThrow(/NODE_ENV must be one of/);
    expect(() => readConfig({ AUTH_MODE: "none" })).toThrow(/AUTH_MODE must be one of/);
    expect(() => readConfig({ REGISTRATION_MODE: "sometimes" })).toThrow(
      /REGISTRATION_MODE must be one of: open, invite, closed/,
    );
    const config = readConfig({ REGISTRATION_MODE: "invite" });
    const mode: "open" | "invite" | "closed" = config.registrationMode;
    expect(mode).toBe("invite");
  });

  it("requires HTTPS and a real secret in production", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        AUTH_MODE: "better-auth",
        HOST: "0.0.0.0",
        AUTH_SECRET: "a-secure-production-secret-with-32-characters",
        BASE_URL: "http://game.example",
      }),
    ).toThrow(/HTTPS/);
  });

  it("fails closed for registration and requires a private production world seed", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        AUTH_MODE: "better-auth",
        HOST: "0.0.0.0",
        AUTH_SECRET: "a-secure-production-secret-with-32-characters",
        BASE_URL: "https://game.example",
      }),
    ).toThrow(/WORLD_SEED_SECRET/);
    const config = readConfig(productionBase);
    expect(config.registrationMode).toBe("closed");
  });

  it("requires DATABASE_URL in production instead of falling back to development credentials", () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = productionBase;
    expect(() => readConfig(withoutDatabase)).toThrow(/DATABASE_URL is required in production/);
    expect(() => readConfig({ ...withoutDatabase, DATABASE_URL: "   " })).toThrow(
      /DATABASE_URL is required in production/,
    );
    expect(readConfig(productionBase).databaseUrl).toBe(productionBase.DATABASE_URL);
  });

  it("uses the local development connection string only outside production", () => {
    expect(readConfig({ NODE_ENV: "test" }).databaseUrl).toContain("127.0.0.1:5432/agentworld");
    expect(readConfig({ DATABASE_URL: " postgresql://x:y@host/db " }).databaseUrl).toBe(
      "postgresql://x:y@host/db",
    );
  });
});

describe("DATABASE_POOL_SIZE", () => {
  const connectionString = "postgres://agentworld:secret@127.0.0.1:5432/agentworld";

  it("defaults when unset or blank and accepts positive integers", () => {
    expect(resolvePoolSize(undefined)).toBe(10);
    expect(resolvePoolSize("")).toBe(10);
    expect(resolvePoolSize("   ")).toBe(10);
    expect(resolvePoolSize("1")).toBe(1);
    expect(resolvePoolSize(" 40 ")).toBe(40);
  });

  it("fails fast on zero, negative, fractional, exponent, and non-numeric values", () => {
    for (const value of ["0", "-3", "2.5", "1e3", "abc", "NaN", "Infinity", "0x10", "+5"]) {
      expect(() => resolvePoolSize(value), value).toThrow(
        /DATABASE_POOL_SIZE must be a positive integer/,
      );
    }
  });

  it("rejects an explicit invalid maximum before constructing a pool", async () => {
    expect(() => createPool(connectionString, { maxConnections: 0 })).toThrow(/maxConnections/);
    expect(() => createPool(connectionString, { maxConnections: Number.NaN })).toThrow(
      /maxConnections/,
    );
    expect(() => createPool(connectionString, { maxConnections: 2.5 })).toThrow(/maxConnections/);
    const pool = createPool(connectionString, { maxConnections: 3 });
    expect(pool.options.max).toBe(3);
    await pool.end();
  });
});

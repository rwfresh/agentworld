import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";

describe("readConfig", () => {
  it("provides safe loopback development defaults", () => {
    const config = readConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.authMode).toBe("development");
    expect(config.baseUrl).toBe("http://127.0.0.1:3000");
    expect(config.trustProxyHops).toBe(0);
  });

  it("accepts only a narrow, explicit trusted-proxy hop count", () => {
    expect(readConfig({ TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    expect(() => readConfig({ TRUST_PROXY_HOPS: "3" })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it("refuses development identity selection on a public interface", () => {
    expect(() => readConfig({ AUTH_MODE: "development", HOST: "0.0.0.0" })).toThrow(/loopback/);
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
    const config = readConfig({
      NODE_ENV: "production",
      AUTH_MODE: "better-auth",
      HOST: "0.0.0.0",
      AUTH_SECRET: "a-secure-production-secret-with-32-characters",
      WORLD_SEED_SECRET: "a-separate-private-world-secret-value-2026",
      BASE_URL: "https://game.example",
    });
    expect(config.registrationMode).toBe("closed");
  });
});

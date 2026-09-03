import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigStore,
  FileCredentialStore,
  normalizeServerUrl,
  resolveConfigDirectory,
} from "./config.ts";

describe("CLI profiles", () => {
  it("uses platform-native configuration locations", () => {
    expect(resolveConfigDirectory({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/test")).toBe(
      "/cfg/agentworld",
    );
    expect(resolveConfigDirectory({ APPDATA: "C:\\Data" }, "win32", "C:\\Users\\test")).toContain(
      "AgentWorld",
    );
  });

  it("normalizes server URLs and rejects unsafe protocols", () => {
    expect(normalizeServerUrl("https://play.example.test/")).toBe("https://play.example.test");
    expect(normalizeServerUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeServerUrl("http://127.0.0.42:3000/")).toBe("http://127.0.0.42:3000");
    expect(normalizeServerUrl("http://[::1]:3000/")).toBe("http://[::1]:3000");
    expect(() => normalizeServerUrl("http://play.example.test")).toThrow("must use HTTPS");
    expect(() => normalizeServerUrl("https://user:secret@play.example.test")).toThrow(
      "embedded credentials",
    );
    expect(() => normalizeServerUrl("file:///etc/passwd")).toThrow("http or https");
  });

  it("round-trips profiles and credentials separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentworld-cli-"));
    const profiles = new ConfigStore(directory);
    const credentials = new FileCredentialStore(directory);

    await profiles.putProfile("local", { server: "http://localhost:3000/", world: "alpha" }, true);
    await credentials.set("local", {
      accessToken: "secret",
      server: "http://localhost:3000",
      refreshToken: "refresh",
    });

    expect(await profiles.load()).toEqual({
      version: 1,
      currentProfile: "local",
      profiles: { local: { server: "http://localhost:3000", world: "alpha" } },
    });
    expect(await credentials.get("local")).toEqual({
      accessToken: "secret",
      server: "http://localhost:3000",
      refreshToken: "refresh",
    });
    expect(await readFile(profiles.configPath, "utf8")).not.toContain("secret");
    expect((await stat(credentials.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});

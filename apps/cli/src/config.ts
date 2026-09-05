import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError, ExitCode } from "./errors.ts";

export interface Profile {
  readonly server: string;
  readonly world?: string;
}

export interface CliConfig {
  readonly version: 1;
  readonly currentProfile?: string;
  readonly profiles: Readonly<Record<string, Profile>>;
}

export interface StoredCredentials {
  readonly accessToken: string;
  /** Normalized resource server this credential is allowed to reach. */
  readonly server?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scope?: string;
}

interface CredentialsFile {
  readonly version: 1;
  readonly profiles: Readonly<Record<string, StoredCredentials>>;
}

const emptyConfig: CliConfig = { version: 1, profiles: {} };
const emptyCredentials: CredentialsFile = { version: 1, profiles: {} };
const validProfileName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function usageError(detail: string): CliError {
  return new CliError(ExitCode.usage, {
    title: "Invalid CLI configuration",
    detail,
    code: "invalid_configuration",
    retryable: false,
  });
}

export function assertProfileName(name: string): void {
  if (!validProfileName.test(name)) {
    throw usageError(
      "Profile names must start with a letter or number and contain only letters, numbers, '.', '_', or '-'.",
    );
  }
}

export function normalizeServerUrl(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw usageError(`Invalid server URL: ${server}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw usageError("Server URLs must use http or https.");
  }
  if (url.username || url.password) {
    throw usageError("Server URLs must not contain embedded credentials.");
  }
  const hostname = url.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !isLoopback) {
    throw usageError("Remote AgentWorld servers must use HTTPS; HTTP is allowed only on loopback.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function resolveConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (environment.AGENTWORLD_CONFIG_DIR) return resolve(environment.AGENTWORLD_CONFIG_DIR);
  if (platform === "win32") {
    return join(environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "AgentWorld");
  }
  if (platform === "darwin")
    return join(homeDirectory, "Library", "Application Support", "agentworld");
  return join(environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), "agentworld");
}

function asProfile(value: unknown, name: string): Profile {
  if (typeof value !== "object" || value === null)
    throw usageError(`Profile '${name}' is invalid.`);
  const input = value as Record<string, unknown>;
  if (typeof input.server !== "string") throw usageError(`Profile '${name}' has no server URL.`);
  const server = normalizeServerUrl(input.server);
  if (input.world === undefined) return { server };
  if (typeof input.world !== "string" || input.world.length === 0) {
    throw usageError(`Profile '${name}' has an invalid world.`);
  }
  return { server, world: input.world };
}

function parseConfig(text: string): CliConfig {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw usageError("The profile file is not valid JSON.");
  }
  if (typeof input !== "object" || input === null) throw usageError("The profile file is invalid.");
  const candidate = input as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.profiles !== "object" ||
    candidate.profiles === null
  ) {
    throw usageError("The profile file uses an unsupported format.");
  }
  const profiles = Object.fromEntries(
    Object.entries(candidate.profiles).map(([name, value]) => {
      assertProfileName(name);
      return [name, asProfile(value, name)];
    }),
  );
  if (candidate.currentProfile !== undefined && typeof candidate.currentProfile !== "string") {
    throw usageError("The current profile name is invalid.");
  }
  return candidate.currentProfile === undefined
    ? { version: 1, profiles }
    : { version: 1, currentProfile: candidate.currentProfile, profiles };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicJsonWrite(path: string, value: unknown, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ConfigStore {
  public readonly directory: string;
  public readonly configPath: string;

  public constructor(directory = resolveConfigDirectory()) {
    this.directory = directory;
    this.configPath = join(directory, "config.json");
  }

  public async load(): Promise<CliConfig> {
    const text = await readOptional(this.configPath);
    return text === undefined ? emptyConfig : parseConfig(text);
  }

  public async save(config: CliConfig): Promise<void> {
    await atomicJsonWrite(this.configPath, config);
  }

  public async putProfile(name: string, profile: Profile, select = false): Promise<void> {
    assertProfileName(name);
    const config = await this.load();
    const normalized = asProfile(profile, name);
    await this.save({
      version: 1,
      currentProfile: select || config.currentProfile === undefined ? name : config.currentProfile,
      profiles: { ...config.profiles, [name]: normalized },
    });
  }

  public async selectProfile(name: string): Promise<void> {
    assertProfileName(name);
    const config = await this.load();
    if (!config.profiles[name]) throw usageError(`Profile '${name}' does not exist.`);
    await this.save({ ...config, currentProfile: name });
  }

  public async removeProfile(name: string): Promise<void> {
    const config = await this.load();
    if (!config.profiles[name]) throw usageError(`Profile '${name}' does not exist.`);
    const profiles = { ...config.profiles };
    delete profiles[name];
    const next = Object.keys(profiles)[0];
    await this.save({
      version: 1,
      ...(config.currentProfile === name && next ? { currentProfile: next } : {}),
      ...(config.currentProfile !== name && config.currentProfile
        ? { currentProfile: config.currentProfile }
        : {}),
      profiles,
    });
  }
}

function parseCredentials(text: string): CredentialsFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw usageError("The credential file is not valid JSON.");
  }
  if (typeof value !== "object" || value === null)
    throw usageError("The credential file is invalid.");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.profiles !== "object" || input.profiles === null) {
    throw usageError("The credential file uses an unsupported format.");
  }
  const profiles: Record<string, StoredCredentials> = {};
  for (const [name, rawCredentials] of Object.entries(input.profiles)) {
    if (typeof rawCredentials !== "object" || rawCredentials === null) continue;
    const credentials = rawCredentials as Record<string, unknown>;
    if (typeof credentials.accessToken !== "string") continue;
    profiles[name] = {
      accessToken: credentials.accessToken,
      ...(typeof credentials.server === "string"
        ? { server: normalizeServerUrl(credentials.server) }
        : {}),
      ...(typeof credentials.refreshToken === "string"
        ? { refreshToken: credentials.refreshToken }
        : {}),
      ...(typeof credentials.expiresAt === "string" ? { expiresAt: credentials.expiresAt } : {}),
      ...(typeof credentials.scope === "string" ? { scope: credentials.scope } : {}),
    };
  }
  return { version: 1, profiles };
}

/** Narrow credential adapter; replaceable with an OS-vault implementation without touching commands. */
export class FileCredentialStore {
  public readonly path: string;

  public constructor(directory = resolveConfigDirectory()) {
    this.path = join(directory, "credentials.json");
  }

  private async load(): Promise<CredentialsFile> {
    const text = await readOptional(this.path);
    return text === undefined ? emptyCredentials : parseCredentials(text);
  }

  public async get(profile: string): Promise<StoredCredentials | undefined> {
    if (process.env.AGENTWORLD_TOKEN) return { accessToken: process.env.AGENTWORLD_TOKEN };
    return (await this.load()).profiles[profile];
  }

  public async set(profile: string, credentials: StoredCredentials): Promise<void> {
    const current = await this.load();
    await atomicJsonWrite(this.path, {
      version: 1,
      profiles: { ...current.profiles, [profile]: credentials },
    });
  }

  public async delete(profile: string): Promise<void> {
    const current = await this.load();
    const profiles = { ...current.profiles };
    delete profiles[profile];
    await atomicJsonWrite(this.path, { version: 1, profiles });
  }
}

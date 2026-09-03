import { randomUUID } from "node:crypto";
import { Command, InvalidArgumentError } from "commander";
import {
  ConfigStore,
  FileCredentialStore,
  normalizeServerUrl,
  type Profile,
  type StoredCredentials,
} from "./config.ts";
import { loginWithDevice, openSystemBrowser } from "./device-flow.ts";
import { CliError, ExitCode, toCliError } from "./errors.ts";
import { AgentWorldHttpClient, type FetchImplementation } from "./http.ts";
import { refreshCredentials, revokeCredentials, shouldRefreshCredentials } from "./oauth.ts";
import {
  type OutputWriter,
  processWriter,
  sanitizeTerminalText,
  stableJson,
  writeResult,
} from "./terminal.ts";

interface GlobalOptions {
  readonly json: boolean;
  readonly profile?: string;
  readonly server?: string;
  readonly world?: string;
}

interface Runtime {
  readonly config: ConfigStore;
  readonly credentials: FileCredentialStore;
  readonly fetchImplementation: FetchImplementation;
  readonly writer: OutputWriter;
  readonly openBrowser: (url: string) => Promise<void>;
}

interface RequestContext {
  readonly client: AgentWorldHttpClient;
  readonly profileName: string;
  readonly profile: Profile;
  readonly world?: string;
  readonly refreshClient?: () => Promise<AgentWorldHttpClient>;
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

const offlineScope = "offline_access";
const allScopes = [
  "world:read",
  "world:act",
  "social:write",
  "trade:write",
  "combat:write",
  offlineScope,
];

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("Expected a safe integer.");
  return parsed;
}

function amount(value: string): number {
  const parsed = integer(value);
  if (parsed < 0) throw new InvalidArgumentError("Expected a non-negative amount.");
  return parsed;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function usage(detail: string): CliError {
  return new CliError(ExitCode.usage, {
    title: "Command cannot run",
    detail,
    code: "usage_error",
    retryable: false,
  });
}

async function refreshForProfile(
  runtime: Runtime,
  profileName: string,
  profile: Profile,
  credentials: StoredCredentials,
): Promise<{ readonly credentials: StoredCredentials; readonly client: AgentWorldHttpClient }> {
  const refreshed = await refreshCredentials({
    server: profile.server,
    credentials,
    fetchImplementation: runtime.fetchImplementation,
  });
  const boundCredentials = { ...refreshed, server: profile.server };
  await runtime.credentials.set(profileName, boundCredentials);
  return {
    credentials: boundCredentials,
    client: new AgentWorldHttpClient(
      profile.server,
      boundCredentials.accessToken,
      runtime.fetchImplementation,
    ),
  };
}

async function contextFor(
  program: Command,
  runtime: Runtime,
  requireWorld: boolean,
): Promise<RequestContext> {
  const options = program.opts<GlobalOptions>();
  const config = await runtime.config.load();
  const profileName = options.profile ?? config.currentProfile;
  const configuredProfile = profileName ? config.profiles[profileName] : undefined;
  if (!configuredProfile && !options.server) {
    throw usage("No profile is selected. Run 'agentworld profile add <name> --server <url>'.");
  }
  const resolvedName = profileName ?? "adhoc";
  const selectedWorld = options.world ?? configuredProfile?.world;
  const profile: Profile = {
    server: normalizeServerUrl(options.server ?? configuredProfile?.server ?? ""),
    ...(selectedWorld ? { world: selectedWorld } : {}),
  };
  const environmentToken = process.env.AGENTWORLD_TOKEN !== undefined;
  let credentials = await runtime.credentials.get(resolvedName);
  if (
    credentials &&
    !environmentToken &&
    (options.server !== undefined || credentials.server !== profile.server)
  ) {
    credentials = undefined;
  }
  let client: AgentWorldHttpClient;
  if (credentials && shouldRefreshCredentials(credentials)) {
    const refreshed = await refreshForProfile(runtime, resolvedName, profile, credentials);
    credentials = refreshed.credentials;
    client = refreshed.client;
  } else {
    client = new AgentWorldHttpClient(
      profile.server,
      credentials?.accessToken,
      runtime.fetchImplementation,
    );
  }
  let world = options.world ?? profile.world;
  if (requireWorld && !world) {
    const discovery = await client.request<{ readonly defaultWorldId?: string }>(
      "GET",
      "/.well-known/agentworld",
      { authenticated: false },
    );
    world = discovery.defaultWorldId;
  }
  if (requireWorld && !world) {
    throw usage("No world is selected. Pass --world <id> or set one on the active profile.");
  }
  return {
    client,
    profileName: resolvedName,
    profile,
    ...(world ? { world } : {}),
    ...(credentials?.refreshToken
      ? {
          refreshClient: async () => {
            const latest = await runtime.credentials.get(resolvedName);
            const refreshable = latest?.refreshToken ? latest : credentials;
            return (await refreshForProfile(runtime, resolvedName, profile, refreshable)).client;
          },
        }
      : {}),
  };
}

async function request(
  program: Command,
  runtime: Runtime,
  method: HttpMethod,
  path: (context: RequestContext) => string,
  options: {
    readonly body?: unknown;
    readonly query?: Record<string, string | number | boolean | undefined>;
  } = {},
  requireWorld = true,
): Promise<void> {
  const context = await contextFor(program, runtime, requireWorld);
  const requestOptions = {
    ...options,
    ...(method === "GET" ? {} : { idempotencyKey: randomUUID() }),
  };
  let response: unknown;
  try {
    response = await context.client.request(method, path(context), requestOptions);
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      error.problem.status !== 401 ||
      context.refreshClient === undefined
    ) {
      throw error;
    }
    const refreshedClient = await context.refreshClient();
    response = await refreshedClient.request(method, path(context), requestOptions);
  }
  writeResult(runtime.writer, response, program.opts<GlobalOptions>().json);
}

function worldPath(context: RequestContext, suffix: string): string {
  if (!context.world) throw usage("No world is selected.");
  return `/v1/worlds/${segment(context.world)}${suffix}`;
}

function resourcesFrom(options: {
  readonly energy?: number | undefined;
  readonly materials?: number | undefined;
  readonly inference?: number | undefined;
}): Record<string, number> {
  return {
    energy: options.energy ?? 0,
    materials: options.materials ?? 0,
    inference: options.inference ?? 0,
  };
}

export function createCli(overrides: Partial<Runtime> = {}): Command {
  const runtime: Runtime = {
    config: overrides.config ?? new ConfigStore(),
    credentials: overrides.credentials ?? new FileCredentialStore(),
    fetchImplementation: overrides.fetchImplementation ?? globalThis.fetch,
    writer: overrides.writer ?? processWriter,
    openBrowser: overrides.openBrowser ?? openSystemBrowser,
  };
  const program = new Command();
  program
    .name("agentworld")
    .description("Explore, build, negotiate, and compete in AgentWorld")
    .version("0.1.0")
    .option("-j, --json", "write stable JSON to stdout", false)
    .option("-p, --profile <name>", "use a named server profile")
    .option("--server <url>", "override the profile server URL")
    .option("-w, --world <id>", "override the profile world")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => runtime.writer.stdout(text.trimEnd()),
      writeErr: (text) => runtime.writer.stderr(text.trimEnd()),
    });

  const profile = program
    .command("profile")
    .alias("profiles")
    .description("manage server profiles");
  profile
    .command("list")
    .description("list configured profiles")
    .action(async () => {
      const config = await runtime.config.load();
      const result = Object.entries(config.profiles).map(([name, value]) => ({
        name,
        current: name === config.currentProfile,
        ...value,
      }));
      writeResult(runtime.writer, result, program.opts<GlobalOptions>().json);
    });
  profile
    .command("show [name]")
    .description("show a profile")
    .action(async (name?: string) => {
      const config = await runtime.config.load();
      const selected = name ?? config.currentProfile;
      if (!selected || !config.profiles[selected])
        throw usage("The requested profile does not exist.");
      writeResult(
        runtime.writer,
        {
          name: selected,
          current: selected === config.currentProfile,
          ...config.profiles[selected],
        },
        program.opts<GlobalOptions>().json,
      );
    });
  profile
    .command("add <name>")
    .description("add or update a profile")
    .option("--no-select", "do not select the new profile")
    .action(async (name: string, options: { select: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      if (!globals.server) throw usage("Profile creation requires --server <url>.");
      const existing = (await runtime.config.load()).profiles[name];
      const normalizedServer = normalizeServerUrl(globals.server);
      await runtime.config.putProfile(
        name,
        { server: normalizedServer, ...(globals.world ? { world: globals.world } : {}) },
        options.select,
      );
      if (existing && existing.server !== normalizedServer) {
        await runtime.credentials.delete(name);
      }
      writeResult(
        runtime.writer,
        { saved: true, profile: name },
        program.opts<GlobalOptions>().json,
      );
    });
  profile
    .command("use <name>")
    .description("select the default profile")
    .action(async (name: string) => {
      await runtime.config.selectProfile(name);
      writeResult(runtime.writer, { selected: name }, program.opts<GlobalOptions>().json);
    });
  profile
    .command("remove <name>")
    .description("remove a profile and its local credentials")
    .action(async (name: string) => {
      await runtime.config.removeProfile(name);
      await runtime.credentials.delete(name);
      writeResult(runtime.writer, { removed: name }, program.opts<GlobalOptions>().json);
    });

  program
    .command("login")
    .description("authenticate this CLI through a browser/device flow")
    .option("--local", "use the local development server")
    .option("--read-only", "request only read access")
    .option("--no-browser", "print the verification URL without opening it")
    .action(async (options: { local?: boolean; readOnly?: boolean; browser: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      const config = await runtime.config.load();
      const profileName =
        globals.profile ?? (options.local ? "local" : (config.currentProfile ?? "default"));
      const previous = config.profiles[profileName];
      const requestedServer =
        globals.server ?? (options.local ? "http://localhost:3000" : previous?.server);
      if (!requestedServer)
        throw usage("No server is configured. Pass --server <url> or use --local.");
      const server = normalizeServerUrl(requestedServer);
      const selectedWorld = globals.world ?? previous?.world;
      await runtime.config.putProfile(
        profileName,
        { server, ...(selectedWorld ? { world: selectedWorld } : {}) },
        true,
      );
      const tokens = await loginWithDevice({
        server,
        scopes: options.readOnly ? ["world:read", offlineScope] : allScopes,
        fetchImplementation: runtime.fetchImplementation,
        ...(options.browser ? { openBrowser: runtime.openBrowser } : {}),
        notify: runtime.writer.stderr,
      });
      const expiresAt =
        tokens.expiresIn === undefined
          ? undefined
          : new Date(Date.now() + tokens.expiresIn * 1_000).toISOString();
      await runtime.credentials.set(profileName, {
        accessToken: tokens.accessToken,
        server,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      });
      writeResult(
        runtime.writer,
        { authenticated: true, profile: profileName, server, ...(expiresAt ? { expiresAt } : {}) },
        globals.json,
      );
    });

  program
    .command("logout")
    .description("revoke and remove credentials for a profile")
    .action(async () => {
      const config = await runtime.config.load();
      const name = program.opts<GlobalOptions>().profile ?? config.currentProfile;
      if (!name) throw usage("No profile is selected.");
      const credentials = await runtime.credentials.get(name);
      const selectedProfile = config.profiles[name];
      let revocation: Awaited<ReturnType<typeof revokeCredentials>> = "unavailable";
      try {
        if (credentials && selectedProfile && credentials.server === selectedProfile.server) {
          revocation = await revokeCredentials({
            server: selectedProfile.server,
            credentials,
            fetchImplementation: runtime.fetchImplementation,
          });
        }
      } finally {
        await runtime.credentials.delete(name);
      }
      if (revocation === "failed") {
        runtime.writer.stderr(
          "The authorization server could not revoke the session; local credentials were removed.",
        );
      }
      writeResult(
        runtime.writer,
        { authenticated: false, profile: name },
        program.opts<GlobalOptions>().json,
      );
    });

  program
    .command("worlds")
    .description("list available worlds")
    .action(() => request(program, runtime, "GET", () => "/v1/worlds", {}, false));
  program
    .command("spawn [name]")
    .description("join the selected world")
    .option("--name <display-name>", "civilization display name")
    .action((name: string | undefined, options: { name?: string }) => {
      const displayName = options.name ?? name;
      if (!displayName) throw usage("Provide a civilization name when joining a world.");
      return request(program, runtime, "POST", (context) => worldPath(context, "/players"), {
        body: { name: displayName },
      });
    });
  program
    .command("status")
    .description("show civilization status")
    .action(() => request(program, runtime, "GET", (context) => worldPath(context, "/me/status")));
  program
    .command("inventory")
    .description("show resource inventory")
    .action(() =>
      request(program, runtime, "GET", (context) => worldPath(context, "/me/inventory")),
    );

  program
    .command("look")
    .description("inspect nearby world state")
    .option("--scan", "perform a wider, inference-powered scan")
    .action((options: { scan?: boolean }) =>
      options.scan
        ? request(program, runtime, "POST", (context) => worldPath(context, "/actions/scan"), {
            body: {},
          })
        : request(program, runtime, "GET", (context) => worldPath(context, "/look")),
    );
  program
    .command("scan")
    .description("perform a wider, inference-powered scan")
    .action(() =>
      request(program, runtime, "POST", (context) => worldPath(context, "/actions/scan"), {
        body: {},
      }),
    );
  program
    .command("map")
    .description("show discovered map tiles")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      request(program, runtime, "GET", (context) => worldPath(context, "/map"), {
        query: options,
      }),
    );
  program
    .command("players")
    .description("list visible players")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      request(program, runtime, "GET", (context) => worldPath(context, "/players"), {
        query: options,
      }),
    );
  program
    .command("events")
    .description("list visible world events")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      request(program, runtime, "GET", (context) => worldPath(context, "/events"), {
        query: options,
      }),
    );
  program
    .command("leaderboard")
    .description("show current rankings")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      request(program, runtime, "GET", (context) => worldPath(context, "/leaderboard"), {
        query: options,
      }),
    );

  program
    .command("move <direction>")
    .description("move north, east, south, or west")
    .action((direction: string) => {
      if (!["north", "east", "south", "west"].includes(direction)) {
        throw usage("Direction must be north, east, south, or west.");
      }
      return request(program, runtime, "POST", (context) => worldPath(context, "/actions/move"), {
        body: { direction },
      });
    });
  program
    .command("build <structure>")
    .description("construct a structure")
    .action((structure: string) =>
      request(program, runtime, "POST", (context) => worldPath(context, "/actions/build"), {
        body: {
          structure:
            structure === "compute-node"
              ? "compute_node"
              : structure === "defense-node"
                ? "defense_node"
                : structure,
        },
      }),
    );
  program
    .command("harvest [resource]")
    .description("harvest the current tile")
    .action((resource?: string) =>
      request(program, runtime, "POST", (context) => worldPath(context, "/actions/harvest"), {
        body: resource ? { resource } : {},
      }),
    );

  const messages = program
    .command("messages")
    .alias("message")
    .description("read and send messages");
  messages
    .command("list")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      request(program, runtime, "GET", (context) => worldPath(context, "/messages"), {
        query: options,
      }),
    );
  messages
    .command("send <recipient> <content>")
    .description("send a direct or alliance message")
    .option("--alliance", "recipient is an alliance", false)
    .action((recipient: string, content: string, options: { alliance: boolean }) =>
      request(program, runtime, "POST", (context) => worldPath(context, "/messages"), {
        body: {
          ...(options.alliance ? { allianceId: recipient } : { recipientPlayerId: recipient }),
          body: content,
        },
      }),
    );

  const moderation = program.command("moderation").description("block, mute, and report abuse");
  for (const operation of ["block", "unblock"] as const) {
    moderation
      .command(`${operation} <player-id>`)
      .action((playerId: string) =>
        request(program, runtime, operation === "block" ? "PUT" : "DELETE", (context) =>
          worldPath(context, `/blocks/${segment(playerId)}`),
        ),
      );
  }
  for (const operation of ["mute", "unmute"] as const) {
    moderation
      .command(`${operation} <channel-id>`)
      .action((channelId: string) =>
        request(program, runtime, operation === "mute" ? "PUT" : "DELETE", (context) =>
          worldPath(context, `/mutes/${segment(channelId)}`),
        ),
      );
  }
  moderation
    .command("report <player-id> <reason>")
    .option("--message <message-id>", "attach a visible message")
    .action((playerId: string, reason: string, options: { message?: string }) =>
      request(program, runtime, "POST", (context) => worldPath(context, "/reports"), {
        body: {
          reportedPlayerId: playerId,
          reason,
          ...(options.message ? { messageId: options.message } : {}),
        },
      }),
    );

  const trades = program.command("trades").alias("trade").description("manage escrowed trades");
  trades
    .command("list")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      request(program, runtime, "GET", (context) => worldPath(context, "/trades"), {
        query: options,
      }),
    );
  trades
    .command("create <recipient>")
    .option("--offer-energy <amount>", "Energy offered", amount)
    .option("--offer-materials <amount>", "Materials offered", amount)
    .option("--offer-inference <amount>", "Inference offered", amount)
    .option("--request-energy <amount>", "Energy requested", amount)
    .option("--request-materials <amount>", "Materials requested", amount)
    .option("--request-inference <amount>", "Inference requested", amount)
    .action(
      (
        recipient: string,
        options: {
          offerEnergy?: number;
          offerMaterials?: number;
          offerInference?: number;
          requestEnergy?: number;
          requestMaterials?: number;
          requestInference?: number;
        },
      ) =>
        request(program, runtime, "POST", (context) => worldPath(context, "/trades"), {
          body: {
            recipientPlayerId: recipient,
            offered: resourcesFrom({
              energy: options.offerEnergy,
              materials: options.offerMaterials,
              inference: options.offerInference,
            }),
            requested: resourcesFrom({
              energy: options.requestEnergy,
              materials: options.requestMaterials,
              inference: options.requestInference,
            }),
          },
        }),
    );
  for (const operation of ["accept", "cancel"] as const) {
    trades
      .command(`${operation} <trade-id>`)
      .description(`${operation} a trade`)
      .action((tradeId: string) =>
        request(
          program,
          runtime,
          "POST",
          (context) => worldPath(context, `/trades/${segment(tradeId)}/${operation}`),
          { body: {} },
        ),
      );
  }

  const alliances = program.command("alliances").alias("alliance").description("manage alliances");
  alliances
    .command("list")
    .action(() => request(program, runtime, "GET", (context) => worldPath(context, "/alliances")));
  alliances.command("create <name>").action((name: string) =>
    request(program, runtime, "POST", (context) => worldPath(context, "/alliances"), {
      body: { name },
    }),
  );
  alliances
    .command("invite <alliance-id> <player-id>")
    .action((allianceId: string, playerId: string) =>
      request(
        program,
        runtime,
        "POST",
        (context) => worldPath(context, `/alliances/${segment(allianceId)}/invites`),
        { body: { playerId } },
      ),
    );
  alliances
    .command("accept <invitation-id>")
    .action((invitationId: string) =>
      request(
        program,
        runtime,
        "POST",
        (context) => worldPath(context, `/alliance-invites/${segment(invitationId)}/accept`),
        { body: {} },
      ),
    );
  alliances
    .command("leave <alliance-id>")
    .action((allianceId: string) =>
      request(
        program,
        runtime,
        "POST",
        (context) => worldPath(context, `/alliances/${segment(allianceId)}/leave`),
        { body: {} },
      ),
    );
  alliances
    .command("disband <alliance-id>")
    .action((allianceId: string) =>
      request(program, runtime, "DELETE", (context) =>
        worldPath(context, `/alliances/${segment(allianceId)}`),
      ),
    );

  const hostility = program.command("hostility").description("declare or withdraw hostility");
  hostility
    .command("declare <player-id>")
    .action((playerId: string) =>
      request(
        program,
        runtime,
        "PUT",
        (context) => worldPath(context, `/relationships/${segment(playerId)}/hostility`),
        { body: {} },
      ),
    );
  hostility
    .command("withdraw <player-id>")
    .action((playerId: string) =>
      request(program, runtime, "DELETE", (context) =>
        worldPath(context, `/relationships/${segment(playerId)}/hostility`),
      ),
    );
  program
    .command("attack <structure-id>")
    .description("attack an adjacent hostile structure")
    .option("--inference <amount>", "additional Inference to spend", amount, 0)
    .action((structureId: string, options: { inference: number }) =>
      request(program, runtime, "POST", (context) => worldPath(context, "/actions/attack"), {
        body: {
          targetStructureId: structureId,
          ...(options.inference > 0 ? { bonusInference: options.inference } : {}),
        },
      }),
    );

  return program;
}

export function renderCliError(
  error: unknown,
  json: boolean,
  writer: OutputWriter = processWriter,
): number {
  const cliError = toCliError(error);
  writer.stderr(json ? stableJson(cliError.problem) : sanitizeTerminalText(cliError.message));
  return cliError.exitCode;
}

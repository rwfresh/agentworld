import { randomUUID } from "node:crypto";
import { AgentWorldClient } from "@agentworld/api-client";
import type {
  AllianceCreateRequest,
  AllianceInviteRequest,
  AllianceLeadershipRequest,
  AttackRequest,
  BuildRequest,
  Direction,
  HarvestRequest,
  MoveRequest,
  ReportRequest,
  ResourceKind,
  Resources,
  SendMessageRequest,
  SpawnRequest,
  StructureKind,
  TradeOfferRequest,
} from "@agentworld/api-contract";
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
import { callApi, type FetchImplementation, requestTimeoutMs } from "./http.ts";
import { refreshCredentials, revokeCredentials, shouldRefreshCredentials } from "./oauth.ts";
import {
  type OutputWriter,
  processWriter,
  sanitizeTerminalText,
  stableJson,
  writeResult,
} from "./terminal.ts";

const cliVersion = "0.1.0";

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
  /** Per-attempt deadline applied to every outbound request. */
  readonly timeoutMs: number;
}

interface RequestContext {
  readonly client: AgentWorldClient;
  readonly world?: string;
  readonly refreshClient?: () => Promise<AgentWorldClient>;
}

/** One user-intended call against the selected world, keyed once so retries replay it. */
type WorldOperation<T> = (client: AgentWorldClient, world: string, key: string) => Promise<T>;

const offlineScope = "offline_access";
const allScopes = [
  "world:read",
  "world:act",
  "social:write",
  "trade:write",
  "combat:write",
  offlineScope,
];

const directions = { north: true, east: true, south: true, west: true } satisfies Record<
  Direction,
  true
>;
const resourceKinds = { energy: true, materials: true, inference: true } satisfies Record<
  ResourceKind,
  true
>;
/** Accepted spellings for every wire structure kind; hyphenated forms are a CLI convenience. */
const structureSpellings = {
  command_node: ["command_node", "command-node"],
  generator: ["generator"],
  extractor: ["extractor"],
  compute_node: ["compute_node", "compute-node"],
  defense_node: ["defense_node", "defense-node"],
} satisfies Record<StructureKind, readonly string[]>;

function isMember<T extends string>(table: Readonly<Record<T, true>>, value: string): value is T {
  return Object.hasOwn(table, value);
}

function kindForSpelling<T extends string>(
  table: Readonly<Record<T, readonly string[]>>,
  value: string,
): T | undefined {
  for (const kind in table) {
    if (table[kind].includes(value)) return kind;
  }
  return undefined;
}

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

function usage(detail: string): CliError {
  return new CliError(ExitCode.usage, {
    title: "Command cannot run",
    detail,
    code: "usage_error",
    retryable: false,
  });
}

function direction(value: string): Direction {
  if (!isMember(directions, value)) throw usage("Direction must be north, east, south, or west.");
  return value;
}

function resourceKind(value: string): ResourceKind {
  if (!isMember(resourceKinds, value)) {
    throw usage("Resource must be energy, materials, or inference.");
  }
  return value;
}

function structureKind(value: string): StructureKind {
  const kind = kindForSpelling(structureSpellings, value);
  if (!kind) {
    throw usage(`Structure must be one of: ${Object.keys(structureSpellings).join(", ")}.`);
  }
  return kind;
}

function resourcesFrom(options: {
  readonly energy?: number | undefined;
  readonly materials?: number | undefined;
  readonly inference?: number | undefined;
}): Resources {
  return {
    energy: options.energy ?? 0,
    materials: options.materials ?? 0,
    inference: options.inference ?? 0,
  };
}

function expiryFrom(expiresIn: number | undefined): string | undefined {
  if (expiresIn === undefined) return undefined;
  const expiration = new Date(Date.now() + expiresIn * 1_000);
  return Number.isFinite(expiration.getTime()) ? expiration.toISOString() : undefined;
}

function createClient(runtime: Runtime, server: string, accessToken?: string): AgentWorldClient {
  return new AgentWorldClient({
    baseUrl: server,
    ...(accessToken ? { accessToken } : {}),
    fetch: runtime.fetchImplementation,
    timeoutMs: runtime.timeoutMs,
    userAgent: `agentworld-cli/${cliVersion}`,
  });
}

async function refreshForProfile(
  runtime: Runtime,
  profileName: string,
  profile: Profile,
  credentials: StoredCredentials,
): Promise<{ readonly credentials: StoredCredentials; readonly client: AgentWorldClient }> {
  const refreshed = await refreshCredentials({
    server: profile.server,
    credentials,
    fetchImplementation: runtime.fetchImplementation,
    timeoutMs: runtime.timeoutMs,
  });
  const boundCredentials = { ...refreshed, server: profile.server };
  await runtime.credentials.set(profileName, boundCredentials);
  return {
    credentials: boundCredentials,
    client: createClient(runtime, profile.server, boundCredentials.accessToken),
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
  let client: AgentWorldClient;
  if (credentials && shouldRefreshCredentials(credentials)) {
    const refreshed = await refreshForProfile(runtime, resolvedName, profile, credentials);
    credentials = refreshed.credentials;
    client = refreshed.client;
  } else {
    client = createClient(runtime, profile.server, credentials?.accessToken);
  }
  let world = options.world ?? profile.world;
  if (requireWorld && !world) {
    // Discovery is public; an unauthenticated client keeps the bearer token off that request.
    const discovery = await callApi(
      () => createClient(runtime, profile.server).discover(),
      runtime.timeoutMs,
    );
    world = discovery.defaultWorldId;
  }
  if (requireWorld && !world) {
    throw usage("No world is selected. Pass --world <id> or set one on the active profile.");
  }
  return {
    client,
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

function worldOf(context: RequestContext): string {
  if (!context.world) throw usage("No world is selected.");
  return context.world;
}

async function execute<T>(
  program: Command,
  runtime: Runtime,
  requireWorld: boolean,
  operation: (client: AgentWorldClient, context: RequestContext, key: string) => Promise<T>,
): Promise<void> {
  const context = await contextFor(program, runtime, requireWorld);
  // One key per user intent: transport retries and the post-refresh retry replay the same mutation.
  const key = randomUUID();
  let response: T;
  try {
    response = await callApi(() => operation(context.client, context, key), runtime.timeoutMs);
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      error.problem.status !== 401 ||
      context.refreshClient === undefined
    ) {
      throw error;
    }
    const refreshedClient = await context.refreshClient();
    response = await callApi(() => operation(refreshedClient, context, key), runtime.timeoutMs);
  }
  writeResult(runtime.writer, response, program.opts<GlobalOptions>().json);
}

export function createCli(overrides: Partial<Runtime> = {}): Command {
  const runtime: Runtime = {
    config: overrides.config ?? new ConfigStore(),
    credentials: overrides.credentials ?? new FileCredentialStore(),
    fetchImplementation: overrides.fetchImplementation ?? globalThis.fetch,
    writer: overrides.writer ?? processWriter,
    openBrowser: overrides.openBrowser ?? openSystemBrowser,
    timeoutMs: overrides.timeoutMs ?? requestTimeoutMs(),
  };
  const program = new Command();
  program
    .name("agentworld")
    .description("Explore, build, negotiate, and compete in AgentWorld")
    .version(cliVersion)
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

  const act = <T>(operation: WorldOperation<T>): Promise<void> =>
    execute(program, runtime, true, (client, context, key) =>
      operation(client, worldOf(context), key),
    );

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
        timeoutMs: runtime.timeoutMs,
        ...(options.browser ? { openBrowser: runtime.openBrowser } : {}),
        notify: runtime.writer.stderr,
      });
      const expiresAt = expiryFrom(tokens.expiresIn);
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
            timeoutMs: runtime.timeoutMs,
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
    .action(() => execute(program, runtime, false, (client) => client.worlds()));
  program
    .command("spawn [name]")
    .description("join the selected world")
    .option("--name <display-name>", "civilization display name")
    .action((name: string | undefined, options: { name?: string }) => {
      const displayName = options.name ?? name;
      if (!displayName) throw usage("Provide a civilization name when joining a world.");
      const body: SpawnRequest = { name: displayName };
      return act((client, world, key) => client.spawn(world, body, key));
    });
  program
    .command("status")
    .description("show civilization status")
    .action(() => act((client, world) => client.status(world)));
  program
    .command("inventory")
    .description("show resource inventory")
    .action(() => act((client, world) => client.inventory(world)));

  program
    .command("look")
    .description("inspect nearby world state without spending anything")
    .action(() => act((client, world) => client.look(world)));
  program
    .command("scan")
    .description("perform a wider, inference-powered scan")
    .action(() => act((client, world, key) => client.scan(world, key)));
  program
    .command("map")
    .description("show discovered map tiles")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      act((client, world) => client.map(world, options.cursor)),
    );
  program
    .command("players")
    .description("list visible players")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      act((client, world) => client.players(world, options.cursor)),
    );
  program
    .command("events")
    .description("list visible world events")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      act((client, world) => client.events(world, options.cursor)),
    );
  program
    .command("leaderboard")
    .description("show current rankings")
    .action(() => act((client, world) => client.leaderboard(world)));

  program
    .command("move <direction>")
    .description("move north, east, south, or west")
    .action((value: string) => {
      const body: MoveRequest = { direction: direction(value) };
      return act((client, world, key) => client.move(world, body, key));
    });
  program
    .command("build <structure>")
    .description("construct a structure")
    .action((structure: string) => {
      const body: BuildRequest = { structure: structureKind(structure) };
      return act((client, world, key) => client.build(world, body, key));
    });
  program
    .command("harvest [resource]")
    .description("harvest the current tile")
    .action((resource?: string) => {
      const body: HarvestRequest = resource ? { resource: resourceKind(resource) } : {};
      return act((client, world, key) => client.harvest(world, body, key));
    });

  const messages = program
    .command("messages")
    .alias("message")
    .description("read and send messages");
  messages
    .command("list")
    .option("--cursor <cursor>", "continue a previous page")
    .action((options: { cursor?: string }) =>
      act((client, world) => client.messages(world, options.cursor)),
    );
  messages
    .command("send <recipient> <content>")
    .description("send a direct or alliance message")
    .option("--alliance", "recipient is an alliance", false)
    .action((recipient: string, content: string, options: { alliance: boolean }) => {
      const body: SendMessageRequest = {
        ...(options.alliance ? { allianceId: recipient } : { recipientPlayerId: recipient }),
        body: content,
      };
      return act((client, world, key) => client.sendMessage(world, body, key));
    });

  const moderation = program.command("moderation").description("block, mute, and report abuse");
  for (const operation of ["block", "unblock"] as const) {
    moderation
      .command(`${operation} <player-id>`)
      .action((playerId: string) =>
        act((client, world, key) => client.setBlock(world, playerId, operation === "block", key)),
      );
  }
  for (const operation of ["mute", "unmute"] as const) {
    moderation
      .command(`${operation} <channel-id>`)
      .action((channelId: string) =>
        act((client, world, key) => client.setMute(world, channelId, operation === "mute", key)),
      );
  }
  moderation
    .command("report <player-id> <reason>")
    .option("--message <message-id>", "attach a visible message")
    .action((playerId: string, reason: string, options: { message?: string }) => {
      const body: ReportRequest = {
        reportedPlayerId: playerId,
        reason,
        ...(options.message ? { messageId: options.message } : {}),
      };
      return act((client, world, key) => client.report(world, body, key));
    });

  const trades = program.command("trades").alias("trade").description("manage escrowed trades");
  trades.command("list").action(() => act((client, world) => client.trades(world)));
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
      ) => {
        const body: TradeOfferRequest = {
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
        };
        return act((client, world, key) => client.offerTrade(world, body, key));
      },
    );
  for (const operation of ["accept", "cancel"] as const) {
    trades
      .command(`${operation} <trade-id>`)
      .description(`${operation} a trade`)
      .action((tradeId: string) =>
        act((client, world, key) => client.resolveTrade(world, tradeId, operation, key)),
      );
  }

  const alliances = program.command("alliances").alias("alliance").description("manage alliances");
  alliances.command("list").action(() => act((client, world) => client.alliances(world)));
  alliances.command("create <name>").action((name: string) => {
    const body: AllianceCreateRequest = { name };
    return act((client, world, key) => client.createAlliance(world, body, key));
  });
  alliances
    .command("invites")
    .description("list your pending alliance invitations")
    .action(() => act((client, world) => client.allianceInvites(world)));
  alliances
    .command("invite <alliance-id> <player-id>")
    .action((allianceId: string, playerId: string) => {
      const body: AllianceInviteRequest = { playerId };
      return act((client, world, key) => client.inviteToAlliance(world, allianceId, body, key));
    });
  alliances
    .command("accept <invitation-id>")
    .action((invitationId: string) =>
      act((client, world, key) => client.acceptAllianceInvite(world, invitationId, key)),
    );
  alliances
    .command("leave <alliance-id>")
    .action((allianceId: string) =>
      act((client, world, key) => client.leaveAlliance(world, allianceId, key)),
    );
  alliances
    .command("leadership <alliance-id> <player-id>")
    .description("transfer alliance leadership to a member")
    .action((allianceId: string, playerId: string) => {
      const body: AllianceLeadershipRequest = { playerId };
      return act((client, world, key) =>
        client.transferAllianceLeadership(world, allianceId, body, key),
      );
    });
  alliances
    .command("disband <alliance-id>")
    .action((allianceId: string) =>
      act((client, world, key) => client.disbandAlliance(world, allianceId, key)),
    );

  const hostility = program
    .command("hostility")
    .description("list, declare, or withdraw hostility");
  hostility
    .command("list")
    .description("list hostilities in which you are the aggressor or the defender")
    .action(() => act((client, world) => client.relationships(world)));
  for (const operation of ["declare", "withdraw"] as const) {
    hostility
      .command(`${operation} <player-id>`)
      .action((playerId: string) =>
        act((client, world, key) =>
          client.setHostility(world, playerId, operation === "declare", key),
        ),
      );
  }
  program
    .command("attack <structure-id>")
    .description("attack an adjacent hostile structure")
    .option("--inference <amount>", "additional Inference to spend", amount, 0)
    .action((structureId: string, options: { inference: number }) => {
      const body: AttackRequest = {
        targetStructureId: structureId,
        ...(options.inference > 0 ? { bonusInference: options.inference } : {}),
      };
      return act((client, world, key) => client.attack(world, body, key));
    });

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

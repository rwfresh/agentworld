import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createDatabase, type Json } from "@agentworld/db";
import {
  type BETA_V1_RULESET,
  worldId as brandedWorldId,
  coordinateKey,
  createWorldDescriptor,
  generateWorldTiles,
  starterPlotForSlot,
} from "@agentworld/game-rules";
import { sql } from "kysely";

import { type AppConfig, readConfig } from "./config.ts";
import { loadRuleset } from "./ruleset-loader.ts";

const INSERT_BATCH_SIZE = 1_000;

export interface SeedSummary {
  readonly installationId: string;
  readonly worldId: string;
  readonly regions: number;
  readonly starterPlots: number;
  readonly tiles: number;
}

interface RegionSeedRow {
  readonly id: string;
  readonly worldId: string;
  readonly authorityServerId: string;
  readonly regionX: number;
  readonly regionY: number;
}

interface StarterPlotSeedRow {
  readonly id: string;
  readonly worldId: string;
  readonly plotIndex: number;
  readonly originX: number;
  readonly originY: number;
  readonly playerId: null;
  readonly allocatedAt: null;
}

function stableId(kind: string, ...parts: readonly (number | string)[]): string {
  const hex = createHash("sha256")
    .update(["agentworld", kind, ...parts].join(":"))
    .digest("hex")
    .slice(0, 32);
  // RFC 9562 UUIDv8: application-defined deterministic payload with the RFC variant bits.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deriveSeasonSeed(
  secret: string,
  installationId: string,
  worldId: string,
  seasonNumber: number,
  rulesetId: string,
): string {
  return createHmac("sha256", secret)
    .update(`agentworld:world-seed:${installationId}:${worldId}:${seasonNumber}:${rulesetId}`)
    .digest("hex");
}

function normalizedJson(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("ruleset JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (typeof value === "object") {
    const normalized: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      if (child !== undefined) normalized[key] = normalizedJson(child);
    }
    return normalized;
  }
  throw new TypeError(`ruleset JSON contains unsupported ${typeof value}`);
}

function rulesetDocument(selectedRuleset: typeof BETA_V1_RULESET): {
  readonly json: Json;
  readonly hash: string;
} {
  const json = normalizedJson(selectedRuleset);
  const canonical = JSON.stringify(json);
  return { json, hash: createHash("sha256").update(canonical).digest("hex") };
}

function batches<Value>(values: readonly Value[], size: number): readonly Value[][] {
  const result: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function seedBetaWorld(config: AppConfig = readConfig()): Promise<SeedSummary> {
  const selectedRuleset = await loadRuleset(config.rulesetPath);
  const installationId = stableId("installation", config.installationName);
  const database = createDatabase(config.databaseUrl);
  let currentWorld:
    | {
        readonly id: string;
        readonly seasonNumber: number;
        readonly startsAt: Date;
        readonly endsAt: Date;
      }
    | undefined;
  let latestSeason = 0;
  try {
    const [current, latest] = await Promise.all([
      database
        .selectFrom("worlds")
        .select(["id", "seasonNumber", "startsAt", "endsAt"])
        .where("homeServerId", "=", installationId)
        .where("state", "in", ["scheduled", "active", "finalizing"])
        .orderBy("seasonNumber", "desc")
        .executeTakeFirst(),
      database
        .selectFrom("worlds")
        .select("seasonNumber")
        .where("homeServerId", "=", installationId)
        .orderBy("seasonNumber", "desc")
        .executeTakeFirst(),
    ]);
    currentWorld = current
      ? {
          ...current,
          startsAt: new Date(current.startsAt),
          endsAt: new Date(current.endsAt),
        }
      : undefined;
    latestSeason = latest?.seasonNumber ?? 0;
  } catch (error) {
    await database.destroy();
    throw error;
  }
  const seasonNumber = currentWorld?.seasonNumber ?? latestSeason + 1;
  const seededWorldId = stableId("world", installationId, selectedRuleset.id, seasonNumber);
  if (currentWorld && currentWorld.id !== seededWorldId) {
    await database.destroy();
    throw new Error("current world identity does not match its pinned installation/ruleset/season");
  }
  const seed = deriveSeasonSeed(
    config.worldSeedSecret,
    installationId,
    seededWorldId,
    seasonNumber,
    selectedRuleset.id,
  );
  const ruleset = rulesetDocument(selectedRuleset);
  const descriptor = createWorldDescriptor(brandedWorldId(seededWorldId), seed, selectedRuleset);
  const startsAt = currentWorld?.startsAt ?? new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const endsAt =
    currentWorld?.endsAt ??
    new Date(
      startsAt.getTime() +
        (selectedRuleset.season.durationTicks / selectedRuleset.ticksPerSecond) * 1_000,
    );

  const regions: RegionSeedRow[] = [];
  const regionIds = new Map<string, string>();
  for (
    let regionY = 0;
    regionY < descriptor.height / selectedRuleset.map.regionSize;
    regionY += 1
  ) {
    for (
      let regionX = 0;
      regionX < descriptor.width / selectedRuleset.map.regionSize;
      regionX += 1
    ) {
      const id = stableId("region", seededWorldId, regionX, regionY);
      regionIds.set(`${regionX},${regionY}`, id);
      regions.push({
        id,
        worldId: seededWorldId,
        authorityServerId: installationId,
        regionX,
        regionY,
      });
    }
  }

  const starterPlots: StarterPlotSeedRow[] = [];
  const starterPlotByTile = new Map<string, string>();
  for (let plotIndex = 0; plotIndex < selectedRuleset.map.maxStarterPlots; plotIndex += 1) {
    const plot = starterPlotForSlot(descriptor, plotIndex, selectedRuleset);
    const id = stableId("starter-plot", seededWorldId, plotIndex);
    starterPlots.push({
      id,
      worldId: seededWorldId,
      plotIndex,
      originX: plot.origin.x,
      originY: plot.origin.y,
      playerId: null,
      allocatedAt: null,
    });
    for (const coordinate of plot.tiles) starterPlotByTile.set(coordinateKey(coordinate), id);
  }

  const tiles = generateWorldTiles(descriptor, selectedRuleset).map((tile) => {
    const regionId = regionIds.get(coordinateKey(tile.region));
    if (regionId === undefined) throw new Error("generated tile refers to an unknown region");
    return {
      id: stableId("tile", seededWorldId, tile.coordinate.x, tile.coordinate.y),
      worldId: seededWorldId,
      regionId,
      x: tile.coordinate.x,
      y: tile.coordinate.y,
      terrain: tile.terrain,
      zone: tile.zone === "starter" ? ("safe" as const) : tile.zone,
      energyRichness: tile.richness.energy,
      materialsRichness: tile.richness.materials,
      inferenceRichness: tile.richness.inference,
      starterPlotId: starterPlotByTile.get(coordinateKey(tile.coordinate)) ?? null,
    };
  });

  try {
    return await database
      .transaction()
      .setIsolationLevel("serializable")
      .execute(async (transaction): Promise<SeedSummary> => {
        await transaction
          .insertInto("installations")
          .values({ id: installationId, name: config.installationName })
          .onConflict((conflict) => conflict.column("id").doNothing())
          .execute();

        await transaction
          .insertInto("worlds")
          .values({
            id: seededWorldId,
            homeServerId: installationId,
            name: `AgentWorld Beta — Season ${seasonNumber}`,
            seasonNumber,
            state: "active",
            startsAt,
            endsAt,
            width: descriptor.width,
            height: descriptor.height,
            seed,
            ruleset: ruleset.json,
            rulesetHash: ruleset.hash,
            maxPlayers: selectedRuleset.map.maxStarterPlots,
            archivedAt: null,
          })
          .onConflict((conflict) => conflict.column("id").doNothing())
          .execute();

        const currentWorlds = await transaction
          .selectFrom("worlds")
          .select(["id", "seed", "rulesetHash", "width", "height"])
          .where("homeServerId", "=", installationId)
          .where("state", "in", ["scheduled", "active", "finalizing"])
          .execute();
        if (currentWorlds.length !== 1 || currentWorlds[0]?.id !== seededWorldId) {
          throw new Error("seed requires exactly one current beta-v1 world for this installation");
        }
        const activeWorld = currentWorlds[0];
        if (
          activeWorld.seed !== seed ||
          activeWorld.rulesetHash !== ruleset.hash ||
          activeWorld.width !== descriptor.width ||
          activeWorld.height !== descriptor.height
        ) {
          throw new Error("existing seeded world does not match the beta-v1 ruleset and seed");
        }

        await transaction
          .insertInto("regions")
          .values(regions)
          .onConflict((conflict) => conflict.columns(["worldId", "regionX", "regionY"]).doNothing())
          .execute();
        await transaction
          .insertInto("starterPlots")
          .values(starterPlots)
          .onConflict((conflict) => conflict.columns(["worldId", "plotIndex"]).doNothing())
          .execute();
        for (const batch of batches(tiles, INSERT_BATCH_SIZE)) {
          await transaction
            .insertInto("tiles")
            .values(batch)
            .onConflict((conflict) => conflict.columns(["worldId", "x", "y"]).doNothing())
            .execute();
        }

        const [regionCount, plotCount, tileCount] = await Promise.all([
          transaction
            .selectFrom("regions")
            .select((expression) => expression.fn.countAll().as("count"))
            .where("worldId", "=", seededWorldId)
            .executeTakeFirstOrThrow(),
          transaction
            .selectFrom("starterPlots")
            .select((expression) => expression.fn.countAll().as("count"))
            .where("worldId", "=", seededWorldId)
            .executeTakeFirstOrThrow(),
          transaction
            .selectFrom("tiles")
            .select((expression) => expression.fn.countAll().as("count"))
            .where("worldId", "=", seededWorldId)
            .executeTakeFirstOrThrow(),
        ]);
        const summary: SeedSummary = {
          installationId,
          worldId: seededWorldId,
          regions: Number(regionCount.count),
          starterPlots: Number(plotCount.count),
          tiles: Number(tileCount.count),
        };
        if (
          summary.regions !== regions.length ||
          summary.starterPlots !== starterPlots.length ||
          summary.tiles !== tiles.length
        ) {
          throw new Error("seeded world is incomplete; refusing to commit partial map data");
        }

        const oauthClientId = stableId("oauth-client", "agentworld-cli");
        const oauthResourceId = stableId("oauth-resource", config.baseUrl);
        const oauthClientResourceId = stableId(
          "oauth-client-resource",
          "agentworld-cli",
          config.baseUrl,
        );
        const scopes = [
          "openid",
          "profile",
          "email",
          "offline_access",
          "world:read",
          "world:act",
          "social:write",
          "trade:write",
          "combat:write",
        ];
        const gameScopes = [
          "world:read",
          "world:act",
          "social:write",
          "trade:write",
          "combat:write",
        ];
        await sql`
          insert into auth."oauthClient" (
            "id", "clientId", "clientSecret", "disabled", "skipConsent",
            "subjectType", "scopes", "createdAt", "updatedAt", "name", "uri",
            "redirectUris", "tokenEndpointAuthMethod", "applicationType",
            "grantTypes", "responseTypes", "requirePKCE", "dpopBoundAccessTokens"
          ) values (
            ${oauthClientId}, 'agentworld-cli', null, false, false, 'public',
            ${JSON.stringify(scopes)}::jsonb, ${startsAt}, ${startsAt}, 'AgentWorld CLI',
            ${config.baseUrl}, '[]'::jsonb, 'none', 'native',
            ${JSON.stringify([
              "urn:ietf:params:oauth:grant-type:device_code",
              "refresh_token",
            ])}::jsonb,
            '[]'::jsonb, true, false
          )
          on conflict ("clientId") do update set
            "scopes" = excluded."scopes",
            "grantTypes" = excluded."grantTypes",
            "updatedAt" = excluded."updatedAt"
        `.execute(transaction);
        await sql`
          insert into auth."oauthResource" (
            "id", "identifier", "name", "accessTokenTtl", "refreshTokenTtl",
            "allowedScopes", "dpopBoundAccessTokensRequired", "disabled",
            "createdAt", "updatedAt", "policyVersion"
          ) values (
            ${oauthResourceId}, ${config.baseUrl}, 'AgentWorld API', 600, 7776000,
            ${JSON.stringify(gameScopes)}::jsonb, false, false, ${startsAt}, ${startsAt}, 1
          )
          on conflict ("identifier") do update set
            "accessTokenTtl" = excluded."accessTokenTtl",
            "refreshTokenTtl" = excluded."refreshTokenTtl",
            "allowedScopes" = excluded."allowedScopes",
            "updatedAt" = excluded."updatedAt"
        `.execute(transaction);
        await sql`
          insert into auth."oauthClientResource" (
            "id", "clientId", "resourceId", "createdAt"
          ) values (${oauthClientResourceId}, 'agentworld-cli', ${config.baseUrl}, ${startsAt})
          on conflict ("clientId", "resourceId") do nothing
        `.execute(transaction);
        return summary;
      });
  } finally {
    await database.destroy();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  seedBetaWorld()
    .then((summary) => {
      console.info(
        `Seeded world ${summary.worldId}: ${summary.regions} regions, ${summary.starterPlots} starter plots, ${summary.tiles} tiles`,
      );
    })
    .catch((error: unknown) => {
      console.error("Database seed failed", error);
      process.exitCode = 1;
    });
}

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create schema if not exists auth`.execute(db);

  await db.schema
    .createTable("installations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("name", "varchar(120)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("worlds")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("home_server_id", "uuid", (column) =>
      column.notNull().references("installations.id"),
    )
    .addColumn("name", "varchar(120)", (column) => column.notNull())
    .addColumn("season_number", "integer", (column) => column.notNull())
    .addColumn("state", "varchar(20)", (column) => column.notNull())
    .addColumn("starts_at", "timestamptz", (column) => column.notNull())
    .addColumn("ends_at", "timestamptz", (column) => column.notNull())
    .addColumn("width", "integer", (column) => column.notNull())
    .addColumn("height", "integer", (column) => column.notNull())
    .addColumn("seed", "varchar(128)", (column) => column.notNull())
    .addColumn("ruleset", "jsonb", (column) => column.notNull())
    .addColumn("ruleset_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("max_players", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("archived_at", "timestamptz")
    .addUniqueConstraint("worlds_server_season_unique", ["home_server_id", "season_number"])
    .execute();

  await sql`alter table worlds add constraint worlds_state_check check (state in ('scheduled','active','finalizing','archived'))`.execute(
    db,
  );
  await sql`alter table worlds add constraint worlds_bounds_check check (width > 0 and height > 0 and max_players > 0 and starts_at < ends_at)`.execute(
    db,
  );

  await db.schema
    .createTable("regions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("authority_server_id", "uuid", (column) =>
      column.notNull().references("installations.id"),
    )
    .addColumn("region_x", "integer", (column) => column.notNull())
    .addColumn("region_y", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("regions_world_coordinates_unique", ["world_id", "region_x", "region_y"])
    .execute();

  await db.schema
    .createTable("starter_plots")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("plot_index", "integer", (column) => column.notNull())
    .addColumn("origin_x", "integer", (column) => column.notNull())
    .addColumn("origin_y", "integer", (column) => column.notNull())
    .addColumn("player_id", "uuid")
    .addColumn("allocated_at", "timestamptz")
    .addUniqueConstraint("starter_plots_world_index_unique", ["world_id", "plot_index"])
    .execute();

  await db.schema
    .createTable("tiles")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("region_id", "uuid", (column) =>
      column.notNull().references("regions.id").onDelete("cascade"),
    )
    .addColumn("x", "integer", (column) => column.notNull())
    .addColumn("y", "integer", (column) => column.notNull())
    .addColumn("terrain", "varchar(16)", (column) => column.notNull())
    .addColumn("zone", "varchar(16)", (column) => column.notNull())
    .addColumn("energy_richness", "smallint", (column) => column.notNull())
    .addColumn("materials_richness", "smallint", (column) => column.notNull())
    .addColumn("inference_richness", "smallint", (column) => column.notNull())
    .addColumn("starter_plot_id", "uuid", (column) => column.references("starter_plots.id"))
    .addUniqueConstraint("tiles_world_coordinates_unique", ["world_id", "x", "y"])
    .execute();

  await sql`alter table tiles add constraint tiles_terrain_check check (terrain in ('plains','forest','hills','wetlands'))`.execute(
    db,
  );
  await sql`alter table tiles add constraint tiles_zone_check check (zone in ('safe','contested','frontier'))`.execute(
    db,
  );
  await sql`alter table tiles add constraint tiles_richness_check check (energy_richness between 0 and 3 and materials_richness between 0 and 3 and inference_richness between 0 and 3)`.execute(
    db,
  );

  await db.schema
    .createTable("civilizations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("user_id", "varchar(191)", (column) => column.notNull().unique())
    .addColumn("name", "varchar(40)", (column) => column.notNull())
    .addColumn("trust_tier", "smallint", (column) => column.notNull().defaultTo(0))
    .addColumn("reputation", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("successful_mutations", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("earned_resources", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("suspended_at", "timestamptz")
    .execute();

  await db.schema
    .createTable("players")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("civilization_id", "uuid", (column) =>
      column.notNull().references("civilizations.id"),
    )
    .addColumn("name", "varchar(40)", (column) => column.notNull())
    .addColumn("position_x", "integer", (column) => column.notNull())
    .addColumn("position_y", "integer", (column) => column.notNull())
    .addColumn("starter_plot_id", "uuid", (column) =>
      column.notNull().references("starter_plots.id"),
    )
    .addColumn("alliance_id", "uuid")
    .addColumn("influence", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("successful_mutations", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("completed_structures", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("earned_energy", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("earned_materials", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("earned_inference", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("combat_influence", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("spawned_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("last_seen_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("players_world_civilization_unique", ["world_id", "civilization_id"])
    .execute();

  await sql`alter table starter_plots add constraint starter_plots_player_fk foreign key (player_id) references players(id) on delete set null`.execute(
    db,
  );

  await db.schema
    .createTable("inventories")
    .addColumn("player_id", "uuid", (column) =>
      column.primaryKey().references("players.id").onDelete("cascade"),
    )
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("bound_energy", "bigint", (column) => column.notNull())
    .addColumn("bound_materials", "bigint", (column) => column.notNull())
    .addColumn("bound_inference", "bigint", (column) => column.notNull())
    .addColumn("energy", "bigint", (column) => column.notNull())
    .addColumn("materials", "bigint", (column) => column.notNull())
    .addColumn("inference", "bigint", (column) => column.notNull())
    .addColumn("escrow_energy", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("escrow_materials", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("escrow_inference", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("energy_rate", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("materials_rate", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("inference_rate", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("last_settled_at", "timestamptz", (column) => column.notNull())
    .addColumn("produced_energy", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("produced_materials", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("produced_inference", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("version", "integer", (column) => column.notNull().defaultTo(0))
    .execute();

  await sql`alter table inventories add constraint inventories_nonnegative_check check (bound_energy >= 0 and bound_materials >= 0 and bound_inference >= 0 and energy >= 0 and materials >= 0 and inference >= 0 and escrow_energy >= 0 and escrow_materials >= 0 and escrow_inference >= 0)`.execute(
    db,
  );

  await db.schema
    .createTable("discovered_tiles")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("tile_id", "uuid", (column) =>
      column.notNull().references("tiles.id").onDelete("cascade"),
    )
    .addColumn("discovered_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("discovered_tiles_pk", ["world_id", "player_id", "tile_id"])
    .execute();

  await db.schema
    .createTable("structures")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("tile_id", "uuid", (column) => column.notNull().references("tiles.id"))
    .addColumn("owner_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("kind", "varchar(24)", (column) => column.notNull())
    .addColumn("status", "varchar(16)", (column) => column.notNull())
    .addColumn("hit_points", "integer", (column) => column.notNull())
    .addColumn("max_hit_points", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("completes_at", "timestamptz")
    .addColumn("activated_at", "timestamptz")
    .addColumn("destroyed_at", "timestamptz")
    .addColumn("last_production_at", "timestamptz", (column) => column.notNull())
    .addColumn("production_remainder_ticks", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("version", "integer", (column) => column.notNull().defaultTo(0))
    .execute();

  await sql`create unique index structures_one_live_per_tile on structures(tile_id) where status in ('constructing','active')`.execute(
    db,
  );
  await sql`alter table structures add constraint structures_kind_check check (kind in ('command_node','generator','extractor','compute_node','defense_node'))`.execute(
    db,
  );
  await sql`alter table structures add constraint structures_status_check check (status in ('constructing','active','destroyed') and hit_points >= 0 and max_hit_points > 0 and hit_points <= max_hit_points)`.execute(
    db,
  );

  await db.schema
    .createTable("combat_award_windows")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("opponent_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("started_at", "timestamptz", (column) => column.notNull())
    .addColumn("influence", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("combat_award_windows_pk", [
      "world_id",
      "player_id",
      "opponent_player_id",
    ])
    .execute();

  await db.schema
    .createTable("cooldowns")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("action", "varchar(64)", (column) => column.notNull())
    .addColumn("available_at", "timestamptz", (column) => column.notNull())
    .addPrimaryKeyConstraint("cooldowns_pk", ["world_id", "player_id", "action"])
    .execute();

  await db.schema
    .createTable("actions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("idempotency_key", "varchar(128)", (column) => column.notNull())
    .addColumn("request_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("action_type", "varchar(64)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("response", "jsonb")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("completed_at", "timestamptz")
    .addUniqueConstraint("actions_idempotency_unique", ["world_id", "player_id", "idempotency_key"])
    .execute();

  await db.schema
    .createTable("events")
    .addColumn("offset", "bigserial", (column) => column.primaryKey())
    .addColumn("id", "uuid", (column) => column.notNull().unique())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("emitting_server_id", "uuid", (column) =>
      column.notNull().references("installations.id"),
    )
    .addColumn("action_id", "uuid", (column) => column.references("actions.id"))
    .addColumn("actor_player_id", "uuid", (column) => column.references("players.id"))
    .addColumn("type", "varchar(80)", (column) => column.notNull())
    .addColumn("aggregate_type", "varchar(40)", (column) => column.notNull())
    .addColumn("aggregate_id", "uuid", (column) => column.notNull())
    .addColumn("aggregate_version", "integer", (column) => column.notNull())
    .addColumn("tick", "bigint", (column) => column.notNull())
    .addColumn("ruleset_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("payload_version", "integer", (column) => column.notNull())
    .addColumn("visibility", "varchar(16)", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("occurred_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("events_world_offset_idx")
    .on("events")
    .columns(["world_id", "offset"])
    .execute();

  await db.schema
    .createTable("resource_ledger")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("action_id", "uuid", (column) => column.references("actions.id"))
    .addColumn("reason", "varchar(64)", (column) => column.notNull())
    .addColumn("energy_delta", "bigint", (column) => column.notNull())
    .addColumn("materials_delta", "bigint", (column) => column.notNull())
    .addColumn("inference_delta", "bigint", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("alliances")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("name", "varchar(40)", (column) => column.notNull())
    .addColumn("leader_player_id", "uuid", (column) => column.notNull().references("players.id"))
    .addColumn("influence", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("disbanded_at", "timestamptz")
    .execute();
  await sql`create unique index alliances_live_name_unique on alliances(world_id, lower(name)) where disbanded_at is null`.execute(
    db,
  );
  await sql`alter table players add constraint players_alliance_fk foreign key (alliance_id) references alliances(id) on delete set null`.execute(
    db,
  );

  await db.schema
    .createTable("alliance_members")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("alliance_id", "uuid", (column) =>
      column.notNull().references("alliances.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("role", "varchar(16)", (column) => column.notNull())
    .addColumn("joined_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("left_at", "timestamptz")
    .addPrimaryKeyConstraint("alliance_members_pk", ["alliance_id", "player_id", "joined_at"])
    .execute();
  await sql`create unique index alliance_members_one_live_unique on alliance_members(world_id, player_id) where left_at is null`.execute(
    db,
  );

  await db.schema
    .createTable("alliance_invites")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("alliance_id", "uuid", (column) =>
      column.notNull().references("alliances.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("invited_by_player_id", "uuid", (column) =>
      column.notNull().references("players.id"),
    )
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("hostilities")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("aggressor_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("defender_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("declared_at", "timestamptz", (column) => column.notNull())
    .addColumn("active_at", "timestamptz", (column) => column.notNull())
    .addColumn("withdrawn_at", "timestamptz")
    .addColumn("retaliation_ends_at", "timestamptz")
    .addPrimaryKeyConstraint("hostilities_pk", [
      "world_id",
      "aggressor_player_id",
      "defender_player_id",
    ])
    .execute();
  await sql`alter table hostilities add constraint hostilities_distinct_players check (aggressor_player_id <> defender_player_id)`.execute(
    db,
  );

  await db.schema
    .createTable("messages")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("sender_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("recipient_player_id", "uuid", (column) =>
      column.references("players.id").onDelete("cascade"),
    )
    .addColumn("alliance_id", "uuid", (column) =>
      column.references("alliances.id").onDelete("cascade"),
    )
    .addColumn("body", "text", (column) => column.notNull())
    .addColumn("content_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("sent_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .execute();
  await sql`alter table messages add constraint messages_one_recipient check ((recipient_player_id is not null)::int + (alliance_id is not null)::int = 1)`.execute(
    db,
  );
  await db.schema
    .createIndex("messages_world_sent_idx")
    .on("messages")
    .columns(["world_id", "sent_at"])
    .execute();

  await db.schema
    .createTable("player_blocks")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("blocker_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("blocked_player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("player_blocks_pk", [
      "world_id",
      "blocker_player_id",
      "blocked_player_id",
    ])
    .execute();

  await db.schema
    .createTable("message_mutes")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) =>
      column.notNull().references("players.id").onDelete("cascade"),
    )
    .addColumn("channel_id", "varchar(191)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("message_mutes_pk", ["world_id", "player_id", "channel_id"])
    .execute();

  await db.schema
    .createTable("reports")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("reporter_player_id", "uuid", (column) => column.notNull().references("players.id"))
    .addColumn("message_id", "uuid", (column) => column.references("messages.id"))
    .addColumn("reported_player_id", "uuid", (column) => column.notNull().references("players.id"))
    .addColumn("reason", "varchar(500)", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .execute();

  await db.schema
    .createTable("trades")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("sender_player_id", "uuid", (column) => column.notNull().references("players.id"))
    .addColumn("recipient_player_id", "uuid", (column) => column.notNull().references("players.id"))
    .addColumn("offered", "jsonb", (column) => column.notNull())
    .addColumn("requested", "jsonb", (column) => column.notNull())
    .addColumn("state", "varchar(16)", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("trades_parties_idx")
    .on("trades")
    .columns(["world_id", "sender_player_id", "recipient_player_id"])
    .execute();

  await db.schema
    .createTable("invitations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("code_hash", "varchar(64)", (column) => column.notNull().unique())
    .addColumn("max_uses", "integer", (column) => column.notNull())
    .addColumn("uses", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_by", "varchar(191)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("revoked_at", "timestamptz")
    .execute();

  await db.schema
    .createTable("security_audit")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("actor_user_id", "varchar(191)")
    .addColumn("action", "varchar(100)", (column) => column.notNull())
    .addColumn("target_type", "varchar(60)", (column) => column.notNull())
    .addColumn("target_id", "varchar(191)")
    .addColumn("metadata", "jsonb", (column) => column.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tables = [
    "security_audit",
    "invitations",
    "trades",
    "reports",
    "message_mutes",
    "player_blocks",
    "messages",
    "hostilities",
    "alliance_invites",
    "alliance_members",
    "alliances",
    "resource_ledger",
    "events",
    "actions",
    "cooldowns",
    "combat_award_windows",
    "structures",
    "discovered_tiles",
    "inventories",
    "players",
    "civilizations",
    "tiles",
    "starter_plots",
    "regions",
    "worlds",
    "installations",
  ] as const;

  for (const table of tables) {
    await db.schema.dropTable(table).ifExists().cascade().execute();
  }
  await db.schema.dropSchema("auth").ifExists().cascade().execute();
}

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("season_finalizations")
    .addColumn("world_id", "uuid", (column) =>
      column.primaryKey().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("final_tick", "bigint", (column) => column.notNull())
    .addColumn("cutoff_at", "timestamptz", (column) => column.notNull())
    .addColumn("ruleset_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("finalized_at", "timestamptz", (column) => column.notNull())
    .execute();
  await sql`alter table season_finalizations add constraint season_finalizations_tick_check check (final_tick >= 0)`.execute(
    db,
  );

  await db.schema
    .createTable("season_player_rankings")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("player_id", "uuid", (column) => column.notNull())
    .addColumn("alliance_id", "uuid")
    .addColumn("rank", "integer", (column) => column.notNull())
    .addColumn("territory_influence", "bigint", (column) => column.notNull())
    .addColumn("structure_influence", "bigint", (column) => column.notNull())
    .addColumn("economy_influence", "bigint", (column) => column.notNull())
    .addColumn("combat_influence", "bigint", (column) => column.notNull())
    .addColumn("total_influence", "bigint", (column) => column.notNull())
    .addColumn("score_reached_at", "timestamptz", (column) => column.notNull())
    .addColumn("finalized_at", "timestamptz", (column) => column.notNull())
    .addColumn("ruleset_hash", "varchar(64)", (column) => column.notNull())
    .addPrimaryKeyConstraint("season_player_rankings_pk", ["world_id", "player_id"])
    .addUniqueConstraint("season_player_rankings_world_rank_unique", ["world_id", "rank"])
    .execute();
  await sql`alter table season_player_rankings add constraint season_player_rankings_player_world_fk foreign key (world_id, player_id) references players(world_id, id) on delete cascade`.execute(
    db,
  );
  await sql`alter table season_player_rankings add constraint season_player_rankings_alliance_world_fk foreign key (world_id, alliance_id) references alliances(world_id, id)`.execute(
    db,
  );
  await sql`alter table season_player_rankings add constraint season_player_rankings_values_check check (rank > 0 and territory_influence >= 0 and structure_influence >= 0 and economy_influence >= 0 and combat_influence >= 0 and total_influence = territory_influence + structure_influence + economy_influence + combat_influence)`.execute(
    db,
  );

  await db.schema
    .createTable("season_alliance_rankings")
    .addColumn("world_id", "uuid", (column) =>
      column.notNull().references("worlds.id").onDelete("cascade"),
    )
    .addColumn("alliance_id", "uuid", (column) => column.notNull())
    .addColumn("rank", "integer", (column) => column.notNull())
    .addColumn("total_influence", "bigint", (column) => column.notNull())
    .addColumn("member_count", "integer", (column) => column.notNull())
    .addColumn("score_reached_at", "timestamptz", (column) => column.notNull())
    .addColumn("finalized_at", "timestamptz", (column) => column.notNull())
    .addColumn("ruleset_hash", "varchar(64)", (column) => column.notNull())
    .addPrimaryKeyConstraint("season_alliance_rankings_pk", ["world_id", "alliance_id"])
    .addUniqueConstraint("season_alliance_rankings_world_rank_unique", ["world_id", "rank"])
    .execute();
  await sql`alter table season_alliance_rankings add constraint season_alliance_rankings_alliance_world_fk foreign key (world_id, alliance_id) references alliances(world_id, id) on delete cascade`.execute(
    db,
  );
  await sql`alter table season_alliance_rankings add constraint season_alliance_rankings_values_check check (rank > 0 and total_influence >= 0 and member_count > 0)`.execute(
    db,
  );

  await sql`
    create function reject_season_snapshot_mutation() returns trigger
    language plpgsql as $$
    begin
      if tg_op = 'INSERT' then
        perform 1 from worlds where id = new.world_id and state = 'finalizing';
        if found then
          return new;
        end if;
        raise exception using
          errcode = '55000',
          message = format('%I may only be written while its world is finalizing', tg_table_name);
      end if;
      raise exception using
        errcode = '55000',
        message = format('%I is immutable', tg_table_name);
    end
    $$
  `.execute(db);
  for (const table of [
    "season_finalizations",
    "season_player_rankings",
    "season_alliance_rankings",
  ] as const) {
    await sql
      .raw(
        `create trigger ${table}_immutable before insert or update or delete on ${table} for each row execute function reject_season_snapshot_mutation()`,
      )
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("season_alliance_rankings").ifExists().execute();
  await db.schema.dropTable("season_player_rankings").ifExists().execute();
  await db.schema.dropTable("season_finalizations").ifExists().execute();
  await sql`drop function if exists reject_season_snapshot_mutation()`.execute(db);
}

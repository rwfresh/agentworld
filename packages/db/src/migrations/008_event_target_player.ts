import { type Kysely, sql } from "kysely";

/**
 * Let an event name the player it was done to. Hostility declarations and attacks are appended
 * under their actor, so the defender never saw them; `target_player_id` lets the feed deliver those
 * rows to their target without widening the actor's private feed. Existing rows stay NULL
 * (actor-only): adding a nullable column without a default is a catalog-only change, the foreign
 * key is validated separately so the append-only journal is never rewritten, and the partial index
 * covers only the small minority of targeted rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("events").addColumn("target_player_id", "uuid").execute();
  await sql`
    alter table events
    add constraint events_target_player_world_fk
    foreign key (world_id, target_player_id) references players (world_id, id) not valid
  `.execute(db);
  await sql`alter table events validate constraint events_target_player_world_fk`.execute(db);
  await db.schema
    .createIndex("events_world_target_player_offset_idx")
    .on("events")
    .columns(["world_id", "target_player_id", "offset"])
    .where("target_player_id", "is not", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("events_world_target_player_offset_idx").ifExists().execute();
  await sql`alter table events drop constraint if exists events_target_player_world_fk`.execute(db);
  await db.schema.alterTable("events").dropColumn("target_player_id").execute();
}

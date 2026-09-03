import { type Kysely, sql } from "kysely";

/** Make aggregate versions a real monotonic invariant, repairing pre-beta duplicate version 1 rows. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update actions
    set response = response - 'body'
    where action_type = 'send-message' and response ? 'body'
  `.execute(db);
  await sql`alter table events disable trigger events_append_only`.execute(db);
  await sql`
    with ordered as (
      select "offset",
        row_number() over (
          partition by emitting_server_id, aggregate_type, aggregate_id
          order by "offset"
        )::integer as repaired_version
      from events
    )
    update events e
    set aggregate_version = ordered.repaired_version
    from ordered
    where e."offset" = ordered."offset"
      and e.aggregate_version <> ordered.repaired_version
  `.execute(db);
  await sql`alter table events enable trigger events_append_only`.execute(db);
  await sql`
    alter table events
    add constraint events_aggregate_version_positive check (aggregate_version > 0)
  `.execute(db);
  await db.schema
    .createIndex("events_emitter_aggregate_version_unique")
    .unique()
    .on("events")
    .columns(["emitting_server_id", "aggregate_type", "aggregate_id", "aggregate_version"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("events_emitter_aggregate_version_unique").ifExists().execute();
  await sql`
    alter table events drop constraint if exists events_aggregate_version_positive
  `.execute(db);
}

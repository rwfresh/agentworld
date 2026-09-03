import { type Kysely, sql } from "kysely";

const appendOnlyTables = ["events", "resource_ledger"] as const;

/** Enforce the event and economic-ledger append-only contract below the application layer. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create function reject_game_audit_mutation() returns trigger
    language plpgsql as $$
    begin
      raise exception using
        errcode = '55000',
        message = format('%I is append-only', tg_table_name);
    end
    $$
  `.execute(db);

  for (const table of appendOnlyTables) {
    await sql
      .raw(
        `create trigger ${table}_append_only before update or delete on ${table} for each row execute function reject_game_audit_mutation()`,
      )
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of appendOnlyTables) {
    await sql.raw(`drop trigger if exists ${table}_append_only on ${table}`).execute(db);
  }
  await sql`drop function if exists reject_game_audit_mutation()`.execute(db);
}

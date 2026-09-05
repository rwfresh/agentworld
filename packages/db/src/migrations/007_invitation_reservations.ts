import { type Kysely, sql } from "kysely";

const appendOnlyTables = ["events", "resource_ledger"] as const;

/**
 * Give invitation reservations their own table keyed by a SHA-256 hash of the normalized email,
 * so `security_audit` stops doubling as reservation state and never stores a plaintext address.
 * Live reservations recorded by the previous release are carried over so an in-flight magic link
 * keeps working, and the legacy audit rows are rewritten to reference the invitation instead of
 * the email. The append-only journals additionally reject TRUNCATE.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("invitation_reservations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("invitation_id", "uuid", (column) => column.notNull().references("invitations.id"))
    .addColumn("email_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("reserved_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addCheckConstraint(
      "invitation_reservations_email_hash_sha256",
      sql`email_hash ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint("invitation_reservations_window", sql`expires_at > reserved_at`)
    .execute();
  await db.schema
    .createIndex("invitation_reservations_invitation_email_unique")
    .unique()
    .on("invitation_reservations")
    .columns(["invitation_id", "email_hash"])
    .execute();
  await db.schema
    .createIndex("invitation_reservations_email_hash_expires_idx")
    .on("invitation_reservations")
    .columns(["email_hash", "expires_at"])
    .execute();

  // Legacy rows stored the normalized email in target_id and the invitation in metadata.
  await sql`
    insert into invitation_reservations (id, invitation_id, email_hash, reserved_at, expires_at)
    select distinct on (i.id, audit.target_id)
      audit.id,
      i.id,
      encode(sha256(convert_to(audit.target_id, 'UTF8')), 'hex'),
      audit.created_at,
      audit.created_at + interval '24 hours'
    from security_audit audit
    join invitations i on i.id::text = audit.metadata ->> 'invitationId'
    where audit.action = 'invitation_reserved'
      and audit.target_type = 'email'
      and audit.target_id is not null
      and audit.created_at > now() - interval '24 hours'
    order by i.id, audit.target_id, audit.created_at desc
    on conflict (invitation_id, email_hash) do nothing
  `.execute(db);
  await sql`
    update security_audit
    set target_type = 'invitation',
      target_id = metadata ->> 'invitationId',
      metadata = metadata - 'invitationId'
    where action = 'invitation_reserved' and target_type = 'email'
  `.execute(db);

  for (const table of appendOnlyTables) {
    await sql
      .raw(
        `create trigger ${table}_append_only_truncate before truncate on ${table} for each statement execute function reject_game_audit_mutation()`,
      )
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of appendOnlyTables) {
    await sql.raw(`drop trigger if exists ${table}_append_only_truncate on ${table}`).execute(db);
  }
  await db.schema.dropTable("invitation_reservations").ifExists().execute();
}

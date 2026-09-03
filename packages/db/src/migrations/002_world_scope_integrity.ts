import { type Kysely, sql } from "kysely";

type DeleteAction = "cascade" | "no action" | "set null";

interface CandidateKey {
  readonly table: string;
  readonly name: string;
}

interface ForeignKeyPlan {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly deleteAction: DeleteAction;
  readonly setNullColumns?: readonly string[];
  readonly legacyName: string;
  readonly legacyColumns: readonly string[];
  readonly legacyDeleteAction: DeleteAction;
}

const CANDIDATE_KEYS: readonly CandidateKey[] = [
  { table: "regions", name: "regions_world_id_id_unique" },
  { table: "starter_plots", name: "starter_plots_world_id_id_unique" },
  { table: "tiles", name: "tiles_world_id_id_unique" },
  { table: "players", name: "players_world_id_id_unique" },
  { table: "actions", name: "actions_world_id_id_unique" },
  { table: "alliances", name: "alliances_world_id_id_unique" },
  { table: "messages", name: "messages_world_id_id_unique" },
];

const FOREIGN_KEYS: readonly ForeignKeyPlan[] = [
  {
    table: "tiles",
    name: "tiles_region_world_fk",
    columns: ["world_id", "region_id"],
    referencedTable: "regions",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "tiles_region_id_fkey",
    legacyColumns: ["region_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "tiles",
    name: "tiles_starter_plot_world_fk",
    columns: ["world_id", "starter_plot_id"],
    referencedTable: "starter_plots",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "tiles_starter_plot_id_fkey",
    legacyColumns: ["starter_plot_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "players",
    name: "players_starter_plot_world_fk",
    columns: ["world_id", "starter_plot_id"],
    referencedTable: "starter_plots",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "players_starter_plot_id_fkey",
    legacyColumns: ["starter_plot_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "starter_plots",
    name: "starter_plots_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "set null",
    setNullColumns: ["player_id"],
    legacyName: "starter_plots_player_fk",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "set null",
  },
  {
    table: "inventories",
    name: "inventories_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "inventories_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "discovered_tiles",
    name: "discovered_tiles_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "discovered_tiles_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "discovered_tiles",
    name: "discovered_tiles_tile_world_fk",
    columns: ["world_id", "tile_id"],
    referencedTable: "tiles",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "discovered_tiles_tile_id_fkey",
    legacyColumns: ["tile_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "structures",
    name: "structures_tile_world_fk",
    columns: ["world_id", "tile_id"],
    referencedTable: "tiles",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "structures_tile_id_fkey",
    legacyColumns: ["tile_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "structures",
    name: "structures_owner_player_world_fk",
    columns: ["world_id", "owner_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "structures_owner_player_id_fkey",
    legacyColumns: ["owner_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "combat_award_windows",
    name: "combat_awards_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "combat_award_windows_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "combat_award_windows",
    name: "combat_awards_opponent_world_fk",
    columns: ["world_id", "opponent_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "combat_award_windows_opponent_player_id_fkey",
    legacyColumns: ["opponent_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "cooldowns",
    name: "cooldowns_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "cooldowns_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "actions",
    name: "actions_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "actions_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "events",
    name: "events_action_world_fk",
    columns: ["world_id", "action_id"],
    referencedTable: "actions",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "events_action_id_fkey",
    legacyColumns: ["action_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "events",
    name: "events_actor_player_world_fk",
    columns: ["world_id", "actor_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "events_actor_player_id_fkey",
    legacyColumns: ["actor_player_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "resource_ledger",
    name: "resource_ledger_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "resource_ledger_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "resource_ledger",
    name: "resource_ledger_action_world_fk",
    columns: ["world_id", "action_id"],
    referencedTable: "actions",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "resource_ledger_action_id_fkey",
    legacyColumns: ["action_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "alliances",
    name: "alliances_leader_player_world_fk",
    columns: ["world_id", "leader_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "alliances_leader_player_id_fkey",
    legacyColumns: ["leader_player_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "players",
    name: "players_alliance_world_fk",
    columns: ["world_id", "alliance_id"],
    referencedTable: "alliances",
    referencedColumns: ["world_id", "id"],
    deleteAction: "set null",
    setNullColumns: ["alliance_id"],
    legacyName: "players_alliance_fk",
    legacyColumns: ["alliance_id"],
    legacyDeleteAction: "set null",
  },
  {
    table: "alliance_members",
    name: "alliance_members_alliance_world_fk",
    columns: ["world_id", "alliance_id"],
    referencedTable: "alliances",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "alliance_members_alliance_id_fkey",
    legacyColumns: ["alliance_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "alliance_members",
    name: "alliance_members_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "alliance_members_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "alliance_invites",
    name: "alliance_invites_alliance_world_fk",
    columns: ["world_id", "alliance_id"],
    referencedTable: "alliances",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "alliance_invites_alliance_id_fkey",
    legacyColumns: ["alliance_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "alliance_invites",
    name: "alliance_invites_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "alliance_invites_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "alliance_invites",
    name: "alliance_invites_inviter_world_fk",
    columns: ["world_id", "invited_by_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "alliance_invites_invited_by_player_id_fkey",
    legacyColumns: ["invited_by_player_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "hostilities",
    name: "hostilities_aggressor_world_fk",
    columns: ["world_id", "aggressor_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "hostilities_aggressor_player_id_fkey",
    legacyColumns: ["aggressor_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "hostilities",
    name: "hostilities_defender_world_fk",
    columns: ["world_id", "defender_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "hostilities_defender_player_id_fkey",
    legacyColumns: ["defender_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "messages",
    name: "messages_sender_world_fk",
    columns: ["world_id", "sender_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "messages_sender_player_id_fkey",
    legacyColumns: ["sender_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "messages",
    name: "messages_recipient_world_fk",
    columns: ["world_id", "recipient_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "messages_recipient_player_id_fkey",
    legacyColumns: ["recipient_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "messages",
    name: "messages_alliance_world_fk",
    columns: ["world_id", "alliance_id"],
    referencedTable: "alliances",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "messages_alliance_id_fkey",
    legacyColumns: ["alliance_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "player_blocks",
    name: "player_blocks_blocker_world_fk",
    columns: ["world_id", "blocker_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "player_blocks_blocker_player_id_fkey",
    legacyColumns: ["blocker_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "player_blocks",
    name: "player_blocks_blocked_world_fk",
    columns: ["world_id", "blocked_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "player_blocks_blocked_player_id_fkey",
    legacyColumns: ["blocked_player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "message_mutes",
    name: "message_mutes_player_world_fk",
    columns: ["world_id", "player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "cascade",
    legacyName: "message_mutes_player_id_fkey",
    legacyColumns: ["player_id"],
    legacyDeleteAction: "cascade",
  },
  {
    table: "reports",
    name: "reports_reporter_world_fk",
    columns: ["world_id", "reporter_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "reports_reporter_player_id_fkey",
    legacyColumns: ["reporter_player_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "reports",
    name: "reports_reported_player_world_fk",
    columns: ["world_id", "reported_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "reports_reported_player_id_fkey",
    legacyColumns: ["reported_player_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "reports",
    name: "reports_message_world_fk",
    columns: ["world_id", "message_id"],
    referencedTable: "messages",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "reports_message_id_fkey",
    legacyColumns: ["message_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "trades",
    name: "trades_sender_world_fk",
    columns: ["world_id", "sender_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "trades_sender_player_id_fkey",
    legacyColumns: ["sender_player_id"],
    legacyDeleteAction: "no action",
  },
  {
    table: "trades",
    name: "trades_recipient_world_fk",
    columns: ["world_id", "recipient_player_id"],
    referencedTable: "players",
    referencedColumns: ["world_id", "id"],
    deleteAction: "no action",
    legacyName: "trades_recipient_player_id_fkey",
    legacyColumns: ["recipient_player_id"],
    legacyDeleteAction: "no action",
  },
];

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`unsafe SQL identifier: ${value}`);
  return value;
}

function columnList(columns: readonly string[]): string {
  return `(${columns.map(identifier).join(", ")})`;
}

function deleteClause(action: DeleteAction, setNullColumns?: readonly string[]): string {
  switch (action) {
    case "cascade":
      return " on delete cascade";
    case "no action":
      return "";
    case "set null":
      return setNullColumns === undefined
        ? " on delete set null"
        : ` on delete set null ${columnList(setNullColumns)}`;
  }
}

async function execute(db: Kysely<unknown>, statement: string): Promise<void> {
  await sql.raw(statement).execute(db);
}

function addForeignKey(plan: ForeignKeyPlan): string {
  return (
    `alter table ${identifier(plan.table)} add constraint ${identifier(plan.name)} ` +
    `foreign key ${columnList(plan.columns)} references ${identifier(plan.referencedTable)} ` +
    `${columnList(plan.referencedColumns)}${deleteClause(plan.deleteAction, plan.setNullColumns)} not valid`
  );
}

function restoreLegacyForeignKey(plan: ForeignKeyPlan): string {
  return (
    `alter table ${identifier(plan.table)} add constraint ${identifier(plan.legacyName)} ` +
    `foreign key ${columnList(plan.legacyColumns)} references ${identifier(plan.referencedTable)} (id)` +
    `${deleteClause(plan.legacyDeleteAction)} not valid`
  );
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const key of CANDIDATE_KEYS) {
    await execute(
      db,
      `alter table ${identifier(key.table)} add constraint ${identifier(key.name)} unique (world_id, id)`,
    );
  }

  for (const foreignKey of FOREIGN_KEYS) await execute(db, addForeignKey(foreignKey));
  for (const foreignKey of FOREIGN_KEYS) {
    await execute(
      db,
      `alter table ${identifier(foreignKey.table)} validate constraint ${identifier(foreignKey.name)}`,
    );
  }
  for (const foreignKey of FOREIGN_KEYS) {
    await execute(
      db,
      `alter table ${identifier(foreignKey.table)} drop constraint ${identifier(foreignKey.legacyName)}`,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const foreignKey of [...FOREIGN_KEYS].reverse()) {
    await execute(
      db,
      `alter table ${identifier(foreignKey.table)} drop constraint ${identifier(foreignKey.name)}`,
    );
  }
  for (const foreignKey of FOREIGN_KEYS) await execute(db, restoreLegacyForeignKey(foreignKey));
  for (const foreignKey of FOREIGN_KEYS) {
    await execute(
      db,
      `alter table ${identifier(foreignKey.table)} validate constraint ${identifier(foreignKey.legacyName)}`,
    );
  }
  for (const key of [...CANDIDATE_KEYS].reverse()) {
    await execute(
      db,
      `alter table ${identifier(key.table)} drop constraint ${identifier(key.name)}`,
    );
  }
}

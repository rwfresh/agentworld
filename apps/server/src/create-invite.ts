import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createDatabase } from "@agentworld/db";
import { v7 as uuidv7 } from "uuid";

import { type AppConfig, readConfig } from "./config.ts";
import { generateInvitationCode, invitationHash } from "./invitation-code.ts";

const DEFAULT_MAX_USES = 1;
const DEFAULT_EXPIRY_HOURS = 7 * 24;
const MAX_INVITATION_USES = 10_000;
const MAX_EXPIRY_HOURS = 365 * 24;

type Environment = Readonly<Record<string, string | undefined>>;

export interface CreateInvitationCommand {
  readonly kind: "create";
  readonly createdBy: string;
  readonly maxUses: number;
  readonly expiresInHours: number;
  readonly json: boolean;
}

export interface InvitationHelpCommand {
  readonly kind: "help";
}

export type InvitationCommand = CreateInvitationCommand | InvitationHelpCommand;

export interface CreatedInvitation {
  readonly id: string;
  readonly code: string;
  readonly maxUses: number;
  readonly expiresAt: Date;
}

const usage = `Create a hashed AgentWorld registration invitation.

Usage:
  node apps/server/dist/create-invite.js --created-by <operator-id> [options]

Options:
  --created-by <id>          Stable, non-email operator identifier (required)
  --max-uses <count>         Redemption limit (default: 1)
  --expires-in-hours <hours> Expiry from creation (default: 168)
  --json                     Emit one JSON object
  -h, --help                 Show this help

The same values may be supplied as INVITE_CREATED_BY, INVITE_MAX_USES, and
INVITE_EXPIRES_HOURS. Command-line values take precedence. The invitation code
is generated cryptographically, stored only as a SHA-256 hash, and printed once.
`;

function boundedInteger(value: string, name: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

function operatorIdentifier(value: string | undefined): string {
  const normalized = value?.normalize("NFKC").trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) {
    throw new Error(
      "INVITE_CREATED_BY/--created-by must be a stable identifier using letters, digits, ._:-",
    );
  }
  return normalized;
}

export function parseInvitationCommand(
  args: readonly string[],
  env: Environment = process.env,
): InvitationCommand {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "created-by": { type: "string" },
      "expires-in-hours": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      "max-uses": { type: "string" },
    },
  });

  if (values.help) return { kind: "help" };
  const maxUsesValue = values["max-uses"] ?? env.INVITE_MAX_USES ?? String(DEFAULT_MAX_USES);
  const expiryValue =
    values["expires-in-hours"] ?? env.INVITE_EXPIRES_HOURS ?? String(DEFAULT_EXPIRY_HOURS);
  return {
    kind: "create",
    createdBy: operatorIdentifier(values["created-by"] ?? env.INVITE_CREATED_BY),
    maxUses: boundedInteger(maxUsesValue, "INVITE_MAX_USES/--max-uses", MAX_INVITATION_USES),
    expiresInHours: boundedInteger(
      expiryValue,
      "INVITE_EXPIRES_HOURS/--expires-in-hours",
      MAX_EXPIRY_HOURS,
    ),
    json: values.json,
  };
}

export async function createInvitation(
  command: CreateInvitationCommand,
  config: AppConfig = readConfig(),
  now: Date = new Date(),
): Promise<CreatedInvitation> {
  const database = createDatabase(config.databaseUrl);
  const id = uuidv7();
  const code = generateInvitationCode();
  const expiresAt = new Date(now.getTime() + command.expiresInHours * 60 * 60 * 1_000);
  try {
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("invitations")
        .values({
          id,
          codeHash: invitationHash(code),
          maxUses: command.maxUses,
          expiresAt,
          createdBy: command.createdBy,
          revokedAt: null,
        })
        .execute();
      await transaction
        .insertInto("securityAudit")
        .values({
          id: uuidv7(),
          actorUserId: null,
          action: "invitation_created",
          targetType: "invitation",
          targetId: id,
          metadata: { maxUses: command.maxUses, expiresAt: expiresAt.toISOString() },
        })
        .execute();
    });
  } finally {
    await database.destroy();
  }
  return { id, code, maxUses: command.maxUses, expiresAt };
}

function invitationOutput(result: CreatedInvitation, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      invitationId: result.id,
      code: result.code,
      maxUses: result.maxUses,
      expiresAt: result.expiresAt.toISOString(),
    })}\n`;
  }
  return [
    "Invitation created.",
    `Code (shown once): ${result.code}`,
    `Invitation ID: ${result.id}`,
    `Maximum uses: ${result.maxUses}`,
    `Expires at: ${result.expiresAt.toISOString()}`,
    "Transfer the code through a secure channel; it cannot be recovered from the database.",
    "",
  ].join("\n");
}

export async function runCreateInvitation(
  args: readonly string[] = process.argv.slice(2),
  env: Environment = process.env,
): Promise<void> {
  const command = parseInvitationCommand(args, env);
  if (command.kind === "help") {
    process.stdout.write(usage);
    return;
  }
  const result = await createInvitation(command, readConfig(env));
  process.stdout.write(invitationOutput(result, command.json));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runCreateInvitation().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Invitation creation failed: ${message}`);
    process.exitCode = 1;
  });
}

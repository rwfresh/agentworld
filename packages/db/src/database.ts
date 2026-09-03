import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

const INT8 = 20;

function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`PostgreSQL bigint is outside JavaScript's safe integer range: ${value}`);
  }
  return parsed;
}

export function createPool(connectionString: string): pg.Pool {
  const typeParsers = new pg.TypeOverrides();
  typeParsers.setTypeParser(INT8, parseSafeInteger);

  return new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    statement_timeout: 10_000,
    types: typeParsers,
  });
}

export function createDatabase(connectionString: string): Kysely<Database> {
  return createDatabaseFromPool(createPool(connectionString));
}

export function createDatabaseFromPool(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

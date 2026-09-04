import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema.ts";

const INT8 = 20;
const DEFAULT_POOL_SIZE = 10;

export interface PoolOptions {
  /** Maximum pooled connections; defaults to the validated `DATABASE_POOL_SIZE` or 10. */
  readonly maxConnections?: number;
}

function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`PostgreSQL bigint is outside JavaScript's safe integer range: ${value}`);
  }
  return parsed;
}

/**
 * `pg.Pool` accepts NaN, zero, or fractional maximums and then misbehaves under load; fail at
 * startup with an actionable message instead. An unset or blank value selects the default.
 */
export function resolvePoolSize(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_POOL_SIZE;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^[1-9][0-9]*$/.test(trimmed) || !Number.isSafeInteger(parsed)) {
    throw new RangeError(
      `DATABASE_POOL_SIZE must be a positive integer, received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  const typeParsers = new pg.TypeOverrides();
  typeParsers.setTypeParser(INT8, parseSafeInteger);
  const max = options.maxConnections ?? resolvePoolSize(process.env.DATABASE_POOL_SIZE);
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError(`maxConnections must be a positive integer, received ${String(max)}`);
  }

  return new pg.Pool({
    connectionString,
    max,
    statement_timeout: 10_000,
    types: typeParsers,
  });
}

export function createDatabase(
  connectionString: string,
  options: PoolOptions = {},
): Kysely<Database> {
  return createDatabaseFromPool(createPool(connectionString, options));
}

export function createDatabaseFromPool(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

import { pathToFileURL } from "node:url";

import { createDatabase, migrateToLatest } from "@agentworld/db";

import { type AppConfig, readConfig } from "./config.ts";

export async function runMigrations(config: AppConfig = readConfig()): Promise<void> {
  const database = createDatabase(config.databaseUrl);
  try {
    await migrateToLatest(database);
  } finally {
    await database.destroy();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runMigrations().catch((error: unknown) => {
    console.error("Database migration failed", error);
    process.exitCode = 1;
  });
}

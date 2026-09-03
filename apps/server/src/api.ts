import { createDatabase } from "@agentworld/db";
import { buildApp } from "./app.ts";
import { readConfig } from "./config.ts";

const config = readConfig();
const database = createDatabase(config.databaseUrl);
const app = await buildApp({ config, database });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.destroy();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await database.destroy();
  process.exitCode = 1;
}

import { createDatabase } from "@agentworld/db";
import { buildApp } from "./app.ts";
import { readConfig } from "./config.ts";

const config = readConfig();
const database = createDatabase(config.databaseUrl);
const app = await buildApp({ config, database });

let cleanup: Promise<void> | undefined;

/**
 * One exit path for signals and listen failure: the HTTP server is always closed first and the
 * pool is always destroyed afterwards, even when either step rejects. Failures are logged and
 * surface as a non-zero exit code rather than being thrown from a signal handler.
 */
function shutdown(reason: string, failure?: unknown): Promise<void> {
  cleanup ??= (async () => {
    if (failure === undefined) {
      app.log.info({ reason }, "shutting down");
    } else {
      app.log.error({ error: failure, reason }, "api process failed");
      process.exitCode = 1;
    }
    try {
      await app.close();
    } catch (error) {
      app.log.error({ error }, "failed to close the HTTP server cleanly");
      process.exitCode = 1;
    } finally {
      try {
        await database.destroy();
      } catch (error) {
        app.log.error({ error }, "failed to close the database pool cleanly");
        process.exitCode = 1;
      }
    }
  })();
  return cleanup;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await shutdown("listen-failure", error);
}

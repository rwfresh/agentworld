#!/usr/bin/env node
import { CommanderError } from "commander";
import { createCli, renderCliError } from "./cli.ts";
import { ExitCode } from "./errors.ts";

async function main(): Promise<void> {
  const cli = createCli();
  try {
    await cli.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = ExitCode.usage;
      return;
    }
    process.exitCode = renderCliError(
      error,
      process.argv.includes("--json") || process.argv.includes("-j"),
    );
  }
}

main().catch((error: unknown) => {
  process.exitCode = renderCliError(
    error,
    process.argv.includes("--json") || process.argv.includes("-j"),
  );
});

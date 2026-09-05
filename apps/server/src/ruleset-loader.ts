import { readFile } from "node:fs/promises";
import { assertValidRuleset, type Ruleset } from "@agentworld/game-rules";
import { parse } from "yaml";

/**
 * Parses and validates a ruleset file. Validation is shape-safe, so a malformed document reports
 * the offending paths instead of failing on a dereference.
 */
export async function loadRuleset(path: string): Promise<Ruleset> {
  const document: unknown = parse(await readFile(path, "utf8"));
  try {
    return assertValidRuleset(document);
  } catch (error) {
    throw new Error(
      `Invalid ruleset at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

import { readFile } from "node:fs/promises";
import { assertValidRuleset, type Ruleset } from "@agentworld/game-rules";
import { parse } from "yaml";

export async function loadRuleset(path: string): Promise<Ruleset> {
  const document = parse(await readFile(path, "utf8")) as unknown;
  if (!document || typeof document !== "object") {
    throw new Error(`Ruleset at ${path} must be a YAML object`);
  }
  try {
    return assertValidRuleset(document as Ruleset);
  } catch (error) {
    throw new Error(
      `Invalid ruleset at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

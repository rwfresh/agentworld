import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BETA_V1_RULESET } from "@agentworld/game-rules";
import { describe, expect, it } from "vitest";
import { loadRuleset } from "./ruleset-loader.ts";

const repositoryRulesetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../config/rulesets/beta-v1.yaml",
);

async function temporaryRuleset(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agentworld-ruleset-"));
  const file = path.join(directory, "ruleset.yaml");
  await writeFile(file, contents, "utf8");
  return file;
}

describe("loadRuleset", () => {
  it("loads the checked-in beta ruleset and matches the built-in defaults", async () => {
    await expect(loadRuleset(repositoryRulesetPath)).resolves.toEqual(BETA_V1_RULESET);
  });

  it("reports the offending path for a document missing a section", async () => {
    const file = await temporaryRuleset("id: broken\nticksPerSecond: 1\n");
    await expect(loadRuleset(file)).rejects.toThrow(/Invalid ruleset at .*trust/);
  });

  it("rejects a list root and a string where a number belongs without a TypeError", async () => {
    const listRoot = await temporaryRuleset("- not\n- an\n- object\n");
    await expect(loadRuleset(listRoot)).rejects.toThrow(/Invalid ruleset/);
    const original = await readFile(repositoryRulesetPath, "utf8");
    const stringNumber = await temporaryRuleset(
      original.replace("ticksPerSecond: 1", 'ticksPerSecond: "one"'),
    );
    await expect(loadRuleset(stringNumber)).rejects.toThrow(/ticksPerSecond/);
  });
});

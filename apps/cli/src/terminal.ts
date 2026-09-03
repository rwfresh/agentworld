const escapeCharacter = String.fromCharCode(27);
const bellCharacter = String.fromCharCode(7);

/** Strip terminal controls without attempting to interpret untrusted escape sequences. */
export function sanitizeTerminalText(input: string): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    const character = input[index];
    if (character === escapeCharacter) {
      const next = input[index + 1];
      index += 2;

      if (next === "]") {
        while (index < input.length) {
          if (input[index] === bellCharacter) {
            index += 1;
            break;
          }
          if (input[index] === escapeCharacter && input[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }

      if (next === "[") {
        while (index < input.length) {
          const code = input.charCodeAt(index);
          index += 1;
          if (code >= 64 && code <= 126) break;
        }
        continue;
      }

      continue;
    }

    const code = input.charCodeAt(index);
    index += 1;
    const isBidirectionalControl =
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (
      (code === 10 || code === 9 || (code >= 32 && (code < 127 || code > 159))) &&
      !isBidirectionalControl
    ) {
      output += character;
    }
  }

  return output.replaceAll("\r", "");
}

export function isUntrustedText(
  value: unknown,
): value is { readonly content: string; readonly trust: "untrusted_player_input" } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.trust === "untrusted_player_input" && typeof candidate.content === "string";
}

export function renderUntrustedText(content: string): string {
  return [
    "--- UNTRUSTED PLAYER CONTENT ---",
    sanitizeTerminalText(content),
    "--- END UNTRUSTED PLAYER CONTENT ---",
  ].join("\n");
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, normalizeJson(source[key])]),
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value), null, 2);
}

function labelFor(key: string): string {
  const spaced = key.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderValue(value: unknown, depth: number): string {
  const indentation = "  ".repeat(depth);
  if (isUntrustedText(value)) return renderUntrustedText(value.content);
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value.map((item) => `${indentation}• ${renderValue(item, depth + 1)}`).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(
        ([key, item]) =>
          `${indentation}${labelFor(sanitizeTerminalText(key))}: ${renderValue(item, depth + 1)}`,
      )
      .join("\n");
  }
  return sanitizeTerminalText(String(value));
}

export function humanText(value: unknown): string {
  return renderValue(value, 0);
}

export interface OutputWriter {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const processWriter: OutputWriter = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

export function writeResult(writer: OutputWriter, value: unknown, json: boolean): void {
  writer.stdout(json ? stableJson(value) : humanText(value));
}

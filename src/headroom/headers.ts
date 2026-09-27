/** One `ANTHROPIC_CUSTOM_HEADERS` entry as the child environment carries it. */
export interface CustomHeaderEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * Merges `ANTHROPIC_CUSTOM_HEADERS` blocks: every string in `existing` (as Claude Code writes them, `Name: Value` entries separated by newlines) parsed in order, then every entry of `additions` set on top, so a later block replaces an earlier block's value for the same header name while leaving every other entry untouched. The result is re-serialised in first-seen order with additions updated in place.
 *
 * Blank lines are skipped on parse; a header name keeps its own case exactly as written, since header names are case-insensitive on the wire but a statusline or log reading this value back should see what was set.
 */
export function mergeAnthropicCustomHeaders(
  existing: readonly (string | undefined)[],
  additions: readonly CustomHeaderEntry[],
): string {
  const merged = new Map<string, string>();
  for (const block of existing) {
    if (block === undefined) {
      continue;
    }
    for (const line of block.split("\n")) {
      const entry = parseCustomHeaderLine(line);
      if (entry === undefined) {
        continue;
      }
      merged.set(entry.name, entry.value);
    }
  }
  for (const entry of additions) {
    merged.set(entry.name, entry.value);
  }
  return [...merged].map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** Parses one `Name: Value` line, or undefined for a blank/malformed line (no colon at all). The value keeps any further colons and surrounding whitespace is trimmed. */
function parseCustomHeaderLine(line: string): CustomHeaderEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }
  const colon = trimmed.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return { name: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() };
}

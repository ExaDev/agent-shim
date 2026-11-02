/**
 * Splits `$CLAUDE_EXTRA_FLAGS` into multiple argv entries on whitespace, confirmed against a person's real dotfiles wrapper scripts, not a hypothetical requirement.
 *
 * `"--continue continue"` splits into `["--continue", "continue"]`, matching what wrappers like `cccc`/`mcc`/`occ`/`zcc`/`scc` rely on. Unset or empty input produces zero argv entries — `splitExtraFlags(undefined) === []` and `splitExtraFlags("") === []` — a naive `.split(" ")` would yield `[""]` for the empty case, a real bug this avoids rather than a hypothetical one. No wrapper script surveyed ever embeds a literal space inside one intended argument, so a plain whitespace split (collapsing any run of whitespace, not just a single space) is correct and sufficient; adding quote-aware parsing would only risk changing the meaning of a future value that happens to contain a quote character, for zero real benefit.
 */
export function splitExtraFlags(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(/\s+/);
}

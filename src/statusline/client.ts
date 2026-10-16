import path from "node:path";

import type { FarmFs } from "../launcher/ports";

/** Whether a statusline payload came from the Antigravity CLI, which names itself in `product`. */
export function isAntigravityPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "product" in payload && payload.product === "antigravity";
}

/** Where the Antigravity CLI keeps its settings, relative to the home directory. */
const ANTIGRAVITY_SETTINGS_SEGMENTS = [".gemini", "antigravity-cli", "settings.json"] as const;

/**
 * Whether the Antigravity CLI draws the statusline command's output below its own built-in line (`statusLine.stack_with_default`) rather than in place of it. The payload does not carry the setting, so it is read from the CLI's settings file. Throws on a file that is not valid JSON; false when the file or the setting is absent, which is the CLI's own default of replacing.
 */
export function antigravityStacksWithDefault(fs: Pick<FarmFs, "readFileUtf8">, homeDir: string): boolean {
  const raw = fs.readFileUtf8(path.join(homeDir, ...ANTIGRAVITY_SETTINGS_SEGMENTS));
  if (raw === undefined) {
    return false;
  }
  const settings: unknown = JSON.parse(raw);
  if (typeof settings !== "object" || settings === null || !("statusLine" in settings)) {
    return false;
  }
  const statusLine = settings.statusLine;
  return typeof statusLine === "object" && statusLine !== null && "stack_with_default" in statusLine && statusLine.stack_with_default === true;
}

import path from "node:path";
import { z } from "zod";

import { boundedDisplayText } from "../../sanitise";
import type { RenderContext } from "../context";

/** A settings file, read for the one key this segment uses. */
const SettingsFileSchema = z.looseObject({ outputStyle: z.string().optional().catch(undefined) });

/** The output style a settings file names, or undefined when the file is missing, is not JSON, or names none. */
function outputStyleIn(file: string, readText: RenderContext["ports"]["readText"]): string | undefined {
  const text = readText(file);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const settings = SettingsFileSchema.safeParse(parsed);
  const style = settings.success ? boundedDisplayText(settings.data.outputStyle ?? "") : "";
  return style === "" ? undefined : style;
}

/** The output style the session's settings choose, or undefined when none does. The settings layers are read in the order the client applies them, each overriding the last: the user's settings, the user's local settings, the project's, and the project's local ones. */
export function outputStyleSegment({ payload, ports, t }: RenderContext): string | undefined {
  // An empty `CLAUDE_CONFIG_DIR` is unset, as the launcher reads it: taken literally it would put the settings files in the working directory.
  const pinned = ports.env.CLAUDE_CONFIG_DIR;
  const configDirectory = pinned === undefined || pinned === "" ? path.join(ports.homeDirectory, ".claude") : pinned;
  const projectDirectory = payload.cwd ?? payload.workspace?.current_dir;
  const files = [
    path.join(configDirectory, "settings.json"),
    path.join(configDirectory, "settings.local.json"),
    ...(projectDirectory === undefined ? [] : [path.join(projectDirectory, ".claude", "settings.json"), path.join(projectDirectory, ".claude", "settings.local.json")]),
  ];
  const style = files.map((file) => outputStyleIn(file, ports.readText)).findLast((name) => name !== undefined);
  return style === undefined ? undefined : t("outputStyle.name", { name: style });
}

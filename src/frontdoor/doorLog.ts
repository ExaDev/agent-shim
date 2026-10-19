import fs from "node:fs";

import type { LayoutPaths } from "../paths";

/** Appends one timestamped line to the front door's own log: the one record that outlives a door process, written by the door itself and by a launcher about to replace it. */
export function appendDoorLog(paths: LayoutPaths, line: string): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.appendFileSync(paths.frontdoorLogPath, `${new Date().toISOString()} ${line}\n`);
}

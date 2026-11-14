import { appendLogText } from "../logFile";
import type { LayoutPaths } from "../paths";

/** Appends one timestamped line to the front door's own log: the one record that outlives a door process, written by the door itself and by a launcher about to replace it. A line that cannot be written is dropped (`appendLogText`), so a logger built on this does not throw. */
export function appendDoorLog(paths: LayoutPaths, line: string): void {
  appendLogText(paths.logsDir, paths.frontdoorLogPath, `${new Date().toISOString()} ${line}\n`);
}

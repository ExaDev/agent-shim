import { appendLogText } from "../logFile";
import type { LayoutPaths } from "../paths";

/** Appends `text` to the headroom supervisor's and daemon's log as given. Text that cannot be written is dropped (`appendLogText`), so a logger built on this does not throw. */
export function appendHeadroomLog(paths: LayoutPaths, text: string): void {
  appendLogText(paths.logsDir, paths.headroomLogPath, text);
}

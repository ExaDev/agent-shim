import path from "node:path";

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { superviseDirOf } from "./registry";

/** Stages composed caller settings in a private file so a settings file's contents never become process arguments. The caller releases the file after the supervised launch ends. */
export function stageSupervisedSettings(fs: Pick<FarmFs, "mkdirPrivate" | "writeFilePrivate" | "removeRecursive">, paths: LayoutPaths, pool: string, sessionId: string, pid: number, contents: string): { readonly file: string; readonly release: () => void } {
  const directory = path.join(superviseDirOf(paths, pool), "settings");
  const file = path.join(directory, `${sessionId}.${String(pid)}.json`);
  fs.mkdirPrivate(directory);
  fs.writeFilePrivate(file, `${contents}\n`);
  return { file, release: () => { fs.removeRecursive(file); } };
}

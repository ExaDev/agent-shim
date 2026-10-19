import type { STATUSLINE_PATH_LEVELS } from "../config/statusline";
import type { ClientPayload } from "./payload";
import { sanitiseDisplayText } from "./sanitise";

const SEPARATORS = /[/\\]/;
const SEPARATOR_AT_START = /^[/\\]/;
const UNC_PREFIX = /^[/\\]{2}/;
const DRIVE_PREFIX = /^[A-Za-z]:[/\\]/;

/** The most added directories the statusline names: each costs width, and a session with more than this many has more than a line can say, so the rest are counted. */
export const MAX_ADDED_DIRS_SHOWN = 5;

/** The longest an added directory's name is drawn, in UTF-16 code units; a longer name ends in an ellipsis. A name of mostly astral characters may draw a little wider, which a statusline tolerates. */
export const MAX_ADDED_DIR_NAME_CHARS = 24;

/** A working directory as the statusline names the project: its last `levels` directories, or all of it for `full`. Windows drive and UNC paths are normalised to forward slashes, because the client sends whichever form the host uses. The path is untrusted text, so it is sanitised first. */
export function formatProjectPath(cwd: string, levels: (typeof STATUSLINE_PATH_LEVELS)[number]): string {
  const safe = sanitiseDisplayText(cwd);
  const segments = safe.split(SEPARATORS).filter((segment) => segment !== "");
  if (levels !== "full") {
    const shown = segments.slice(-Number(levels)).join("/");
    return shown !== "" ? shown : SEPARATOR_AT_START.test(safe) ? "/" : safe;
  }
  if (UNC_PREFIX.test(safe)) {
    return segments.length > 0 ? `//${segments.join("/")}` : "//";
  }
  if (DRIVE_PREFIX.test(safe)) {
    const joined = segments.join("/");
    return segments.length === 1 ? `${joined}/` : joined;
  }
  if (SEPARATOR_AT_START.test(safe)) {
    return segments.length > 0 ? `/${segments.join("/")}` : "/";
  }
  return segments.join("/") || safe;
}

/** The last component of a directory path, as the client wrote it. */
function basenameOf(dir: string): string {
  const segments = dir.split(SEPARATORS).filter((segment) => segment !== "");
  return segments.at(-1) ?? dir;
}

/** The directories added to the session, as the names to draw: the safe basename of each, truncated, for the first `MAX_ADDED_DIRS_SHOWN`, and how many more there are. A directory whose name is empty once sanitised is dropped, as it would draw nothing. */
export function addedDirNames(dirs: readonly string[] | undefined): { readonly names: readonly string[]; readonly more: number } {
  const all = (dirs ?? []).map((dir) => sanitiseDisplayText(basenameOf(dir))).filter((name) => name !== "");
  const names = all.slice(0, MAX_ADDED_DIRS_SHOWN).map((name) => (name.length <= MAX_ADDED_DIR_NAME_CHARS ? name : `${name.slice(0, MAX_ADDED_DIR_NAME_CHARS - 1)}…`));
  return { names, more: all.length - names.length };
}

/** The directory the session is working in: the client's `cwd`, else its workspace's `current_dir`, which older clients leave out. Undefined when the client names neither. */
export function workingDirectoryOf(payload: ClientPayload): string | undefined {
  const cwd = payload.cwd ?? payload.workspace?.current_dir;
  return cwd === undefined || cwd === "" ? undefined : cwd;
}

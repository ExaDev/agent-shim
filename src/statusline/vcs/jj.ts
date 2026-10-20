import path from "node:path";

import type { StatuslinePorts } from "../ports";
import { sanitiseDisplayText } from "../sanitise";
import type { VcsStatus } from "./types";

const JJ = "jj";
/** The most directories walked upwards looking for a repository: a real tree is far shallower, and the bound ends a walk through a cyclic or pathological link. */
const MAX_WALK_DEPTH = 64;
/** The most characters of a bookmark or change id drawn, counted in code points so that a cut never leaves half a surrogate pair. */
export const MAX_LABEL_CODE_POINTS = 64;
const FIELD_SEPARATOR = "\u001f";
const BOOKMARK_SEPARATOR = "\u001e";
const FIELD_COUNT = 4;

/** Whether `cwd` is inside a Jujutsu repository: a real `.jj` directory in it or an ancestor, found without running a program, so a person who has enabled jj but works in a git repository pays no process for it. A `.jj` that is a symbolic link is not followed, since a directory a contributor controls could point it anywhere, and a `.git` entry ends the walk, so that a git repository nested in a Jujutsu one is not read as the outer one. */
export function isJjRepository(ports: StatuslinePorts, cwd: string): boolean {
  let directory = ports.realPath(cwd);
  if (directory === undefined || ports.entryKind(directory) !== "directory") {
    return false;
  }
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (ports.entryKind(path.join(directory, ".jj")) === "directory") {
      return true;
    }
    if (ports.entryKind(path.join(directory, ".git")) !== undefined) {
      return false;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
  return false;
}

/** One call that reads the working-copy commit's change id, its local bookmarks, whether it differs from its parent and whether it conflicts, as four unit-separated fields. */
const TEMPLATE = [
  "change_id.shortest(8)",
  '"\\x1f"',
  'self.local_bookmarks().map(|bookmark| bookmark.name()).join("\\x1e")',
  '"\\x1f"',
  'if(self.empty(), "0", "1")',
  '"\\x1f"',
  'if(self.conflict(), "1", "0")',
].join(" ++ ");

/** Read-only and prompt-safe: no pager, the working copy is not snapshotted, and the operation is read as it stands rather than reconciled, so a refresh never changes the repository. The dirty marker is therefore as of jj's last snapshot. */
const ARGS = ["--ignore-working-copy", "--at-operation=@", "--no-pager", "log", "-r", "@", "--no-graph", "--color", "never", "-T", TEMPLATE];

function label(text: string): string | undefined {
  const clean = sanitiseDisplayText(text).trim();
  return clean === "" ? undefined : Array.from(clean).slice(0, MAX_LABEL_CODE_POINTS).join("");
}

function parse(output: string): VcsStatus | undefined {
  const line = output.replace(/\r?\n$/, "");
  if (line.includes("\n") || line.includes("\r")) {
    return undefined;
  }
  const fields = line.split(FIELD_SEPARATOR);
  if (fields.length !== FIELD_COUNT) {
    return undefined;
  }
  const [changeId, bookmarksText, dirtyFlag, conflictFlag] = fields;
  if (changeId === undefined || bookmarksText === undefined || (dirtyFlag !== "0" && dirtyFlag !== "1") || (conflictFlag !== "0" && conflictFlag !== "1")) {
    return undefined;
  }
  const bookmarks = bookmarksText === "" ? [] : bookmarksText.split(BOOKMARK_SEPARATOR);
  if (bookmarks.some((bookmark) => bookmark === "")) {
    return undefined;
  }
  const branch = label(bookmarks[0] ?? changeId);
  return branch === undefined ? undefined : { kind: "jj", branch, detached: false, dirty: dirtyFlag === "1", conflict: conflictFlag === "1", ahead: 0, behind: 0, lineDiff: undefined, files: undefined };
}

/** The status of the Jujutsu repository `cwd` is in, from one `jj log` call, or undefined when jj is missing, `cwd` is not in a repository, or the output is not the shape the template makes (an incompatible jj). */
export function readJjStatus(ports: StatuslinePorts, cwd: string): VcsStatus | undefined {
  const directory = ports.realPath(cwd);
  if (directory === undefined) {
    return undefined;
  }
  const output = ports.run(JJ, ARGS, directory);
  return output === undefined ? undefined : parse(output);
}

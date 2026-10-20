import type { StatuslinePorts } from "../ports";
import { sanitiseDisplayText } from "../sanitise";
import type { ChangedFile, GitQuery, LineDiff, VcsStatus } from "./types";

const GIT = "git";
/** `git status --porcelain=v2` and `diff --numstat` separate fields with a space or a tab and end each record with NUL under `-z`, so that a path is never quoted. */
const NUL = "\0";
const BRANCH_AHEAD_BEHIND = /^# branch\.ab \+(\d+) -(\d+)$/;
/** The branch name `git rev-parse --abbrev-ref` and `status --branch` print for a detached HEAD. */
const DETACHED_ABBREV = "HEAD";
const DETACHED_HEAD = "(detached)";
/** The object name `status --branch` prints before the first commit. */
const NO_COMMIT_YET = "(initial)";
/** The leading fields of a `status --porcelain=v2` entry before its path: an ordinary entry (`1`) has eight, a rename or copy (`2`) nine, and an unmerged one (`u`) ten. */
const ORDINARY_LEADING_FIELDS = 8;
const RENAMED_LEADING_FIELDS = 9;
const UNMERGED_LEADING_FIELDS = 10;

/** How `status` classifies an entry's two-letter code for the `gitFiles` row: the same readings of the index and work-tree columns as claude-hud's, with anything else (a type change, an unmerged path) counted as dirty only. */
function kindOfCode(code: string): ChangedFile["kind"] | undefined {
  const index = code.charAt(0);
  const workTree = code.charAt(1);
  if (index === "A") {
    return "added";
  }
  if (index === "D" || workTree === "D") {
    return "deleted";
  }
  if (index === "M" || workTree === "M" || index === "R" || index === "C") {
    return "modified";
  }
  return undefined;
}

interface ParsedStatus {
  readonly head: string | undefined;
  readonly noCommitYet: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
  readonly tracked: readonly { readonly path: string; readonly kind: ChangedFile["kind"] }[];
  readonly untracked: number;
}

/** Reads the output of `git status --porcelain=v2 --branch -z`. */
function parseStatus(output: string): ParsedStatus {
  const fields = output.split(NUL);
  let head: string | undefined;
  let noCommitYet = false;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  let untracked = 0;
  const tracked: { path: string; kind: ChangedFile["kind"] }[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field === "") {
      continue;
    }
    if (field.startsWith("# branch.head ")) {
      head = field.slice("# branch.head ".length);
    } else if (field.startsWith("# branch.oid ")) {
      noCommitYet = field.slice("# branch.oid ".length) === NO_COMMIT_YET;
    } else if (field.startsWith("# branch.ab ")) {
      const counts = BRANCH_AHEAD_BEHIND.exec(field);
      ahead = Number(counts?.[1] ?? 0);
      behind = Number(counts?.[2] ?? 0);
    } else if (!field.startsWith("# ")) {
      dirty = true;
      const parts = field.split(" ");
      const code = parts[1] ?? "";
      if (field.startsWith("? ")) {
        untracked += 1;
      } else if (field.startsWith("1 ") || field.startsWith("2 ") || field.startsWith("u ")) {
        const leading = field.startsWith("1 ") ? ORDINARY_LEADING_FIELDS : field.startsWith("2 ") ? RENAMED_LEADING_FIELDS : UNMERGED_LEADING_FIELDS;
        const kind = kindOfCode(code);
        if (kind !== undefined) {
          tracked.push({ path: parts.slice(leading).join(" "), kind });
        }
        // A rename or copy is followed by its source path as a field of its own.
        if (field.startsWith("2 ")) {
          index += 1;
        }
      }
    }
  }
  return { head, noCommitYet, ahead, behind, dirty, tracked, untracked };
}

/** Reads the output of `git diff --numstat -z HEAD` into the total and each file's lines, keyed by the file's current path. A binary file has no line counts and is left out, as claude-hud does. */
function parseNumstat(output: string): { readonly total: LineDiff; readonly byPath: ReadonlyMap<string, LineDiff> } {
  const fields = output.split(NUL);
  const byPath = new Map<string, LineDiff>();
  let added = 0;
  let deleted = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const [addedText, deletedText, pathText] = (fields[index] ?? "").split("\t");
    if (addedText === undefined || deletedText === undefined || pathText === undefined) {
      continue;
    }
    // A rename is `added<TAB>deleted<TAB>` then the source and the destination as two more fields.
    const path = pathText === "" ? fields[index + 2] : pathText;
    if (pathText === "") {
      index += 2;
    }
    const lines = { added: Number(addedText), deleted: Number(deletedText) };
    if (path !== undefined && Number.isInteger(lines.added) && Number.isInteger(lines.deleted)) {
      added += lines.added;
      deleted += lines.deleted;
      byPath.set(path, lines);
    }
  }
  return { total: { added, deleted }, byPath };
}

/** What a detached HEAD is called: the tag that points at it exactly, else its abbreviated commit, marked as one so the segment can say it in words. */
function detachedName(ports: StatuslinePorts, cwd: string): { readonly name: string; readonly detached: boolean } | undefined {
  const tag = ports.run(GIT, ["describe", "--tags", "--exact-match", "HEAD"], cwd)?.trim();
  if (tag !== undefined && tag !== "") {
    return { name: tag, detached: false };
  }
  const commit = ports.run(GIT, ["rev-parse", "--short", "HEAD"], cwd)?.trim();
  return commit === undefined || commit === "" ? undefined : { name: commit, detached: true };
}

/** Changed files with the most recently modified first. The paths git prints are relative to the repository root, not to the working directory, so the root is asked for once; a file whose time cannot be read sorts last. */
function byRecency(ports: StatuslinePorts, cwd: string, files: ParsedStatus["tracked"]): readonly { readonly path: string; readonly kind: ChangedFile["kind"] }[] {
  const root = ports.run(GIT, ["rev-parse", "--show-toplevel"], cwd)?.trim();
  if (root === undefined || root === "") {
    return files;
  }
  const modified = new Map(files.map((file) => [file.path, ports.modifiedAtMs(`${root}/${file.path}`) ?? 0]));
  return [...files].sort((left, right) => (modified.get(right.path) ?? 0) - (modified.get(left.path) ?? 0));
}

/** The status of the git repository `cwd` is in, running the fewest git commands `query` allows: one for the branch alone; one for the branch, ahead and behind counts, dirtiness and changed files together; and one more for the lines changed, only when the tree is dirty. A detached HEAD costs up to two more to name it. Undefined when `cwd` is not in a repository, or the repository has no commit yet, or git fails or outruns the port's time. */
export function readGitStatus(ports: StatuslinePorts, cwd: string, query: Readonly<GitQuery>): VcsStatus | undefined {
  if (!query.workingTree) {
    const abbreviated = ports.run(GIT, ["rev-parse", "--abbrev-ref", "HEAD"], cwd)?.trim();
    const head = abbreviated === DETACHED_ABBREV ? detachedName(ports, cwd) : { name: abbreviated, detached: false };
    return head?.name === undefined || head.name === "" ? undefined : { kind: "git", branch: sanitiseDisplayText(head.name), detached: head.detached, dirty: false, conflict: false, ahead: 0, behind: 0, lineDiff: undefined, files: undefined };
  }
  const output = ports.run(GIT, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"], cwd);
  if (output === undefined) {
    return undefined;
  }
  const status = parseStatus(output);
  const head = status.head === DETACHED_HEAD ? detachedName(ports, cwd) : { name: status.head, detached: false };
  if (status.noCommitYet || head?.name === undefined || head.name === "") {
    return undefined;
  }
  const numstat = query.lineDiff && status.dirty ? ports.run(GIT, ["--no-optional-locks", "diff", "--numstat", "-z", "HEAD"], cwd) : undefined;
  const lines = numstat === undefined ? undefined : parseNumstat(numstat);
  const tracked = query.files && status.tracked.length > 0 ? byRecency(ports, cwd, status.tracked) : status.tracked;
  return {
    kind: "git",
    branch: sanitiseDisplayText(head.name),
    detached: head.detached,
    dirty: status.dirty,
    conflict: false,
    ahead: status.ahead,
    behind: status.behind,
    lineDiff: lines?.total,
    files: query.files
      ? {
          tracked: tracked.map((file) => ({ basename: sanitiseDisplayText(file.path.split("/").at(-1) ?? file.path), kind: file.kind, lines: lines?.byPath.get(file.path) })),
          untracked: status.untracked,
        }
      : undefined,
  };
}

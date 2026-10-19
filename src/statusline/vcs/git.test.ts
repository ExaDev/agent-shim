import { describe, expect, it } from "vitest";

import { ESCAPE } from "../ansi";
import type { StatuslinePorts } from "../ports";
import { fakeStatuslinePorts } from "../testing";
import { readGitStatus } from "./git";
import type { GitQuery } from "./types";

const CWD = "/repo/sub";
const ROOT = "/repo";
const NUL = "\0";
const BRANCH_ONLY: GitQuery = { workingTree: false, files: false, lineDiff: false };
const TREE: GitQuery = { workingTree: true, files: false, lineDiff: false };
const FILES: GitQuery = { workingTree: true, files: true, lineDiff: true };

/** Ports whose `run` answers the git argument lists in `answers` (matched on the arguments after any `--no-optional-locks`) and records every call. */
function gitPorts(answers: Readonly<Record<string, string>>, overrides: Partial<StatuslinePorts> = {}): { readonly ports: StatuslinePorts; readonly calls: string[] } {
  const calls: string[] = [];
  const ports = fakeStatuslinePorts({
    run: (file, args, cwd) => {
      expect(file).toBe("git");
      expect(cwd).toBe(CWD);
      const key = args.filter((arg) => arg !== "--no-optional-locks").join(" ");
      calls.push(key);
      return answers[key];
    },
    ...overrides,
  });
  return { ports, calls };
}

const STATUS_KEY = "status --porcelain=v2 --branch -z";
const NUMSTAT_KEY = "diff --numstat -z HEAD";

function status(headers: readonly string[], entries: readonly string[] = []): string {
  return [...headers, ...entries].map((field) => `${field}${NUL}`).join("");
}
const HEADERS = ["# branch.oid 0123456789abcdef", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1"];
const entry = (code: string, path: string): string => `1 ${code} N... 100644 100644 100644 aaaa bbbb ${path}`;

describe("readGitStatus branch only", () => {
  it("runs one command for a branch", () => {
    const { ports, calls } = gitPorts({ "rev-parse --abbrev-ref HEAD": "feat/x\n" });
    expect(readGitStatus(ports, CWD, BRANCH_ONLY)).toEqual({ kind: "git", branch: "feat/x", dirty: false, conflict: false, ahead: 0, behind: 0, lineDiff: undefined, files: undefined });
    expect(calls).toEqual(["rev-parse --abbrev-ref HEAD"]);
  });

  it("is undefined outside a repository, with no commit yet, or when git fails", () => {
    expect(readGitStatus(gitPorts({}).ports, CWD, BRANCH_ONLY)).toBeUndefined();
  });

  it("names a detached head by its exact tag, else by its short commit", () => {
    expect(readGitStatus(gitPorts({ "rev-parse --abbrev-ref HEAD": "HEAD\n", "describe --tags --exact-match HEAD": "v1.2.3\n" }).ports, CWD, BRANCH_ONLY)?.branch).toBe("v1.2.3");
    expect(readGitStatus(gitPorts({ "rev-parse --abbrev-ref HEAD": "HEAD\n", "rev-parse --short HEAD": "abc1234\n" }).ports, CWD, BRANCH_ONLY)?.branch).toBe("detached:abc1234");
    expect(readGitStatus(gitPorts({ "rev-parse --abbrev-ref HEAD": "HEAD\n" }).ports, CWD, BRANCH_ONLY)).toBeUndefined();
  });

  it("removes escape sequences a branch name carries", () => {
    expect(readGitStatus(gitPorts({ "rev-parse --abbrev-ref HEAD": `a${ESCAPE}[31mb\n` }).ports, CWD, BRANCH_ONLY)?.branch).toBe("ab");
  });
});

describe("readGitStatus working tree", () => {
  it("reads the branch, ahead and behind counts and dirtiness from one command", () => {
    const { ports, calls } = gitPorts({ [STATUS_KEY]: status(HEADERS, [entry(".M", "a.ts")]) });
    expect(readGitStatus(ports, CWD, TREE)).toMatchObject({ branch: "main", dirty: true, ahead: 2, behind: 1, lineDiff: undefined, files: undefined });
    expect(calls).toEqual([STATUS_KEY]);
  });

  it("reads a clean tree with no upstream as clean and level", () => {
    const { ports } = gitPorts({ [STATUS_KEY]: status(["# branch.oid 0123", "# branch.head main"]) });
    expect(readGitStatus(ports, CWD, TREE)).toMatchObject({ dirty: false, ahead: 0, behind: 0 });
  });

  it("counts an untracked file as dirt", () => {
    const { ports } = gitPorts({ [STATUS_KEY]: status(HEADERS, ["? new.txt"]) });
    expect(readGitStatus(ports, CWD, TREE)?.dirty).toBe(true);
  });

  it("is undefined before the first commit and when git fails", () => {
    expect(readGitStatus(gitPorts({ [STATUS_KEY]: status(["# branch.oid (initial)", "# branch.head main"]) }).ports, CWD, TREE)).toBeUndefined();
    expect(readGitStatus(gitPorts({}).ports, CWD, TREE)).toBeUndefined();
  });

  it("names a detached head", () => {
    const detached = status(["# branch.oid 0123", "# branch.head (detached)"]);
    expect(readGitStatus(gitPorts({ [STATUS_KEY]: detached, "rev-parse --short HEAD": "0123abc\n" }).ports, CWD, TREE)?.branch).toBe("detached:0123abc");
  });

  it("does not count lines unless asked, and not for a clean tree", () => {
    const { ports, calls } = gitPorts({ [STATUS_KEY]: status(HEADERS, [entry(".M", "a.ts")]) });
    readGitStatus(ports, CWD, TREE);
    expect(calls).not.toContain(NUMSTAT_KEY);
    const clean = gitPorts({ [STATUS_KEY]: status(HEADERS) });
    readGitStatus(clean.ports, CWD, { workingTree: true, files: false, lineDiff: true });
    expect(clean.calls).toEqual([STATUS_KEY]);
  });
});

describe("readGitStatus changed files and lines", () => {
  const entries = [entry("M.", "src/a.ts"), entry("A.", "src/b.ts"), entry(".D", "gone.ts"), entry("T.", "typechange"), `2 R. N... 100644 100644 100644 aaaa bbbb R100 renamed new.ts${NUL}old.ts`, "? loose.txt", "? loose2.txt"];
  const numstat = `3\t1\tsrc/a.ts${NUL}10\t0\tsrc/b.ts${NUL}0\t7\tgone.ts${NUL}-\t-\tbinary.png${NUL}2\t2\t${NUL}old.ts${NUL}renamed new.ts${NUL}`;

  it("classifies tracked files, counts untracked ones, and totals the lines, leaving out a binary file", () => {
    const { ports } = gitPorts({ [STATUS_KEY]: status(HEADERS, entries), [NUMSTAT_KEY]: numstat, "rev-parse --show-toplevel": `${ROOT}\n` });
    const result = readGitStatus(ports, CWD, FILES);
    expect(result?.lineDiff).toEqual({ added: 15, deleted: 10 });
    expect(result?.files?.untracked).toBe(2);
    const byName = Object.fromEntries((result?.files?.tracked ?? []).map((file) => [file.basename, file]));
    expect(Object.keys(byName).sort()).toEqual(["a.ts", "b.ts", "gone.ts", "renamed new.ts"]);
    expect(byName["a.ts"]).toMatchObject({ kind: "modified", lines: { added: 3, deleted: 1 } });
    expect(byName["b.ts"]).toMatchObject({ kind: "added", lines: { added: 10, deleted: 0 } });
    expect(byName["gone.ts"]).toMatchObject({ kind: "deleted", lines: { added: 0, deleted: 7 } });
    expect(byName["renamed new.ts"]).toMatchObject({ kind: "modified", lines: { added: 2, deleted: 2 } });
  });

  it("orders the files most recently modified first, reading times from the repository root because paths are relative to it", () => {
    const modified: Readonly<Record<string, number>> = { [`${ROOT}/src/a.ts`]: 100, [`${ROOT}/src/b.ts`]: 300, [`${ROOT}/gone.ts`]: 200 };
    const { ports } = gitPorts({ [STATUS_KEY]: status(HEADERS, [entry("M.", "src/a.ts"), entry("A.", "src/b.ts"), entry(".D", "gone.ts")]), "rev-parse --show-toplevel": `${ROOT}\n` }, { modifiedAtMs: (file) => modified[file] });
    expect(readGitStatus(ports, CWD, { workingTree: true, files: true, lineDiff: false })?.files?.tracked.map((file) => file.basename)).toEqual(["b.ts", "gone.ts", "a.ts"]);
  });

  it("keeps git's order when the root cannot be found", () => {
    const { ports } = gitPorts({ [STATUS_KEY]: status(HEADERS, [entry("M.", "a.ts"), entry("A.", "b.ts")]) }, { modifiedAtMs: () => 1 });
    expect(readGitStatus(ports, CWD, { workingTree: true, files: true, lineDiff: false })?.files?.tracked.map((file) => file.basename)).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps a path that has spaces whole", () => {
    const { ports } = gitPorts({ [STATUS_KEY]: status(HEADERS, [entry("M.", "my dir/my file.ts")]) });
    expect(readGitStatus(ports, CWD, { workingTree: true, files: true, lineDiff: false })?.files?.tracked[0]?.basename).toBe("my file.ts");
  });

  it("reports no files when none were asked for", () => {
    const { ports } = gitPorts({ [STATUS_KEY]: status(HEADERS, entries) });
    expect(readGitStatus(ports, CWD, TREE)?.files).toBeUndefined();
  });
});

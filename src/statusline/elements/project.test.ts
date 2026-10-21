import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../../config/statusline";
import { ESCAPE } from "../ansi";
import type { StatuslineSummary } from "../enrich";
import { parseClientPayload } from "../payload";
import type { StatuslinePorts } from "../ports";
import { renderStatuslineBlock } from "../render";
import { fakeStatuslinePorts } from "../testing";

const NOW_MS = Date.parse("2026-10-19T00:00:00.000Z");
const WIDE_TERMINAL = 170;
/** Below the width at which the changed-files line draws. */
const NARROW_TERMINAL = 50;
const NO_COLOUR_ENV = { NO_COLOR: "1" };
const FS = "\u001f";

const SUMMARY: StatuslineSummary = {
  identity: undefined,
  provider: undefined,
  providerAccountEmail: undefined,
  providerAccountSub: undefined,
  providerPlan: undefined,
  loginAccountEmail: undefined,
  loginRateLimitTier: undefined,
  loginOrganizationName: undefined,
  loginOrganizationType: undefined,
  loginSeatTier: undefined,
  loginPlan: undefined,
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
  fiveHourUsed: undefined,
  fiveHourResetAt: undefined,
  sevenDayUsed: undefined,
  sevenDayResetAt: undefined,
};

const VIEW = {
  modelDisplayName: undefined,
  contextUsedPercentage: undefined,
  contextTotalTokens: undefined,
  contextWindowTokens: undefined,
  cacheHitRatio: undefined,
  cacheReadTokens: undefined,
  freshInputTokens: undefined,
};

const NUL = "\0";
const STATUS_ARGS = "status --porcelain=v2 --branch -z";
const ENTRY = (code: string, path: string): string => `1 ${code} N... 100644 100644 100644 aaaa bbbb ${path}`;
const statusOutput = (entries: readonly string[], headers: readonly string[] = ["# branch.oid 0123", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +3 -2"]): string => [...headers, ...entries].map((field) => `${field}${NUL}`).join("");

interface Scripted {
  readonly ports: StatuslinePorts;
  readonly runs: string[];
}

/** Ports whose `run` answers a command line (`git status ...`, `jj ...` as its first argument) and records each, over an optional fake file system. */
function scripted(answers: Readonly<Record<string, string>>, overrides: Partial<StatuslinePorts> = {}): Scripted {
  const runs: string[] = [];
  const ports = fakeStatuslinePorts({
    env: NO_COLOUR_ENV,
    run: (file, args) => {
      const key = file === "git" ? args.filter((arg) => arg !== "--no-optional-locks").join(" ") : file;
      runs.push(`${file} ${key}`);
      return answers[key];
    },
    ...overrides,
  });
  return { ports, runs };
}

function render(settings: StatuslineSettings, payload: unknown, ports: StatuslinePorts, terminalWidth = WIDE_TERMINAL): string {
  return renderStatuslineBlock({ summary: SUMMARY, view: VIEW, payload: parseClientPayload(payload), terminalWidth, nowMs: NOW_MS, settings: resolveStatusline(settings), ports });
}

const squeeze = (text: string): string => text.replace(/\s+/g, " ").trim();
const IN_REPO = { cwd: "/work/agent-shim" };

describe("the project segment", () => {
  const only = (project: StatuslineSettings["project"] = {}): StatuslineSettings => ({ layout: { header: ["project"], rows: [] }, project });

  it("names the last directory of the working directory by default", () => {
    expect(render(only(), IN_REPO, scripted({}).ports)).toBe("agent-shim");
  });

  it("shows as many levels as pathLevels says, or all of the path", () => {
    expect(render(only({ pathLevels: "2" }), IN_REPO, scripted({}).ports)).toBe("work/agent-shim");
    expect(render(only({ pathLevels: "full" }), IN_REPO, scripted({}).ports)).toBe("/work/agent-shim");
  });

  it("reads the directory from the workspace when the client sends no cwd", () => {
    expect(render(only(), { workspace: { current_dir: "/other/place" } }, scripted({}).ports)).toBe("place");
  });

  it("is hidden when the client names no directory", () => {
    expect(render(only(), {}, scripted({}).ports)).toBe("");
  });

  it("draws added directories inline after the path, and counts those beyond the limit", () => {
    const dirs = ["/a/one", "/a/two", "/a/three", "/a/four", "/a/five", "/a/six", "/a/seven"];
    expect(render(only(), { ...IN_REPO, workspace: { added_dirs: dirs } }, scripted({}).ports)).toBe("agent-shim +one +two +three +four +five +2 more");
  });

  it("draws added directories alone when there is no working directory", () => {
    expect(render(only(), { workspace: { added_dirs: ["/a/one"] } }, scripted({}).ports)).toBe("+one");
  });

  it("leaves added directories out of the segment when they are a row", () => {
    expect(render(only({ addedDirsLayout: "row" }), { ...IN_REPO, workspace: { added_dirs: ["/a/one"] } }, scripted({}).ports)).toBe("agent-shim");
  });

  it("paints the path in colours.project and the added directories in colours.label", () => {
    const settings: StatuslineSettings = { ...only(), colours: { project: "red", label: "cyan" } };
    const drawn = render(settings, { ...IN_REPO, workspace: { added_dirs: ["/a/one"] } }, scripted({}, { env: {} }).ports);
    expect(drawn).toContain(`${ESCAPE}[31magent-shim `);
    expect(drawn).toContain(`${ESCAPE}[36m+one${ESCAPE}[0m`);
  });

  it("removes escape sequences the working directory carries", () => {
    expect(render(only(), { cwd: `/w/${ESCAPE}[31mevil` }, scripted({}).ports)).toBe("evil");
  });
});

describe("the addedDirs row", () => {
  const rowSettings = (project: StatuslineSettings["project"]): StatuslineSettings => ({ layout: { header: [], rows: ["addedDirs"] }, project });
  const WITH_DIRS = { workspace: { added_dirs: ["/a/one", "/b/two"] } };

  it("draws the directories on a line of their own, comma-separated, when the layout is row", () => {
    expect(render(rowSettings({ addedDirsLayout: "row" }), WITH_DIRS, scripted({}).ports)).toBe("Added dirs: one, two");
  });

  it("counts the directories beyond the limit", () => {
    const dirs = Array.from({ length: 7 }, (_, index) => `/a/d${String(index)}`);
    expect(render(rowSettings({ addedDirsLayout: "row" }), { workspace: { added_dirs: dirs } }, scripted({}).ports)).toBe("Added dirs: d0, d1, d2, d3, d4, +2 more");
  });

  it("draws nothing when the directories are inline, or none were added", () => {
    expect(render(rowSettings({ addedDirsLayout: "inline" }), WITH_DIRS, scripted({}).ports)).toBe("");
    expect(render(rowSettings({ addedDirsLayout: "row" }), {}, scripted({}).ports)).toBe("");
  });
});

describe("the vcs segment", () => {
  const only = (git: StatuslineSettings["git"] = {}, jj: StatuslineSettings["jj"] = {}): StatuslineSettings => ({ layout: { header: ["vcs"], rows: [] }, git, jj });
  const dirtyRepo = (extra: Readonly<Record<string, string>> = {}): Scripted => scripted({ [STATUS_ARGS]: statusOutput([ENTRY(".M", "a.ts")]), ...extra });

  it("draws the branch and marks a dirty tree with an asterisk", () => {
    expect(render(only(), IN_REPO, dirtyRepo().ports)).toBe("git:(main*)");
  });

  it("draws a clean branch bare, and the dirty marker only when showDirty is on", () => {
    expect(render(only(), IN_REPO, scripted({ [STATUS_ARGS]: statusOutput([]) }).ports)).toBe("git:(main)");
    expect(render(only({ showDirty: false, showAheadBehind: true }), IN_REPO, dirtyRepo().ports)).toBe("git:(main ↑3 ↓2)");
  });

  it("draws the commits ahead and behind only when showAheadBehind is on, and only the non-zero ones", () => {
    expect(render(only({ showAheadBehind: true }), IN_REPO, dirtyRepo().ports)).toBe("git:(main* ↑3 ↓2)");
    const level = scripted({ [STATUS_ARGS]: statusOutput([], ["# branch.oid 0123", "# branch.head main", "# branch.ab +0 -2"]) });
    expect(render(only({ showAheadBehind: true }), IN_REPO, level.ports)).toBe("git:(main ↓2)");
  });

  it("draws the total lines changed when showLineDiff is on", () => {
    const repo = dirtyRepo({ "diff --numstat -z HEAD": `4\t1\ta.ts${NUL}6\t0\tb.ts${NUL}` });
    expect(render(only({ showLineDiff: true }), IN_REPO, repo.ports)).toBe("git:(main* [+10 -1])");
    expect(render(only({ showLineDiff: true }), IN_REPO, dirtyRepo({ "diff --numstat -z HEAD": `0\t2\ta.ts${NUL}` }).ports)).toBe("git:(main* [-2])");
  });

  it("colours the ahead marker by the push thresholds, the critical one first", () => {
    const withColours = (git: StatuslineSettings["git"]): string => render({ ...only({ showAheadBehind: true, ...git }), colours: { warning: "yellow", critical: "red", gitBranch: "cyan" } }, IN_REPO, scripted({ [STATUS_ARGS]: statusOutput([]) }, { env: {} }).ports);
    expect(withColours({})).toContain(`${ESCAPE}[36m↑3`);
    expect(withColours({ pushWarnAt: 3 })).toContain(`${ESCAPE}[33m↑3`);
    expect(withColours({ pushWarnAt: 3, pushCriticalAt: 3 })).toContain(`${ESCAPE}[31m↑3`);
    expect(withColours({ pushWarnAt: 4, pushCriticalAt: 5 })).toContain(`${ESCAPE}[36m↑3`);
  });

  it("paints the wrapper in colours.git and the branch in colours.gitBranch", () => {
    const drawn = render({ ...only(), colours: { git: "magenta", gitBranch: "cyan" } }, IN_REPO, scripted({ [STATUS_ARGS]: statusOutput([]) }, { env: {} }).ports);
    expect(drawn).toContain(`${ESCAPE}[35mgit:(`);
    expect(drawn).toContain(`${ESCAPE}[36mmain${ESCAPE}[0m`);
    expect(drawn).toContain(`${ESCAPE}[35m)${ESCAPE}[0m`);
  });

  it("is hidden outside a repository, with no working directory, and when git is disabled", () => {
    expect(render(only(), IN_REPO, scripted({}).ports)).toBe("");
    expect(render(only(), {}, dirtyRepo().ports)).toBe("");
    expect(render(only({ enabled: false }), IN_REPO, dirtyRepo().ports)).toBe("");
  });

  it("runs one command for the branch alone when nothing else is drawn, and none for a hidden segment", () => {
    const branchOnly = scripted({ "rev-parse --abbrev-ref HEAD": "main\n" });
    expect(render(only({ showDirty: false }), IN_REPO, branchOnly.ports)).toBe("git:(main)");
    expect(branchOnly.runs).toEqual(["git rev-parse --abbrev-ref HEAD"]);
    const hidden = dirtyRepo();
    render({ layout: { header: ["model"], rows: ["context"] } }, IN_REPO, hidden.ports);
    expect(hidden.runs).toEqual([]);
  });

  describe("in a Jujutsu repository", () => {
    const JJ_TREE: Partial<StatuslinePorts> = {
      realPath: (path) => path,
      entryKind: (path) => (path === "/work/agent-shim" || path === "/work/agent-shim/.jj" ? "directory" : undefined),
    };
    const jjOutput = (bookmark: string, dirty: string, conflict: string): string => `wrulwzyw${FS}${bookmark}${FS}${dirty}${FS}${conflict}\n`;

    it("draws jj status instead of git's, never both, once jj is enabled", () => {
      const repo = scripted({ jj: jjOutput("main", "1", "0"), [STATUS_ARGS]: statusOutput([]) }, JJ_TREE);
      expect(render(only({}, { enabled: true }), IN_REPO, repo.ports)).toBe("jj:(main*)");
      expect(repo.runs).toEqual(["jj jj"]);
    });

    it("ignores the jj repository while jj is disabled", () => {
      expect(render(only(), IN_REPO, scripted({ jj: jjOutput("main", "1", "0"), [STATUS_ARGS]: statusOutput([]) }, JJ_TREE).ports)).toBe("git:(main)");
    });

    it("draws !conflict when showConflicts is on, and the dirty marker when showDirty is", () => {
      const repo = (): StatuslinePorts => scripted({ jj: jjOutput("main", "1", "1") }, JJ_TREE).ports;
      expect(render(only({}, { enabled: true }), IN_REPO, repo())).toBe("jj:(main* !conflict)");
      expect(render(only({}, { enabled: true, showConflicts: false, showDirty: false }), IN_REPO, repo())).toBe("jj:(main)");
    });

    it("keeps git's ahead, behind and line counts out of jj's segment", () => {
      expect(render(only({ showAheadBehind: true, showLineDiff: true }, { enabled: true }), IN_REPO, scripted({ jj: jjOutput("main", "0", "0") }, JJ_TREE).ports)).toBe("jj:(main)");
    });

    it("falls back to git when jj does not answer", () => {
      const repo = scripted({ [STATUS_ARGS]: statusOutput([]) }, JJ_TREE);
      expect(render(only({}, { enabled: true }), IN_REPO, repo.ports)).toBe("git:(main)");
    });

    it("draws nothing when jj does not answer and git is disabled", () => {
      expect(render(only({ enabled: false }, { enabled: true }), IN_REPO, scripted({}, JJ_TREE).ports)).toBe("");
    });

    it("runs no jj outside a jj repository", () => {
      const repo = scripted({ [STATUS_ARGS]: statusOutput([]) });
      render(only({}, { enabled: true }), IN_REPO, repo.ports);
      expect(repo.runs.filter((run) => run.startsWith("jj"))).toEqual([]);
    });
  });
});

describe("the project and vcs segments together", () => {
  const settings = (overflow: "truncate" | "wrap", width: number): { readonly settings: StatuslineSettings; readonly width: number } => ({ settings: { layout: { header: ["project", "vcs"], rows: [] }, git: { branchOverflow: overflow } }, width });
  const repo = (): StatuslinePorts => scripted({ [STATUS_ARGS]: statusOutput([]) }).ports;

  it("joins them into one unit under truncate", () => {
    const { settings: truncate, width } = settings("truncate", WIDE_TERMINAL);
    expect(render(truncate, IN_REPO, repo(), width)).toBe("agent-shim git:(main)");
  });

  it("keeps them as separate segments under wrap", () => {
    const { settings: wrap, width } = settings("wrap", WIDE_TERMINAL);
    expect(squeeze(render(wrap, IN_REPO, repo(), width))).toBe("agent-shim | git:(main)");
  });

  it("lets the line break between them under wrap and not under truncate", () => {
    const narrow = 22;
    const { settings: wrap } = settings("wrap", narrow);
    expect(render(wrap, IN_REPO, repo(), narrow).split("\n")).toEqual(["agent-shim", "git:(main)"]);
    const { settings: truncate } = settings("truncate", narrow);
    expect(render(truncate, IN_REPO, repo(), narrow).split("\n")).toEqual(["agent-shim git:(main)"]);
  });

  it("does not join them unless the vcs segment follows the project segment", () => {
    const reversed: StatuslineSettings = { layout: { header: ["vcs", "project"], rows: [] } };
    expect(squeeze(render(reversed, IN_REPO, repo()))).toBe("git:(main) | agent-shim");
  });

  it("draws the project alone when there is no repository", () => {
    expect(render(settings("truncate", WIDE_TERMINAL).settings, IN_REPO, scripted({}).ports)).toBe("agent-shim");
  });

  it("reads the repository once for the segment and the row together", () => {
    const both = scripted({ [STATUS_ARGS]: statusOutput([ENTRY(".M", "a.ts")]), "diff --numstat -z HEAD": `1\t1\ta.ts${NUL}`, "rev-parse --show-toplevel": "/work/agent-shim\n" });
    render({ layout: { header: ["vcs"], rows: ["gitFiles"] } }, IN_REPO, both.ports);
    expect(both.runs.filter((run) => run.includes("status"))).toHaveLength(1);
  });
});

describe("the gitFiles row", () => {
  const only: StatuslineSettings = { layout: { header: [], rows: ["gitFiles"] } };
  const answers = (entries: readonly string[], numstat = ""): Record<string, string> => ({ [STATUS_ARGS]: statusOutput(entries), "diff --numstat -z HEAD": numstat, "rev-parse --show-toplevel": "/work/agent-shim\n" });

  it("lists the changed files with a mark each, their lines, and the untracked count", () => {
    const repo = scripted(answers([ENTRY(".M", "src/a.ts"), ENTRY("A.", "b.ts"), ENTRY(".D", "c.ts"), "? new.txt", "? other.txt"], `3\t1\tsrc/a.ts${NUL}5\t0\tb.ts${NUL}0\t9\tc.ts${NUL}`));
    expect(render(only, IN_REPO, repo.ports)).toBe("~a.ts(+3 -1)  +b.ts(+5)  -c.ts(-9)  ?2");
  });

  it("draws a file with no counted lines bare, and the most recently modified first", () => {
    const modified: Readonly<Record<string, number>> = { "/work/agent-shim/old.ts": 1, "/work/agent-shim/new.ts": 2 };
    const repo = scripted(answers([ENTRY(".M", "old.ts"), ENTRY(".M", "new.ts")]), { modifiedAtMs: (path) => modified[path] });
    expect(render(only, IN_REPO, repo.ports)).toBe("~new.ts  ~old.ts");
  });

  it("names the first few files and counts the rest", () => {
    const names = Array.from({ length: 8 }, (_, index) => `f${String(index)}.ts`);
    const repo = scripted(answers(names.map((name) => ENTRY(".M", name))));
    expect(render(only, IN_REPO, repo.ports)).toBe("~f0.ts  ~f1.ts  ~f2.ts  ~f3.ts  ~f4.ts  ~f5.ts  +2 more");
  });

  it("draws nothing for a clean tree, outside a repository, in a narrow terminal, with git disabled and in a jj repository", () => {
    expect(render(only, IN_REPO, scripted(answers([])).ports)).toBe("");
    expect(render(only, IN_REPO, scripted({}).ports)).toBe("");
    expect(render(only, IN_REPO, scripted(answers([ENTRY(".M", "a.ts")])).ports, NARROW_TERMINAL)).toBe("");
    expect(render({ ...only, git: { enabled: false } }, IN_REPO, scripted(answers([ENTRY(".M", "a.ts")])).ports)).toBe("");
    const jj: Partial<StatuslinePorts> = { realPath: (path) => path, entryKind: (path) => (path === "/work/agent-shim" || path === "/work/agent-shim/.jj" ? "directory" : undefined) };
    expect(render({ ...only, jj: { enabled: true } }, IN_REPO, scripted({ ...answers([ENTRY(".M", "a.ts")]), jj: `id${FS}${FS}1${FS}0\n` }, jj).ports)).toBe("");
  });

  it("paints added files, modified files, deleted files and line counts by their roles", () => {
    const repo = scripted(answers([ENTRY("A.", "a.ts"), ENTRY(".M", "m.ts"), ENTRY(".D", "d.ts")], `2\t0\ta.ts${NUL}`), { env: {} });
    const drawn = render({ ...only, colours: { context: "green", warning: "yellow", critical: "red" } }, IN_REPO, repo.ports);
    expect(drawn).toContain(`${ESCAPE}[32m+${ESCAPE}[0m${ESCAPE}[32ma.ts${ESCAPE}[0m`);
    expect(drawn).toContain(`${ESCAPE}[33m~${ESCAPE}[0m`);
    expect(drawn).toContain(`${ESCAPE}[31m-${ESCAPE}[0m`);
    expect(drawn).toContain(`${ESCAPE}[32m+2${ESCAPE}[0m`);
  });
});

describe("the default statusline", () => {
  it("draws the project with its added directories inline and its git status after the model, as claude-hud's default draws its project line", () => {
    const repo = scripted({ [STATUS_ARGS]: statusOutput([ENTRY(".M", "a.ts")]) });
    const withDirectory = renderStatuslineBlock({ summary: SUMMARY, view: { ...VIEW, modelDisplayName: "Opus" }, payload: parseClientPayload({ ...IN_REPO, workspace: { added_dirs: ["/a/one"] } }), terminalWidth: WIDE_TERMINAL, nowMs: NOW_MS, ports: repo.ports });
    expect(squeeze(withDirectory)).toBe("Opus | agent-shim +one git:(main*)");
    expect(repo.runs).toEqual([`git ${STATUS_ARGS}`]);
  });

  it("draws neither the project nor the git status when the client names no directory, and reads nothing from the machine", () => {
    const repo = scripted({ [STATUS_ARGS]: statusOutput([ENTRY(".M", "a.ts")]) });
    expect(renderStatuslineBlock({ summary: SUMMARY, view: { ...VIEW, modelDisplayName: "Opus" }, payload: parseClientPayload({}), terminalWidth: WIDE_TERMINAL, nowMs: NOW_MS, ports: repo.ports })).toBe("Opus");
    expect(repo.runs).toEqual([]);
  });
});

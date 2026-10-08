import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLaunchPlan, type LaunchPlan } from "./launcher";
import { LaunchRefusedError, runClaudeLaunch } from "./launchWiring";
import type { SpawnResult } from "./launcher/ports";
import { addIdentity } from "./identityStore";
import { buildLayoutPaths } from "./paths";
import { fakeSpawn } from "./test-helpers";

/** The exit code the stub child ends with, so a returned code can only have come from it. */
const CHILD_EXIT_CODE = 7;
/** The conventional shell offset for a child ended by a signal: 128 plus the signal number. */
const SIGNAL_EXIT_OFFSET = 128;

/** A plan whose callbacks call `record` in the order they run, beside the spawn. */
function recordedPlan(record: (entry: string) => void): LaunchPlan {
  return {
    bin: "/real/claude",
    args: ["--print"],
    env: { A: "1" },
    release: () => {
      record("release");
    },
    markChildStarted: () => {
      record("started");
    },
  };
}

describe("runLaunchPlan", () => {
  it("marks the child started, runs it with the plan's arguments and environment, releases, and returns its exit code", () => {
    const order: string[] = [];
    const spawn = fakeSpawn();
    spawn.spawnSync.mockImplementation((bin, args, options): SpawnResult => {
      order.push(`spawn ${bin} ${args.join(" ")} ${JSON.stringify(options.env)}`);
      return { status: CHILD_EXIT_CODE, signal: null };
    });
    expect(runLaunchPlan(recordedPlan((entry) => {
      order.push(entry);
    }), spawn)).toBe(CHILD_EXIT_CODE);
    expect(order).toEqual(["started", 'spawn /real/claude --print {"A":"1"}', "release"]);
  });

  it("reports a child ended by a signal as 128 plus the signal's number", () => {
    expect(runLaunchPlan(recordedPlan(() => undefined), fakeSpawn({ status: null, signal: "SIGTERM" }))).toBe(SIGNAL_EXIT_OFFSET + os.constants.signals.SIGTERM);
  });

  it("releases and then throws when the child could not be spawned, rather than returning a code", () => {
    const order: string[] = [];
    const failure = new Error("spawn ENOENT");
    expect(() => runLaunchPlan(recordedPlan((entry) => {
      order.push(entry);
    }), fakeSpawn({ status: null, signal: null, error: failure }))).toThrow(failure);
    expect(order).toEqual(["started", "release"]);
  });
});

describe.skipIf(process.platform === "win32")("runClaudeLaunch", () => {
  let root: string;
  let bin: string;
  let claudeHome: string;
  let home: string;

  beforeEach(() => {
    root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-run-"));
    bin = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-bin-"));
    claudeHome = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-claude-"));
    // The launch looks for the real claude in the home directory's installed versions before it searches PATH, so an empty home keeps a real install out of the test.
    home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [root, bin, claudeHome, home]) {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A `claude` on PATH that records the configuration directory and arguments it was started with and exits with `code`. */
  function stubClaude(code: number): string {
    const record = path.join(root, "child-saw");
    nodeFs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n%s\\n' "$CLAUDE_CONFIG_DIR" "$*" > ${JSON.stringify(record)}\nexit ${String(code)}\n`, { mode: 0o755 });
    return record;
  }

  it("runs the real claude as the identity the launch names and returns the child's exit code without exiting the host", () => {
    const paths = buildLayoutPaths(root);
    addIdentity(paths, "work");
    const record = stubClaude(CHILD_EXIT_CODE);
    const code = runClaudeLaunch({ argv: ["@work", "--print", "hello"], cwd: root, env: {}, paths });
    expect(code).toBe(CHILD_EXIT_CODE);
    expect(nodeFs.readFileSync(record, "utf8")).toBe(`${path.join(paths.identitiesDir, "work")}\n--print hello\n`);
  });

  it("refuses a launch for an identity that does not exist before spawning anything", () => {
    const paths = buildLayoutPaths(root);
    const record = stubClaude(0);
    expect(() => runClaudeLaunch({ argv: ["@nobody"], cwd: root, env: {}, paths })).toThrow(LaunchRefusedError);
    expect(nodeFs.existsSync(record)).toBe(false);
  });
});

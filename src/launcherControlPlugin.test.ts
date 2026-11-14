import { describe, expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import type { StagedLaunchControl } from "./supervise/launchControl";
import { UNVERIFIED_MINOR_VERSION, UNVERIFIED_PATCH_VERSION, VERIFIED_VERSION } from "./supervise/verifiedVersionsTestWorld";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";
import { createFakeFarmFs, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

/** The binary discovery finds on `version`. */
function binaryOf(version: string): DiscoveredClaudeBinary {
  return { path: `/home/testuser/.local/share/claude/versions/${version}`, source: "versions-dir", version };
}

/** The binary discovery finds on a verified version. */
const verifiedBinary = binaryOf(VERIFIED_VERSION);

/** The directory the fake stager names, which only the fake can have put in the arguments. */
const STAGED_DIRECTORY = "/staged/agent-shim-control-test";

/** One launch of `@work` prepared with a stager that records each staging and release, or one that throws when `fails` is given. */
function prepared(argv: readonly string[], options: { readonly binary?: DiscoveredClaudeBinary; readonly env?: Record<string, string>; readonly fails?: Error } = {}) {
  const events: string[] = [];
  const log = fakeLog();
  const stageControlPlugin = (): StagedLaunchControl => {
    if (options.fails !== undefined) {
      throw options.fails;
    }
    events.push("staged");
    return {
      args: (args) => [...args, "--plugin-dir", STAGED_DIRECTORY],
      release: () => {
        events.push("released");
      },
    };
  };
  const plan = prepareLaunch({
    paths,
    fs: fakeFs({}),
    proc: fakeProc(options.env ?? {}, ["@work", ...argv]),
    log,
    resolveClaudeBinary: () => options.binary ?? verifiedBinary,
    farm: fakeFarm(createFakeFarmFs({})),
    frontdoor: fakeFrontDoorPort(),
    stageControlPlugin,
  });
  return { plan, events, log };
}

describe("the control plugin in an unsupervised launch", () => {
  it("is staged and passed to an ordinary session launch on a verified version, and removed when the launch is released, with no warning", () => {
    const { plan, events, log } = prepared(["--print", "hello"]);
    expect(plan.args.slice(plan.args.indexOf("--plugin-dir"))).toEqual(["--plugin-dir", STAGED_DIRECTORY]);
    expect(events).toEqual(["staged"]);
    expect(log.warns.join("\n")).not.toContain("has not been verified");
    plan.release();
    expect(events).toEqual(["staged", "released"]);
  });

  it("is staged on a patch release of a verified minor, and the launch warns that the version has not been verified", () => {
    const { plan, events, log } = prepared(["--print", "hello"], { binary: binaryOf(UNVERIFIED_PATCH_VERSION) });
    expect(plan.args.slice(plan.args.indexOf("--plugin-dir"))).toEqual(["--plugin-dir", STAGED_DIRECTORY]);
    expect(events).toEqual(["staged"]);
    expect(log.warns.filter((line) => line.includes(`Claude Code ${UNVERIFIED_PATCH_VERSION} has not been verified`))).toHaveLength(1);
  });

  it("is staged for an interactive launch too", () => {
    const { plan, events } = prepared([]);
    expect(plan.args).toContain(STAGED_DIRECTORY);
    expect(events).toEqual(["staged"]);
  });

  it("is not loaded with --bare, whether typed or in CLAUDE_EXTRA_FLAGS", () => {
    for (const run of [prepared(["--bare", "--print", "hello"]), prepared(["--print", "hello"], { env: { CLAUDE_EXTRA_FLAGS: "--bare" } })]) {
      expect(run.plan.args).toContain("--bare");
      expect(run.plan.args).not.toContain("--plugin-dir");
      expect(run.events).toEqual([]);
    }
  });

  it("is not loaded into a claude subcommand, which starts no session", () => {
    const { plan, events } = prepared(["plugin", "list"]);
    expect(plan.args).toEqual(["plugin", "list"]);
    expect(events).toEqual([]);
  });

  it("is not loaded on a version of a minor no verified version has, or one discovery cannot name", () => {
    for (const binary of [binaryOf(UNVERIFIED_MINOR_VERSION), { path: "/usr/local/bin/claude", source: "path-fallback" } satisfies DiscoveredClaudeBinary]) {
      const run = prepared(["--print", "hello"], { binary });
      expect(run.plan.args).not.toContain("--plugin-dir");
      expect(run.events).toEqual([]);
    }
  });

  it("never stops the launch when it cannot be staged: the session starts without it, and the launch says so", () => {
    const { plan, log } = prepared(["--print", "hello"], { fails: new Error("no space left on device") });
    expect(plan.args).not.toContain("--plugin-dir");
    expect(log.warns.join("\n")).toContain("could not be staged, so this session starts without it");
    expect(log.warns.join("\n")).toContain("no space left on device");
  });
});

import { describe, expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import type { StagedLaunchControl } from "./supervise/launchControl";
import { RC_SESSION_COMMAND_VERIFIED_VERSIONS } from "./supervise/verifiedVersions";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";
import { createFakeFarmFs, discovered, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

/** A version the control plugin was verified on, read from the list so the tests follow it. */
const VERIFIED_VERSION = RC_SESSION_COMMAND_VERIFIED_VERSIONS[0] ?? "";

/** The binary discovery finds on a verified version. */
const verifiedBinary: DiscoveredClaudeBinary = { path: `/home/testuser/.local/share/claude/versions/${VERIFIED_VERSION}`, source: "versions-dir", version: VERIFIED_VERSION };

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
  it("is staged and passed to an ordinary session launch on a verified version, and removed when the launch is released", () => {
    const { plan, events } = prepared(["--print", "hello"]);
    expect(plan.args.slice(plan.args.indexOf("--plugin-dir"))).toEqual(["--plugin-dir", STAGED_DIRECTORY]);
    expect(events).toEqual(["staged"]);
    plan.release();
    expect(events).toEqual(["staged", "released"]);
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

  it("is not loaded on a version it was not verified on, or one discovery cannot name", () => {
    for (const binary of [discovered, { path: "/usr/local/bin/claude", source: "path-fallback" } satisfies DiscoveredClaudeBinary]) {
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

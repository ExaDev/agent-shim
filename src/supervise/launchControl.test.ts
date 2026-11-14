import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { launchControlPluginGate, launchedSessionOfBridge, registerLaunchControl, stageControlPluginFor, stageLaunchControl } from "./launchControl";
import { sessionControlPluginPaths } from "./sessionControlPlugin";
import { createTranscriptFollower, realTranscriptReadPort } from "./transcriptFollower";
import { UNVERIFIED_MINOR_VERSION, UNVERIFIED_PATCH_VERSION, VERIFIED_VERSION } from "./verifiedVersionsTestWorld";

/** The pids the cases treat as running and as gone. */
const LIVE_PID = 4_001;
const GONE_PID = 4_002;
const OTHER_LIVE_PID = 4_003;

const BRIDGE = "cse_00000000-0000-4000-8000-0000000000b1";

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-shim-launch-control-"));
  paths = buildLayoutPaths(path.join(root, "state"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const isLive = (pid: number): boolean => pid === LIVE_PID || pid === OTHER_LIVE_PID;
const runningAmong = async (pids: readonly number[]): Promise<ReadonlySet<number>> => await Promise.resolve(new Set(pids.filter(isLive)));

/** Stages a plugin for launcher `pid` under the case's directory, and, when `bridge` is given, records a transcript whose `bridge-session` row names it, as the plugin would once the session started. */
function launched(pid: number, conversationId: string, bridge?: string) {
  const staged = stageLaunchControl({ fs: realFarmFs, paths, pid, isRunning: isLive, parent: root });
  const directory = staged.args([]).at(-1) ?? "";
  if (bridge !== undefined) {
    const transcript = path.join(root, `${conversationId}.jsonl`);
    writeFileSync(transcript, `${JSON.stringify({ type: "bridge-session", sessionId: conversationId, bridgeSessionId: bridge, lastSequenceNum: 1 })}\n`);
    writeFileSync(sessionControlPluginPaths(directory).session, JSON.stringify({ conversationId, transcriptPath: transcript }));
  }
  return { staged, directory };
}

describe("whether a launch loads the control plugin", () => {
  const ordinary = { args: ["--print", "hello"], version: VERIFIED_VERSION, startsSession: true, supervised: false };

  it("loads it into an unsupervised session on a verified version, with no warning", () => {
    expect(launchControlPluginGate(ordinary)).toEqual({ kind: "verified" });
  });

  it("loads it into an unsupervised session on a patch release of a verified minor, carrying the warning that names the version as unverified", () => {
    const gate = launchControlPluginGate({ ...ordinary, version: UNVERIFIED_PATCH_VERSION });
    expect(gate?.kind).toBe("unverified-patch");
    expect(gate?.kind === "unverified-patch" ? gate.warning : "").toContain(`Claude Code ${UNVERIFIED_PATCH_VERSION} has not been verified`);
  });

  it("loads nothing under --bare before the terminator, into a subcommand, a supervised launch, or a version of an unverified minor or unknown", () => {
    expect(launchControlPluginGate({ ...ordinary, args: ["--bare", "--print", "hello"] })).toBeUndefined();
    expect(launchControlPluginGate({ ...ordinary, startsSession: false })).toBeUndefined();
    expect(launchControlPluginGate({ ...ordinary, supervised: true })).toBeUndefined();
    expect(launchControlPluginGate({ ...ordinary, version: UNVERIFIED_MINOR_VERSION })).toBeUndefined();
    expect(launchControlPluginGate({ ...ordinary, version: undefined })).toBeUndefined();
  });

  it("reads --bare after the terminator as claude's own argument, not the launch's option", () => {
    expect(launchControlPluginGate({ ...ordinary, args: ["--print", "--", "--bare"] })).toEqual({ kind: "verified" });
  });

  it("stages the plugin and warns once on an unverified patch, stages it silently on a verified version, and stages nothing on an unverified minor", () => {
    const stagedFor = (version: string) => {
      const warnings: string[] = [];
      let stages = 0;
      const staged = stageControlPluginFor({ ...ordinary, version }, () => {
        stages += 1;
        return { args: (args) => args, release: () => undefined };
      }, (message) => {
        warnings.push(message);
      });
      return { loaded: staged !== undefined, stages, warnings };
    };
    expect(stagedFor(VERIFIED_VERSION)).toEqual({ loaded: true, stages: 1, warnings: [] });
    const patch = stagedFor(UNVERIFIED_PATCH_VERSION);
    expect(patch).toMatchObject({ loaded: true, stages: 1 });
    expect(patch.warnings).toHaveLength(1);
    expect(patch.warnings[0]).toContain(`Claude Code ${UNVERIFIED_PATCH_VERSION} has not been verified`);
    expect(stagedFor(UNVERIFIED_MINOR_VERSION)).toEqual({ loaded: false, stages: 0, warnings: [] });
  });
});

describe("the launch's control record", () => {
  it("names the plugin's directory and the launcher, passes the directory with --plugin-dir, and removes both on release", () => {
    const { staged, directory } = launched(LIVE_PID, "conversation-1");
    expect(staged.args(["--print", "--", "prompt"])).toEqual(["--print", "--plugin-dir", directory, "--", "prompt"]);
    expect(path.dirname(directory)).toBe(root);
    expect(existsSync(path.join(directory, "hooks", "register.js"))).toBe(true);
    const records = readdirSync(paths.launchControlDir);
    expect(records).toHaveLength(1);
    expect(realFarmFs.readFileUtf8(path.join(paths.launchControlDir, records[0] ?? ""))).toBe(`${JSON.stringify({ pid: LIVE_PID, directory })}\n`);
    staged.release();
    staged.release();
    expect(readdirSync(paths.launchControlDir)).toEqual([]);
    expect(existsSync(directory)).toBe(false);
  });

  it("removes the records of launchers that have gone when a new one is written", () => {
    registerLaunchControl(realFarmFs, paths.launchControlDir, { pid: GONE_PID, directory: "/gone" }, isLive);
    const kept = registerLaunchControl(realFarmFs, paths.launchControlDir, { pid: OTHER_LIVE_PID, directory: "/kept" }, isLive);
    expect(readdirSync(paths.launchControlDir).map((name) => name.split(".")[0])).toEqual([String(OTHER_LIVE_PID)]);
    kept();
  });

  it("removes the staged directory when the record cannot be written", () => {
    writeFileSync(path.join(root, "state"), "a file where the state directory would go");
    expect(() => stageLaunchControl({ fs: realFarmFs, paths, pid: LIVE_PID, isRunning: isLive, parent: root })).toThrow();
    expect(readdirSync(root).filter((name) => name.startsWith("agent-shim-control-"))).toEqual([]);
  });
});

describe("the door's lookup of a launched session", () => {
  it("finds the live launch whose plugin-recorded transcript names the Remote Control session, with the conversation the plugin recorded", async () => {
    const { directory } = launched(LIVE_PID, "conversation-1", BRIDGE);
    launched(OTHER_LIVE_PID, "conversation-2", "cse_other");
    const lookup = await launchedSessionOfBridge(realFarmFs, paths, BRIDGE, runningAmong, createTranscriptFollower(realTranscriptReadPort));
    expect(lookup).toEqual({ kind: "found", session: { control: { pid: LIVE_PID, directory }, conversation: { conversationId: "conversation-1", transcriptPath: path.join(root, "conversation-1.jsonl") } } });
  });

  it("finds none for a launch whose plugin has recorded no transcript yet, and removes the records of launchers that have gone", async () => {
    launched(LIVE_PID, "conversation-1");
    registerLaunchControl(realFarmFs, paths.launchControlDir, { pid: GONE_PID, directory: "/gone" }, () => true);
    expect(readdirSync(paths.launchControlDir)).toHaveLength(2);
    expect(await launchedSessionOfBridge(realFarmFs, paths, BRIDGE, runningAmong, createTranscriptFollower(realTranscriptReadPort))).toEqual({ kind: "none" });
    expect(readdirSync(paths.launchControlDir).map((name) => name.split(".")[0])).toEqual([String(LIVE_PID)]);
  });

  it("refuses to guess when two live launches claim the same Remote Control session", async () => {
    launched(LIVE_PID, "conversation-b", BRIDGE);
    launched(OTHER_LIVE_PID, "conversation-a", BRIDGE);
    expect(await launchedSessionOfBridge(realFarmFs, paths, BRIDGE, runningAmong, createTranscriptFollower(realTranscriptReadPort))).toEqual({ kind: "ambiguous", conversationIds: ["conversation-a", "conversation-b"] });
  });

  it("finds none when no launch has recorded anything", async () => {
    expect(await launchedSessionOfBridge(realFarmFs, paths, BRIDGE, runningAmong, createTranscriptFollower(realTranscriptReadPort))).toEqual({ kind: "none" });
  });
});

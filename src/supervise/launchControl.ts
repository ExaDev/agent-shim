import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { LayoutPaths } from "../paths";
import type { RegistryFs } from "./registry";
import { sessionControlConversation, type SessionControlConversation } from "./sessionControl";
import { sessionControlPluginPaths, stageSessionControlPlugin, withSessionControlPlugin } from "./sessionControlPlugin";
import type { TranscriptFollower } from "./transcriptFollower";
import { claudeCodeVersionGate, type ClaudeCodeVersionGate } from "./verifiedVersions";

/**
 * The control plugin in a launch no supervisor runs: the launcher stages the same private plugin a supervised launch loads (`sessionControlPlugin.ts`), passes it with `--plugin-dir`, and records where it listens in `launchControlDir`, one `<launcher-pid>.<id>.json` per launch naming the launcher's pid and the plugin's directory. The front door joins a Remote Control session to that record the way it joins a supervised one: the plugin records the session's transcript (`session.json`), and the transcript's own `bridge-session` row names the `cse_` id. The record and the plugin's directory are removed when the child exits; a launcher killed before that leaves both, which the next record or staging removes once its pid is no longer running, and which the door skips meanwhile.
 */

const LaunchControlSchema = z.strictObject({
  /** The launcher's process id, which tells a live channel from one a killed launcher left. */
  pid: z.number().int().positive(),
  /** The plugin's directory, its request and result files beneath it. */
  directory: z.string().min(1),
});
export type LaunchControl = z.infer<typeof LaunchControlSchema>;

const RECORD_SUFFIX = ".json";

/** The record in file `name`, or undefined when it is not one: another kind of file, unparseable, or of another shape. */
function readRecord(fs: Pick<RegistryFs, "readFileUtf8">, directory: string, name: string): LaunchControl | undefined {
  if (!name.endsWith(RECORD_SUFFIX)) {
    return undefined;
  }
  const raw = fs.readFileUtf8(path.join(directory, name));
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = LaunchControlSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Records that launcher `control.pid` loaded the control plugin at `control.directory`, and returns what removes the record, safe to call more than once. The records of launchers that are no longer running are removed first. */
export function registerLaunchControl(fs: RegistryFs, directory: string, control: Readonly<LaunchControl>, isRunning: (pid: number) => boolean): () => void {
  fs.mkdirPrivate(directory);
  for (const name of fs.readdir(directory)) {
    const record = readRecord(fs, directory, name);
    if (record !== undefined && !isRunning(record.pid)) {
      fs.removeRecursive(path.join(directory, name));
    }
  }
  const file = path.join(directory, `${String(control.pid)}.${randomUUID()}${RECORD_SUFFIX}`);
  fs.writeFilePrivate(file, `${JSON.stringify(LaunchControlSchema.parse(control))}\n`);
  return () => {
    fs.removeRecursive(file);
  };
}

/** What an unsupervised launch is, for the one decision of whether it loads the control plugin. */
export interface LaunchControlCandidate {
  /** The arguments the child receives, extra flags included. */
  readonly args: readonly string[];
  /** The Claude Code version the launch runs, when discovery knows it (a binary found on PATH has none). */
  readonly version: string | undefined;
  /** Whether the arguments start a session, rather than a claude subcommand. */
  readonly startsSession: boolean;
  /** Whether a supervisor runs the launch, which loads its own plugin. */
  readonly supervised: boolean;
}

/**
 * Whether an unsupervised launch loads the control plugin, and the gate's verdict on its version when it does: only one that starts a session on a Claude Code version the gate lets through (`claudeCodeVersionGate`: a verified version, or a patch release of a verified minor), without Claude Code's own `--bare` (its minimal mode, which a launch asking for it must get as it is) among the options before any `--`. Undefined for every other launch, which runs exactly as it would without the plugin. A supervised launch loads its supervisor's plugin instead (`launch.ts`).
 */
export function launchControlPluginGate(candidate: Readonly<LaunchControlCandidate>): Exclude<ClaudeCodeVersionGate, { readonly kind: "refused" }> | undefined {
  const end = candidate.args.indexOf("--");
  const options = end === -1 ? candidate.args : candidate.args.slice(0, end);
  if (candidate.supervised || !candidate.startsSession || options.includes("--bare")) {
    return undefined;
  }
  const gate = claudeCodeVersionGate(candidate.version);
  return gate.kind === "refused" ? undefined : gate;
}

/**
 * Stages the control plugin for a launch that loads one (`launchControlPluginGate`), through `stage`; undefined when the launch loads none, or when staging fails, which `warn` is told of: the plugin is an addition the session can do without, so a launch whose plugin cannot be staged starts as it would have without it. A plugin staged on an unverified patch release tells `warn` the gate's warning.
 */
export function stageControlPluginFor(candidate: Readonly<LaunchControlCandidate>, stage: (() => StagedLaunchControl) | undefined, warn: (message: string) => void): StagedLaunchControl | undefined {
  const gate = launchControlPluginGate(candidate);
  if (stage === undefined || gate === undefined) {
    return undefined;
  }
  try {
    const staged = stage();
    if (gate.kind === "unverified-patch") {
      warn(`agent-shim: ${gate.warning}`);
    }
    return staged;
  } catch (error) {
    warn(`agent-shim: the in-process control plugin could not be staged, so this session starts without it and the front door cannot reach it for goal, compaction and turn control: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** One staged control plugin as a launch uses it: the arguments that load it, and what removes it and its record. */
export interface StagedLaunchControl {
  readonly args: (args: readonly string[]) => readonly string[];
  readonly release: () => void;
}

/** What staging the control plugin for one launch needs. */
export interface StageLaunchControlParams {
  readonly fs: RegistryFs;
  readonly paths: LayoutPaths;
  /** The launcher's pid, which names the record and the staged directory. */
  readonly pid: number;
  readonly isRunning: (pid: number) => boolean;
  /** The parent directory to stage the plugin in; the system's temporary directory when absent. */
  readonly parent?: string;
}

/** Stages the control plugin for one unsupervised launch and records where it listens; the release removes the record and then the plugin's directory. A failure to record removes the staged directory before it propagates. */
export function stageLaunchControl(params: Readonly<StageLaunchControlParams>): StagedLaunchControl {
  const plugin = stageSessionControlPlugin({ pid: params.pid, isRunning: params.isRunning, ...(params.parent === undefined ? {} : { parent: params.parent }) });
  let unregister: () => void;
  try {
    unregister = registerLaunchControl(params.fs, params.paths.launchControlDir, { pid: params.pid, directory: plugin.directory }, params.isRunning);
  } catch (error) {
    plugin.release();
    throw error;
  }
  return {
    args: (args) => withSessionControlPlugin(args, plugin.directory),
    release: () => {
      unregister();
      plugin.release();
    },
  };
}

/** A live unsupervised launch the door can reach through its control plugin: the record, and the conversation and transcript the plugin recorded. */
interface LaunchedBridgeSession {
  readonly control: LaunchControl;
  readonly conversation: SessionControlConversation;
}

/** Which live unsupervised launch a Remote Control session belongs to: one, none, or more than one, which is refused rather than guessed at. */
export type LaunchedBridgeLookup = { readonly kind: "found"; readonly session: LaunchedBridgeSession } | { readonly kind: "none" } | { readonly kind: "ambiguous"; readonly conversationIds: readonly string[] };

/**
 * The live unsupervised launch a Remote Control session (`cse_` id) belongs to: the one whose plugin-recorded transcript's latest `bridge-session` row names that id, read through `follower` as the supervised join reads it (`registry.ts`). Records whose launcher has gone are removed. A launch whose plugin has recorded no transcript yet is not a candidate.
 */
export async function launchedSessionOfBridge(fs: RegistryFs, paths: LayoutPaths, bridgeSessionId: string, runningAmong: (pids: readonly number[]) => Promise<ReadonlySet<number>>, follower: TranscriptFollower): Promise<LaunchedBridgeLookup> {
  const directory = paths.launchControlDir;
  const listed = fs.readdir(directory).flatMap((name) => {
    const control = readRecord(fs, directory, name);
    return control === undefined ? [] : [{ file: path.join(directory, name), control }];
  });
  const running = await runningAmong(listed.map(({ control }) => control.pid));
  const claims: LaunchedBridgeSession[] = [];
  for (const { file, control } of listed) {
    if (!running.has(control.pid)) {
      fs.removeRecursive(file);
      continue;
    }
    const conversation = sessionControlConversation(sessionControlPluginPaths(control.directory));
    if (conversation === undefined) {
      continue;
    }
    const facts = await follower.factsOf(conversation.transcriptPath);
    if (facts?.bridgeSessionId === bridgeSessionId) {
      claims.push({ control, conversation });
    }
  }
  const [only, ...others] = claims;
  if (only === undefined) {
    return { kind: "none" };
  }
  return others.length === 0 ? { kind: "found", session: only } : { kind: "ambiguous", conversationIds: claims.map((claim) => claim.conversation.conversationId).sort() };
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageError } from "../cliError";
import { resolveOwnBinaryCheck } from "../claudeShim";
import { cosmiconfigReader, type ConfigFileReader } from "../config/load";
import { profileFilePath } from "../config/names";
import { readIdentityById, requireIdentityId } from "../identityStore";
import { withIdentityNamesLock } from "../identityNamesLock";
import { parseLauncherArgv } from "../launcher/argv";
import { loadCascadeInput, readDirectorySelections } from "../launcher/cascade";
import { buildCliOverride } from "../launcher/cliOverride";
import { recoverFarmWarning, resyncFarm } from "../launcher/farm";
import { decideConfigProfile, decideIdentity, readActiveIdentity } from "../launcher/identity";
import type { FarmFs, SupervisedSpawnPort } from "../launcher/ports";
import { childExitCode } from "../launcher/spawn";
import type { LayoutPaths } from "../paths";
import { findExecutableInDir, realContentSourcePath, realFarmFs, realIsProcessRunning, realRunPort, realSleepSync, resolveGitBranch } from "../realPorts";
import { assembleCascade } from "../resolve/walk";
import { realSignalPort, realSupervisedSpawnPort } from "../supervise/realPorts";
import type { SignalPort } from "../supervise/supervise";
import { canonicalCodexHome, codexCredentialGuard } from "./identity";
import { CODEX_CATEGORIES } from "./categories";

/** Only a prefix belongs to the shim: Codex's subcommand, prompt, -p, -c and -- are opaque. */
function parseCodexArgv(argv: readonly string[]): ReturnType<typeof parseLauncherArgv> {
  let end = argv[0]?.startsWith("@") === true ? 1 : 0;
  const valued = ["--identity", "--config-profile", "--category", "--share", "--hide"];
  while (end < argv.length) {
    const token = argv[end] ?? "";
    if (valued.includes(token)) {
      if (argv[end + 1] === undefined) throw new UsageError(`${token} requires a value.`);
      end += 2;
    } else if (valued.some((flag) => token.startsWith(`${flag}=`))) {
      end += 1;
    } else {
      break;
    }
  }
  const parsed = parseLauncherArgv(argv.slice(0, end));
  return { ...parsed, rest: argv.slice(end) };
}

const PRIVATE_DIRECTORY_MODE = 0o700;


/** Reject overrides of the two enforced identity boundaries, without logging any config value. */
function checkConfigArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length && args[i] !== "--"; i += 1) {
    const arg = args[i] ?? "";
    let config: string | undefined;
    if (arg === "-c" || arg === "--config") config = args[++i];
    else if (arg.startsWith("--config=")) config = arg.slice("--config=".length);
    else if (arg.startsWith("-c") && arg.length > 2) config = arg.slice(2).replace(/^=/, "");
    const key = config?.split("=", 1)[0]?.trim().replaceAll('"', "").replaceAll("'", "");
    if (key === "cli_auth_credentials_store" || key === "sqlite_home") {
      throw new UsageError(`Codex identity isolation owns ${key}; remove that -c/--config override.`);
    }
  }
}

/** The machine facts needed to prepare a Codex launch. Tests provide temporary homes and fake process facts. */
export interface CodexLaunchOptions {
  readonly paths: LayoutPaths;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly home: string;
  readonly fs: FarmFs;
  readonly read: ConfigFileReader;
  readonly resolveBinary: () => string;
  readonly now: () => number;
  readonly pid: number;
  readonly isRunning: (pid: number) => boolean;
  readonly sleep: (ms: number) => void;
  readonly uniqueSuffix: string;
  readonly branch?: string;
  readonly branchDetached?: boolean;
  readonly warn: (message: string) => void;
}

/** Resolve and resync a Codex identity, never importing or copying the canonical login. */
export function prepareCodexLaunch(options: CodexLaunchOptions): { bin: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> } {
  const { paths, env } = options;
  const parsed = parseCodexArgv(options.argv);
  checkConfigArgs(parsed.rest);
  const loaded = loadCascadeInput({ paths, cwd: options.cwd, home: options.home, read: options.read });
  const selections = readDirectorySelections(loaded);
  const decision = decideIdentity({
    // CLAUDE_CONFIG_DIR belongs to another CLI and cannot bypass Codex identity selection.
    env: { ...env, CLAUDE_CONFIG_DIR: undefined },
    ...(parsed.identity === undefined ? {} : { argv0Identity: parsed.identity }),
    ...(selections.identity === undefined ? {} : { directoryPinnedIdentity: selections.identity }),
    readActiveIdentityFile: () => readActiveIdentity(options.fs, paths.activeIdentityFile),
  });
  if (decision.pool !== undefined) throw new UsageError("Codex pool selection needs Codex quota ranking; select an individual Codex identity.");
  if (decision.name === undefined) throw new UsageError("No Codex identity selected. Create one with agent-shim identity add <name> --agent codex, then run --agent codex @<name>.");
  const name = decision.name;
  const bin = options.resolveBinary();
  const lock = { pid: options.pid, isRunning: options.isRunning, sleep: options.sleep };
  return withIdentityNamesLock(paths, { fs: options.fs, nowMs: options.now, ...lock }, () => {
    const id = requireIdentityId(paths, name);
    // Refuse a wrong-agent identity before even recovering it with a different file map.
    const beforeRecovery = readIdentityById(paths, id);
    if (beforeRecovery !== undefined && beforeRecovery.agent !== "codex") throw new UsageError(`Identity "${name}" belongs to Claude Code. Create a separate identity with --agent codex.`);
    recoverFarmWarning({ fs: options.fs, identitiesDir: paths.identitiesDir, identity: id, now: options.now, lock, classification: { defaults: CODEX_CATEGORIES } }, options.warn);
    const identity = readIdentityById(paths, id);
    if (identity?.agent !== "codex") throw new UsageError(`Identity "${name}" is not a Codex identity.`);
    if (identity.credential !== undefined || identity.provider !== undefined || identity.anchors !== undefined) {
      throw new UsageError(`Codex identity "${name}" has Claude-only credential, provider or anchor settings. Remove them before launching Codex.`);
    }
    const guard = codexCredentialGuard(env, identity.allowAmbientCredential);
    if (!guard.ok) throw new UsageError(guard.message);
    const profile = decideConfigProfile({ env, cliFlagConfigProfile: parsed.configProfile, directoryRuleConfigProfile: selections.configProfile, identityDefaultConfigProfile: identity.defaultConfigProfile, globalDefaultConfigProfile: loaded.globalConfig?.defaultConfigProfile });
    if (profile.name !== undefined && options.read(profileFilePath(paths.configProfilesDir, profile.name)) === undefined) throw new UsageError(`No configuration profile named "${profile.name}".`);
    const cliOverride = buildCliOverride({ env, categoryFlags: parsed.categoryFlags, shareFlags: parsed.shareFlags, hideFlags: parsed.hideFlags });
    const cascade = loadCascadeInput({ paths, cwd: options.cwd, home: options.home, read: options.read, ...(profile.name === undefined ? {} : { baseConfigProfile: profile.name }), ...(cliOverride === undefined ? {} : { cliOverride }) }).input;
    const errors = assembleCascade(cascade).diagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) throw new UsageError(errors.map((item) => item.message).join("\n"));
    // CODEX_HOME inherited from a parent session is never a sharing source. The explicit shim setting selects the canonical source.
    const canonical = canonicalCodexHome(env, options.home);
    const farmRoot = path.join(paths.identitiesDir, id);
    const relative = path.relative(canonical, farmRoot);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new UsageError("The canonical Codex home cannot contain an identity home.");
    const result = resyncFarm({ ...options, identitiesDir: paths.identitiesDir, identity: id, claudeHome: canonical, cascade, classification: { defaults: CODEX_CATEGORIES }, lock, ...(profile.name === undefined ? {} : { configProfile: profile.name }), identityExists: () => readIdentityById(paths, id)?.agent === "codex" });
    for (const diagnostic of result.diagnostics) options.warn(diagnostic.message);
    return {
      bin,
      args: ["-c", 'cli_auth_credentials_store="file"', "-c", `sqlite_home=${JSON.stringify(result.farmRoot)}`, ...parsed.rest],
      env: { ...env, CODEX_HOME: result.farmRoot, CODEX_SQLITE_HOME: result.farmRoot, AGENT_SHIM_IDENTITY: name },
    };
  });
}

/** Inherit the terminal and forward parent signals while waiting for the child; always remove listeners. */
export async function runCodexChild(plan: ReturnType<typeof prepareCodexLaunch>, spawn: SupervisedSpawnPort, signals: SignalPort): Promise<number> {
  const child = spawn.spawn(plan.bin, plan.args, { stdio: "inherit", env: plan.env });
  const remove = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => signals.on(signal, () => { child.signal(signal); }));
  try {
    const result = await child.exit;
    if (result.error !== undefined) throw result.error;
    return childExitCode(result);
  } finally {
    for (const off of remove) off();
  }
}

/** Real CLI wiring. Construction of buildProgram never calls this function. */
export async function runCodex(paths: LayoutPaths, argv: readonly string[]): Promise<void> {
  const own = resolveOwnBinaryCheck(paths, realContentSourcePath());
  const resolveBinary = (): string => {
    const explicit = process.env.AGENT_SHIM_CODEX_BIN;
    const candidates = explicit === undefined ? (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => findExecutableInDir(dir, "codex")) : [path.resolve(explicit)];
    for (const candidate of candidates) {
      if (candidate !== undefined && !own(candidate)) return candidate;
    }
    throw new UsageError("No real Codex CLI found on PATH. Install Codex or set AGENT_SHIM_CODEX_BIN to its executable.");
  };
  const plan = prepareCodexLaunch({ paths, argv, env: process.env, cwd: fs.realpathSync(process.cwd()), home: os.homedir(), fs: realFarmFs, read: cosmiconfigReader(), resolveBinary, now: Date.now, pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync, uniqueSuffix: `${String(process.pid)}.${randomUUID()}`, warn: (message) => { console.error(`agent-shim: ${message}`); }, ...resolveGitBranch(realRunPort, process.cwd()) });
  fs.chmodSync(plan.env.CODEX_HOME ?? "", PRIVATE_DIRECTORY_MODE);
  process.exitCode = await runCodexChild(plan, realSupervisedSpawnPort, realSignalPort);
}

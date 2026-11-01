import os from "node:os";
import path from "node:path";
import type { z } from "zod";

import { CliError, UsageError } from "./cliError";
import { ConfigValidationError } from "./config/load";
import { ConfigProfileSchema, DirectoryRulesSchema, GlobalConfigSchema, IdentitySchema, type CredentialCacheStore, type CredentialSource } from "./config/schema";
import { nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { listProfiles } from "./configProfilesStore";
import { effectiveStore, type CachedCredential, type CredentialCachePort } from "./credentialCache";
import { renameIdentityInRules } from "./directoryRulesStore";
import { IdentityAlreadyExistsError, IdentityNotFoundError, identityExists, identityFarmEntries, readActiveIdentity, readIdentity, renamedFarmEntry, requireNewIdentityName } from "./identityStore";
import { identityTokenPath } from "./identityToken";
import type { IdentitySessionProbe } from "./identitySessions";
import { renameIdentityInJobs } from "./jobStore";
import { deleteKeychainLogin, copyKeychainLogin, planKeychainLogin, type KeychainLoginPlan } from "./keychainLogin";
import { FARM_MANIFEST_FILENAME, manifestWithIdentity } from "./launcher/farm";
import { acquireIdentityLock, type AcquireIdentityLockParams, type IdentityLock } from "./launcher/lock";
import type { FarmFs, RunPort } from "./launcher/ports";
import { LEGACY_FARM_MANIFEST_FILENAME } from "./legacy";
import { renameAccountModelRefs } from "./modelRefs";
import type { LayoutPaths } from "./paths";
import { renameIdentityInPools } from "./poolStore";
import { stampsWithKeyRenamed } from "./usage/handledStamps";
import { picksWithIdentityRenamed } from "./usage/poolPick";
import { readUsageSnapshot, snapshotPath } from "./usage/read";
import { UsageSnapshotSchema } from "./usage/schema";
import { keychainHasItem } from "./usage/signIn";

/** What `renameIdentity` reaches beyond the configuration files it reads through `LayoutPaths`. Injected so a test renames against a temporary root, a fake Keychain and a fake process table, and the library never imports the real ones. */
export interface IdentityRenamePorts {
  /** Moves directories and files, reads and writes the usage files, and takes the resync locks. */
  readonly fs: FarmFs;
  /** Where the identity's cached credential lives, with the platform that picks the default store. */
  readonly credentialCache: { readonly port: CredentialCachePort; readonly platform: NodeJS.Platform };
  /** Runs `security`. Only used when `platform` is `darwin`. */
  readonly run: RunPort;
  readonly platform: NodeJS.Platform;
  /** Tells whether a session is running against the identity's directory. */
  readonly sessions: IdentitySessionProbe;
  /** What taking a resync lock needs from the machine. */
  readonly lock: Pick<AcquireIdentityLockParams, "nowMs" | "pid" | "isRunning" | "sleep">;
}

/** What `renameIdentity` did, or in a dry run would do, for the command to report. */
export interface IdentityRenameReport {
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
  /** Every directory and file moved and every file and field rewritten, in the order done, one line each. */
  readonly steps: readonly string[];
  /** Things that went wrong after the rename was complete and need a person's attention. */
  readonly warnings: readonly string[];
}

/** Raised when a session is running against the identity's directory: moving the directory under it would leave the session writing to a path that no longer exists, and its Keychain login filed under a service name nothing will look up. */
export class IdentityInUseError extends CliError {
  constructor(
    readonly identity: string,
    readonly directory: string,
    readonly sessions: readonly { readonly pid: number; readonly program: string }[],
  ) {
    super(`Identity "${identity}" is in use: ${sessions.map((session) => `pid ${String(session.pid)} (${session.program})`).join(", ")} ${sessions.length === 1 ? "is" : "are"} running against ${directory}. End ${sessions.length === 1 ? "it" : "them"}, then run the command again.`);
    this.name = "IdentityInUseError";
  }
}

/** Raised when something already stands where the rename would put the identity: a directory or superseded farm of the new name that no `identity.json` makes an identity, or a token file. Nothing is overwritten. */
class RenameTargetTakenError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "RenameTargetTakenError";
  }
}

/** One thing the rename does. `apply` may fail part way, so `undo` must be safe to call after any prefix of `apply`, and after all of it. */
interface Step {
  readonly description: string;
  readonly apply: () => void;
  readonly undo: () => void;
}

/** Something done after every step succeeded. Its failure cannot undo the rename, so it reports a warning instead. */
interface Finisher {
  readonly description: string;
  readonly finish: () => string | undefined;
}

interface Plan {
  readonly steps: readonly Step[];
  readonly finishers: readonly Finisher[];
}

/** `count` and `noun`, pluralised. */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** The name's own checks, which need no state: they run before anything is locked, so a bad name leaves no lock file behind. */
function requireNames(from: string, to: string): void {
  if (from === to) {
    throw new UsageError(`"${from}" is already the identity's name.`);
  }
  requireNewIdentityName(to);
}

/** The checks that read the machine's state. `from` must exist and `to` must be free in every place its name would be filed. */
function requireRenamable(paths: LayoutPaths, from: string, to: string): void {
  if (!identityExists(paths, from)) {
    throw new IdentityNotFoundError(from);
  }
  if (identityExists(paths, to)) {
    throw new IdentityAlreadyExistsError(to);
  }
  const taken = identityFarmEntries(paths, to)[0];
  if (taken !== undefined) {
    throw new RenameTargetTakenError(`"${to}" is already in use: ${path.join(paths.identitiesDir, taken)} exists.`);
  }
}

/** Expands a leading `~/` as the credential resolver does. */
function expandHome(filePath: string): string {
  return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

/**
 * A credential source after the rename. A `file` source that names the identity's stored token file follows the file to its new name, and one that points inside the identity's directory follows the directory; any other path is the person's own and stays where it points. Sources of every other kind name things outside the directory and are untouched.
 */
function repointedSource(source: CredentialSource, fromDir: string, toDir: string, fromToken: string, toToken: string): CredentialSource {
  if (!("file" in source)) {
    return source;
  }
  const file = expandHome(source.file);
  if (file === fromToken) {
    return { file: toToken };
  }
  const inside = file === fromDir || file.startsWith(`${fromDir}${path.sep}`);
  return inside ? { file: `${toDir}${file.slice(fromDir.length)}` } : source;
}

/** The result of rewriting one parsed value: the value, and what changed in it, for the step's description. */
interface Rewrite<T> {
  readonly value: T;
  readonly changes: readonly string[];
}

/** `value` checked against `schema`, so a rewrite that would leave an invalid file fails in the plan (and so in a dry run), before anything is written. */
function validated<S extends z.ZodType>(file: string, schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigValidationError(file, result.error.issues);
  }
  return result.data;
}

/**
 * A step that rewrites one JSON configuration file, or undefined when the file is absent or `rewrite` finds nothing in it to change. It reads and writes through the same store as every other command, so keys this release does not know survive. The rewrite runs again when the step is applied, on what is on disk by then, and the file's exact bytes are kept to put back.
 */
function jsonRewriteStep<S extends z.ZodType>(paths: LayoutPaths, file: string, schema: S, rewrite: (value: z.infer<S>) => Rewrite<z.infer<S>> | undefined): Step | undefined {
  const current: z.infer<S> | undefined = readJson(file, schema);
  const planned = current === undefined ? undefined : rewrite(current);
  if (planned === undefined) {
    return undefined;
  }
  validated(file, schema, planned.value);
  let original: string | undefined;
  return {
    description: `rewrite ${path.relative(paths.root, file)}: ${planned.changes.join(", ")}`,
    apply: () => {
      original = nodeStoreFs.readFileUtf8(file);
      const latest: z.infer<S> | undefined = readJson(file, schema);
      const outcome = latest === undefined ? undefined : rewrite(latest);
      if (outcome !== undefined) {
        writeJsonAtomic(file, validated(file, schema, outcome.value));
      }
    },
    undo: () => {
      if (original !== undefined) {
        writeTextAtomic(file, original);
      }
    },
  };
}

/** How a text file is written back. */
type TextWriter = (file: string, text: string) => void;

/**
 * A step that rewrites one text file through `transform`, which returns the new text and a summary for the description, or undefined when the file holds nothing to change. Like `jsonRewriteStep` it recomputes on what is on disk when applied and keeps the original text to put back.
 */
function textRewriteStep(paths: LayoutPaths, ports: IdentityRenamePorts, file: string, write: TextWriter, transform: (raw: string) => { readonly text: string; readonly summary?: string } | undefined): Step | undefined {
  const raw = ports.fs.readFileUtf8(file);
  const planned = raw === undefined ? undefined : transform(raw);
  if (planned === undefined) {
    return undefined;
  }
  let original: string | undefined;
  return {
    description: `rewrite ${path.relative(paths.root, file)}${planned.summary === undefined ? "" : `: ${planned.summary}`}`,
    apply: () => {
      original = ports.fs.readFileUtf8(file);
      const latest = original === undefined ? undefined : transform(original);
      if (latest !== undefined) {
        write(file, latest.text);
      }
    },
    undo: () => {
      if (original !== undefined) {
        write(file, original);
      }
    },
  };
}

/** A step that moves `source` to `target`, undone by moving it back. `undo` moves only when the move happened, so it is safe after a failed or partial `apply`. */
function moveStep(paths: LayoutPaths, ports: IdentityRenamePorts, source: string, target: string): Step {
  return {
    description: `move ${path.relative(paths.root, source)} to ${path.relative(paths.root, target)}`,
    apply: () => {
      ports.fs.rename(source, target);
    },
    undo: () => {
      if (ports.fs.lstat(target) !== undefined && ports.fs.lstat(source) === undefined) {
        ports.fs.rename(target, source);
      }
    },
  };
}

/** The Keychain steps: copy the macOS login to the service the new directory hashes to now, and delete the old item once everything else has succeeded. */
function keychainPlan(ports: IdentityRenamePorts, fromDir: string, toDir: string): { readonly step: Step; readonly finisher: Finisher } | undefined {
  const login: KeychainLoginPlan | undefined = ports.platform === "darwin" ? planKeychainLogin(ports.run, fromDir, toDir) : undefined;
  if (login === undefined) {
    return undefined;
  }
  return {
    step: {
      description: `copy the Keychain login "${login.fromService}" to "${login.toService}"`,
      apply: () => {
        copyKeychainLogin(ports.run, login);
      },
      undo: () => {
        deleteKeychainLogin(ports.run, login.toService, login.account);
      },
    },
    finisher: {
      description: `delete the former Keychain login "${login.fromService}"`,
      finish: () => {
        const remove = `security delete-generic-password -s "${login.fromService}" -a "${login.account}"`;
        if (!keychainHasItem(ports.run, toDir)) {
          return `The new Keychain login "${login.toService}" could not be found after the rename, so the former one "${login.fromService}" was kept. Look at the new one before deleting the old with \`${remove}\`.`;
        }
        try {
          deleteKeychainLogin(ports.run, login.fromService, login.account);
        } catch (error) {
          return `The former Keychain login "${login.fromService}" could not be deleted (${error instanceof Error ? error.message : String(error)}). It is harmless: delete it with \`${remove}\`.`;
        }
        return undefined;
      },
    },
  };
}

/** The step that moves the cached credential from the old owner to the new, when the identity's credential block turns caching on. Whether an entry exists is only known by reading it, which can prompt for a secret, so the plan names the step and applying it moves nothing when none is stored. */
function credentialCacheStep(ports: IdentityRenamePorts, from: string, to: string, store: CredentialCacheStore): Step {
  const { port } = ports.credentialCache;
  let moved: CachedCredential | undefined;
  return {
    description: `move the cached credential of identity ${from} to identity ${to}, if one is stored`,
    apply: () => {
      moved = port.read(store, `identity ${from}`);
      if (moved !== undefined) {
        port.write(store, `identity ${to}`, moved);
        port.remove(store, `identity ${from}`);
      }
    },
    undo: () => {
      if (moved !== undefined) {
        port.write(store, `identity ${from}`, moved);
        port.remove(store, `identity ${to}`);
      }
    },
  };
}

/** The step that moves identity `from`'s usage snapshot to `to`, with the name inside it, replacing one a removed identity of that name left. */
function snapshotStep(paths: LayoutPaths, ports: IdentityRenamePorts, from: string, to: string): Step | undefined {
  const source = snapshotPath(paths.usageSnapshotsDir, from);
  const target = snapshotPath(paths.usageSnapshotsDir, to);
  const raw = ports.fs.readFileUtf8(source);
  if (raw === undefined) {
    return undefined;
  }
  let originalSource: string | undefined;
  let originalTarget: string | undefined;
  return {
    description: `move ${path.relative(paths.root, source)} to ${path.relative(paths.root, target)}`,
    apply: () => {
      originalSource = ports.fs.readFileUtf8(source);
      originalTarget = ports.fs.readFileUtf8(target);
      const snapshot = readUsageSnapshot(ports.fs, paths.usageSnapshotsDir, from);
      if (snapshot !== undefined) {
        ports.fs.writeFilePrivate(target, `${JSON.stringify(UsageSnapshotSchema.parse({ ...snapshot, identity: to }), null, 2)}\n`);
        ports.fs.removeRecursive(source);
      }
    },
    undo: () => {
      if (originalSource !== undefined) {
        ports.fs.writeFilePrivate(source, originalSource);
        if (originalTarget === undefined) {
          ports.fs.removeRecursive(target);
        } else {
          ports.fs.writeFilePrivate(target, originalTarget);
        }
      }
    },
  };
}

/** Builds the plan: every check that can refuse, then every step in the order it is applied. The order puts what can fail for reasons outside the files first and the Keychain's old item last, and rewrites the identity's own files before the directory moves so each path is read where it is. */
function planRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): Plan {
  requireRenamable(paths, from, to);
  const fromDir = path.join(paths.identitiesDir, from);
  const toDir = path.join(paths.identitiesDir, to);
  const sessions = ports.sessions.sessionsOn(fromDir);
  if (sessions.length > 0) {
    throw new IdentityInUseError(from, fromDir, sessions);
  }
  const fromToken = identityTokenPath(paths, from);
  const toToken = identityTokenPath(paths, to);
  const tokenExists = ports.fs.lstat(fromToken) !== undefined;
  if (tokenExists && ports.fs.lstat(toToken) !== undefined) {
    throw new RenameTargetTakenError(`A token file for "${to}" already exists at ${toToken}, so the one for "${from}" cannot move there.`);
  }
  const identity = readIdentity(paths, from);
  if (identity === undefined) {
    throw new IdentityNotFoundError(from);
  }

  const keychain = keychainPlan(ports, fromDir, toDir);
  const farmFiles = [FARM_MANIFEST_FILENAME, LEGACY_FARM_MANIFEST_FILENAME].map((name) => path.join(fromDir, name));
  const steps: (Step | undefined)[] = [
    keychain?.step,
    jsonRewriteStep(paths, path.join(fromDir, "identity.json"), IdentitySchema, (stored) => {
      const credential = stored.credential === undefined ? undefined : { ...stored.credential, sources: stored.credential.sources.map((source) => repointedSource(source, fromDir, toDir, fromToken, toToken)) };
      const repointed = JSON.stringify(credential?.sources) !== JSON.stringify(stored.credential?.sources);
      return { value: { ...stored, name: to, ...(credential === undefined ? {} : { credential }) }, changes: ["name", ...(repointed ? ["credential file source"] : [])] };
    }),
    ...farmFiles.map((file) => textRewriteStep(paths, ports, file, (target, text) => { ports.fs.writeFileUtf8(target, text); }, (raw) => {
      const text = manifestWithIdentity(raw, to);
      return text === undefined ? undefined : { text, summary: "identity" };
    })),
    ...identityFarmEntries(paths, from).map((entry) => moveStep(paths, ports, path.join(paths.identitiesDir, entry), path.join(paths.identitiesDir, renamedFarmEntry(entry, from, to)))),
    tokenExists ? moveStep(paths, ports, fromToken, toToken) : undefined,
    identity.credential?.cache === undefined ? undefined : credentialCacheStep(ports, from, to, effectiveStore(identity.credential.cache, ports.credentialCache.platform)),
    jsonRewriteStep(paths, paths.globalConfigFile, GlobalConfigSchema, (config) => {
      const pools = config.pools === undefined ? undefined : renameIdentityInPools(config.pools, from, to);
      const jobs = config.jobs === undefined ? undefined : renameIdentityInJobs(config.jobs, from, to);
      const models = config.models === undefined ? undefined : renameAccountModelRefs(config.models, from, to);
      const changes = [...(pools?.renamedIn.map((name) => `pool ${name}`) ?? []), ...(jobs?.renamed.map((name) => `job ${name}`) ?? []), ...(models === undefined ? [] : ["models"])];
      return changes.length === 0
        ? undefined
        : { value: { ...config, ...(pools === undefined ? {} : { pools: pools.pools }), ...(jobs === undefined ? {} : { jobs: jobs.jobs }), ...(models === undefined ? {} : { models }) }, changes };
    }),
    ...listProfiles(paths).map(({ name }) =>
      jsonRewriteStep(paths, path.join(paths.configProfilesDir, `${name}.json`), ConfigProfileSchema, (profile) => {
        const models = profile.models === undefined ? undefined : renameAccountModelRefs(profile.models, from, to);
        return models === undefined ? undefined : { value: { ...profile, models }, changes: ["models"] };
      }),
    ),
    jsonRewriteStep(paths, paths.directoryRulesFile, DirectoryRulesSchema, (rules) => {
      const renamed = renameIdentityInRules(rules, from, to);
      return renamed === undefined ? undefined : { value: renamed.rules, changes: renamed.renamedAt.map((rulePath) => `rule ${rulePath}`) };
    }),
    readActiveIdentity(paths) === from ? textRewriteStep(paths, ports, paths.activeIdentityFile, (file, text) => { writeTextAtomic(file, text); }, () => ({ text: `${to}\n` })) : undefined,
    snapshotStep(paths, ports, from, to),
    textRewriteStep(paths, ports, paths.usagePicksFile, (file, text) => { ports.fs.writeFilePrivate(file, text); }, (raw) => {
      const renamed = picksWithIdentityRenamed(raw, from, to);
      return renamed === undefined ? undefined : { text: renamed.text, summary: counted(renamed.renamed, "pick") };
    }),
    textRewriteStep(paths, ports, paths.usageAnchorsFile, (file, text) => { ports.fs.writeFilePrivate(file, text); }, (raw) => {
      const text = stampsWithKeyRenamed(raw, from, to);
      return text === undefined ? undefined : { text, summary: counted(1, "stamp") };
    }),
  ];
  return { steps: steps.filter((step): step is Step => step !== undefined), finishers: keychain === undefined ? [] : [keychain.finisher] };
}

/** Raised when the rollback after a failed step could not undo everything: the first failure, and what was left. */
class RollbackFailedError extends CliError {
  constructor(cause: string, leftovers: readonly string[]) {
    super(`${cause}\nRolling back also failed, so the rename is partly done: ${leftovers.join("; ")}. Look at the steps named before running anything else.`);
    this.name = "RollbackFailedError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Applies the steps in order. If one fails, every step applied so far, the failing one included, is undone in reverse order and the failure is thrown. */
function applyAll(steps: readonly Step[]): void {
  const started: Step[] = [];
  try {
    for (const step of steps) {
      started.push(step);
      step.apply();
    }
  } catch (error) {
    const leftovers: string[] = [];
    for (const step of started.reverse()) {
      try {
        step.undo();
      } catch (undoError) {
        leftovers.push(`${step.description} (${messageOf(undoError)})`);
      }
    }
    if (leftovers.length > 0) {
      throw new RollbackFailedError(messageOf(error), leftovers);
    }
    throw error;
  }
}

/** Takes the resync lock of each identity in `names`, in order, and returns what releases them all. If one is busy, those already taken are released before its error is thrown. */
function holdLocks(paths: LayoutPaths, names: readonly string[], ports: IdentityRenamePorts): () => void {
  const held: IdentityLock[] = [];
  const release = (): void => {
    for (const lock of held.reverse()) {
      lock.release();
    }
  };
  try {
    for (const identity of names) {
      held.push(acquireIdentityLock({ identity, dir: paths.identitiesDir, fs: ports.fs, ...ports.lock }));
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** What a plan reports: each step's description, then each finisher's. */
function descriptionsOf(plan: Plan): readonly string[] {
  return [...plan.steps.map((step) => step.description), ...plan.finishers.map((finisher) => finisher.description)];
}

/**
 * Says what `renameIdentity` would do, without doing it or taking a lock: the same checks, which refuse for the same reasons, and the same steps in the same order. The macOS Keychain is asked only for the attributes of the two items, never for a secret, and a cached credential is not read.
 *
 * Throws what `renameIdentity` throws before it changes anything.
 */
export function describeIdentityRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): IdentityRenameReport {
  requireNames(from, to);
  return { from, to, dryRun: true, steps: descriptionsOf(planRename(paths, from, to, ports)), warnings: [] };
}

/**
 * Renames identity `from` to `to` without losing its login or anything kept under its name. Takes the resync lock of both names, refuses while a session runs against the identity's directory, then applies, in order: the macOS Keychain login is copied to the service the new directory hashes to; the identity's own `identity.json` and farm record are rewritten; the directory (and any superseded farm beside it) and the stored token file move; the cached credential follows; every reference to the old name is rewritten (pools, jobs, account model refs, directory rules, the active selection, the usage snapshot, recorded picks, anchor stamps); and last, the old Keychain item is deleted once the new one is found. The old name is not kept as an alias: nothing can be running under it, and a stale name would only hide a mistake.
 *
 * It is transactional up to the last step. If any step fails, every earlier one is undone, the new Keychain item removed and the old one kept, and the failure is thrown. A failure in the last step only (deleting the old Keychain item) is a warning in the report, because the rename is complete by then and the leftover item is harmless.
 *
 * Throws `IdentityNotFoundError`, `IdentityAlreadyExistsError`, `InvalidIdentityNameError`, `UsageError` for equal names, `IdentityInUseError`, `KeychainLoginError` and `IdentityLockBusyError`. A committed `.agent-shim.json` in a project is not reachable from here, and neither is the usage log, which keeps its records under the name they were written with.
 */
export function renameIdentity(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): IdentityRenameReport {
  requireNames(from, to);
  requireRenamable(paths, from, to);
  const release = holdLocks(paths, [from, to], ports);
  try {
    const plan = planRename(paths, from, to, ports);
    applyAll(plan.steps);
    const warnings = plan.finishers.flatMap((finisher) => finisher.finish() ?? []);
    return { from, to, dryRun: false, steps: descriptionsOf(plan), warnings };
  } finally {
    release();
  }
}

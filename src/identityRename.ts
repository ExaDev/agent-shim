import path from "node:path";
import type { z } from "zod";

import { CliError, UsageError } from "./cliError";
import { ConfigValidationError } from "./config/load";
import { ConfigProfileSchema, DirectoryRulesSchema, GlobalConfigSchema, IdentitySchema, ProviderSchema, isRouterProvider, type CredentialCacheStore, type CredentialSource } from "./config/schema";
import { nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { listProfiles } from "./configProfilesStore";
import { effectiveStore, type CachedCredential, type CredentialCachePort } from "./credentialCache";
import { renameIdentityInRules } from "./directoryRulesStore";
import { IdentityAlreadyExistsError, IdentityNotFoundError, identityExists, identityFarmEntries, listIdentities, readActiveIdentity, readIdentity, renamedFarmEntry, requireNewIdentityName } from "./identityStore";
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
import { listProviders, providerJsonPath } from "./providersStore";
import { renameIdentityInPools } from "./poolStore";
import { stampsWithKeyRenamed } from "./usage/handledStamps";
import { picksWithIdentityRenamed } from "./usage/poolPick";
import { ANTHROPIC_PROVIDER } from "./usage/middleware";
import { FIVE_HOUR_WINDOW_MS } from "./usage/pick";
import { readUsageLog, readUsageSnapshot, snapshotPath, UsageSnapshotError } from "./usage/read";
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
  /** The home directory a credential `file` source spelled `~/...` is relative to. */
  readonly home: string;
  /** Whether two paths are one directory on disk, which is how a rename that only changes the case of a name is told on a filesystem that ignores case. */
  readonly sameDirectory: (first: string, second: string) => boolean;
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
  /** What the person should know: a limit of the rename itself, or something that went wrong after it was complete. */
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

/** Raised when the identity's usage snapshot cannot be read, so it cannot be moved under the new name. Nothing has been changed. */
class SnapshotUnreadableError extends CliError {
  constructor(file: string, detail: string) {
    super(`Cannot rename: ${file} is not a usage snapshot this agent-shim can read (${detail}). Fix it or remove it, then run the command again; nothing was changed.`);
    this.name = "SnapshotUnreadableError";
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
  /** Things the person should know that no step can do anything about, reported as warnings by the dry run and the real run alike. */
  readonly notes: readonly string[];
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

/** Raised when the new name is the old identity's directory under another spelling, as a name that differs only in case is on a filesystem that ignores case. The Keychain login is filed under a name derived from the exact spelling of the path, which the filesystem would not change, so it cannot be done in one step. */
class SameDirectoryError extends CliError {
  constructor(from: string, to: string) {
    super(`"${from}" and "${to}" are the same directory on this filesystem, so a rename that only changes the case cannot be done in one step. Go through a temporary name instead: agent-shim identity rename ${from} ${to}-tmp && agent-shim identity rename ${to}-tmp ${to}`);
    this.name = "SameDirectoryError";
  }
}

/** The checks that read the machine's state. `from` must exist and `to` must be free in every place its name would be filed. */
function requireRenamable(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): void {
  if (!identityExists(paths, from)) {
    throw new IdentityNotFoundError(from);
  }
  if (ports.sameDirectory(path.join(paths.identitiesDir, from), path.join(paths.identitiesDir, to))) {
    throw new SameDirectoryError(from, to);
  }
  if (identityExists(paths, to)) {
    throw new IdentityAlreadyExistsError(to);
  }
  const taken = identityFarmEntries(paths, to)[0];
  if (taken !== undefined) {
    throw new RenameTargetTakenError(`"${to}" is already in use: ${path.join(paths.identitiesDir, taken)} exists.`);
  }
}

/** Where the renamed identity's files go, as the credential `file` sources that name them must follow. */
interface MovedPaths {
  readonly fromDir: string;
  readonly toDir: string;
  readonly fromToken: string;
  readonly toToken: string;
  readonly home: string;
}

/** Expands a leading `~/` as the credential resolver does. */
function expandHome(filePath: string, home: string): string {
  return filePath.startsWith("~/") ? path.join(home, filePath.slice(1)) : filePath;
}

/** `absolute` written the way `original` was: with a leading `~` when it was and the new path is still under the home directory, so a source that was portable between machines stays so. */
function spelledLike(original: string, absolute: string, home: string): string {
  return original.startsWith("~/") && absolute.startsWith(`${home}${path.sep}`) ? `~${absolute.slice(home.length)}` : absolute;
}

/**
 * A credential source after the rename. A `file` source that names the identity's stored token file follows the file to its new name, and one that points inside the identity's directory follows the directory; any other path is the person's own and stays where it points. Sources of every other kind name things outside the directory and are untouched.
 */
function repointedSource(source: CredentialSource, moved: MovedPaths): CredentialSource {
  if (!("file" in source)) {
    return source;
  }
  const file = expandHome(source.file, moved.home);
  if (file === moved.fromToken) {
    return { file: spelledLike(source.file, moved.toToken, moved.home) };
  }
  const inside = file === moved.fromDir || file.startsWith(`${moved.fromDir}${path.sep}`);
  return inside ? { file: spelledLike(source.file, `${moved.toDir}${file.slice(moved.fromDir.length)}`, moved.home) } : source;
}

/** `sources` with each one re-pointed, or undefined when none of them names anything that moved. */
function repointedSources(sources: readonly CredentialSource[], moved: MovedPaths): CredentialSource[] | undefined {
  const next = sources.map((source) => repointedSource(source, moved));
  return JSON.stringify(next) === JSON.stringify(sources) ? undefined : next;
}

/** Whether `text`, a file that could not be parsed, names a path that moved, in any spelling a source could take. */
function namesMovedPath(text: string, moved: MovedPaths): boolean {
  return [moved.fromToken, moved.fromDir].some((target) => text.includes(target) || (target.startsWith(`${moved.home}${path.sep}`) && text.includes(`~${target.slice(moved.home.length)}`)));
}

/** Raised when a file that holds credential sources cannot be read and names a path the rename would move, so it cannot be re-pointed and would be left broken. Nothing has been changed. */
class UnreadableCredentialFileError extends CliError {
  constructor(file: string, detail: string) {
    super(`Cannot rename: ${file} cannot be read (${detail}) and names a path this rename moves, so it could not be updated. Fix or remove it, then run the command again; nothing was changed.`);
    this.name = "UnreadableCredentialFileError";
  }
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
  if (ports.fs.readFileUtf8(source) === undefined) {
    return undefined;
  }
  // Parsed here, not only when applied: a snapshot the step cannot read would pass a dry run and fail a real one after the Keychain copy.
  try {
    readUsageSnapshot(ports.fs, paths.usageSnapshotsDir, from);
  } catch (error) {
    if (error instanceof UsageSnapshotError) {
      throw new SnapshotUnreadableError(path.relative(paths.root, source), error.message);
    }
    throw error;
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

/**
 * A note for the person when the usage log holds requests of identity `from` from the current five-hour window, which the rename leaves under that name. The log is append-only with one writer per segment, and the front door that writes it is running, so rewriting a segment from here would race its appends and lose records. Pool ranking reads those records for a member's burn rate and five-hour to seven-day ratio, so the renamed member has neither from them until the window passes; its quota windows come from its snapshot, which moves with it.
 */
function usageWindowNote(paths: LayoutPaths, ports: IdentityRenamePorts, from: string, to: string): string | undefined {
  const windowStartMs = ports.lock.nowMs() - FIVE_HOUR_WINDOW_MS;
  const { records } = readUsageLog(ports.fs, paths.usageLogDir, { sinceMs: windowStartMs });
  const logged = records.some((record) => record.identity === from && record.provider === ANTHROPIC_PROVIDER && Date.parse(record.at) >= windowStartMs);
  return logged
    ? `Usage already logged for "${from}" in the last five hours stays filed under that name: the usage log is appended to by the running front door, so it is not rewritten. Until those hours pass, pool ranking has no burn rate or five-hour to seven-day ratio for "${to}" from them. Its quota windows come from its snapshot, which moved, and are unaffected.`
    : undefined;
}

/** The steps that re-point the credential `file` sources of every identity but the renamed one, and of every provider, that name the token file or sit inside the directory being moved. A file that cannot be parsed and names a moved path is refused, since it can be neither updated nor trusted. */
function credentialHolderSteps(paths: LayoutPaths, ports: IdentityRenamePorts, from: string, moved: MovedPaths): readonly (Step | undefined)[] {
  const refuseIfNamed = (file: string, detail: string): void => {
    const text = ports.fs.readFileUtf8(file);
    if (text !== undefined && namesMovedPath(text, moved)) {
      throw new UnreadableCredentialFileError(path.relative(paths.root, file), detail);
    }
  };
  const identitySteps = listIdentities(paths)
    .filter((entry) => entry.name !== from)
    .map((entry) => {
      const file = path.join(paths.identitiesDir, entry.name, "identity.json");
      if (entry.identity === undefined) {
        refuseIfNamed(file, entry.problem);
        return undefined;
      }
      return jsonRewriteStep(paths, file, IdentitySchema, (stored) => {
        const sources = stored.credential === undefined ? undefined : repointedSources(stored.credential.sources, moved);
        return stored.credential === undefined || sources === undefined ? undefined : { value: { ...stored, credential: { ...stored.credential, sources } }, changes: ["credential file source"] };
      });
    });
  const invalidProviders: { readonly name: string; readonly message: string }[] = [];
  const providers = listProviders(paths, (name, message) => {
    invalidProviders.push({ name, message });
  });
  for (const { name, message } of invalidProviders) {
    refuseIfNamed(providerJsonPath(paths, name), message.split("\n")[0] ?? message);
  }
  const providerSteps = providers.map(({ name }) =>
    jsonRewriteStep(paths, providerJsonPath(paths, name), ProviderSchema, (stored) => {
      if (isRouterProvider(stored)) {
        return undefined;
      }
      const sources = repointedSources(stored.credential.sources, moved);
      return sources === undefined ? undefined : { value: { ...stored, credential: { ...stored.credential, sources } }, changes: ["credential file source"] };
    }),
  );
  return [...identitySteps, ...providerSteps];
}

/** Builds the plan: every check that can refuse, then every step in the order it is applied. The order puts what can fail for reasons outside the files first and the Keychain's old item last, and rewrites the identity's own files before the directory moves so each path is read where it is. */
function planRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): Plan {
  requireRenamable(paths, from, to, ports);
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

  const moved: MovedPaths = { fromDir, toDir, fromToken, toToken, home: ports.home };
  const keychain = keychainPlan(ports, fromDir, toDir);
  const farmFiles = [FARM_MANIFEST_FILENAME, LEGACY_FARM_MANIFEST_FILENAME].map((name) => path.join(fromDir, name));
  const steps: (Step | undefined)[] = [
    keychain?.step,
    jsonRewriteStep(paths, path.join(fromDir, "identity.json"), IdentitySchema, (stored) => {
      const sources = stored.credential === undefined ? undefined : repointedSources(stored.credential.sources, moved);
      return {
        value: { ...stored, name: to, ...(stored.credential === undefined || sources === undefined ? {} : { credential: { ...stored.credential, sources } }) },
        changes: ["name", ...(sources === undefined ? [] : ["credential file source"])],
      };
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
    ...credentialHolderSteps(paths, ports, from, moved),
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
  const note = usageWindowNote(paths, ports, from, to);
  return { steps: steps.filter((step): step is Step => step !== undefined), finishers: keychain === undefined ? [] : [keychain.finisher], notes: note === undefined ? [] : [note] };
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

/** Takes the resync lock of each identity in `names`, in name order, and returns what releases them all. The order does not depend on which name is the old one, so two renames running in opposite directions over the same pair ask for the locks in the same order and cannot each hold one and wait for the other. If one is busy, those already taken are released before its error is thrown. */
function holdLocks(paths: LayoutPaths, names: readonly string[], ports: IdentityRenamePorts): () => void {
  const held: IdentityLock[] = [];
  const release = (): void => {
    for (const lock of held.reverse()) {
      lock.release();
    }
  };
  try {
    for (const identity of [...names].sort()) {
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
  const plan = planRename(paths, from, to, ports);
  return { from, to, dryRun: true, steps: descriptionsOf(plan), warnings: plan.notes };
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
  requireRenamable(paths, from, to, ports);
  const release = holdLocks(paths, [from, to], ports);
  try {
    const plan = planRename(paths, from, to, ports);
    applyAll(plan.steps);
    const warnings = plan.finishers.flatMap((finisher) => finisher.finish() ?? []);
    return { from, to, dryRun: false, steps: descriptionsOf(plan), warnings: [...plan.notes, ...warnings] };
  } finally {
    release();
  }
}

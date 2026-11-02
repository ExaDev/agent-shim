import os from "node:os";
import path from "node:path";
import type { z } from "zod";

import { CliError, EXIT_FAILURE, UsageError } from "./cliError";
import { ConfigValidationError } from "./config/load";
import { UnsafeNameError, isStoredName } from "./config/names";
import { ConfigProfileSchema, DirectoryRulesSchema, GlobalConfigSchema, IdentitySchema, ProviderSchema, isRouterProvider, type CredentialCacheStore, type CredentialSource } from "./config/schema";
import { nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { listProfiles } from "./configProfilesStore";
import { effectiveStore, type CachedCredential, type CredentialCachePort } from "./credentialCache";
import { renameIdentityInRules } from "./directoryRulesStore";
import { IdentityAlreadyExistsError, IdentityNotFoundError, identityExists, identityFarmEntries, listIdentities, readActiveIdentity, readIdentity, renamedFarmEntry, requireNewIdentityName } from "./identityStore";
import { identityTokenPath } from "./identityToken";
import type { IdentitySessionProbe, SessionProcess } from "./identitySessions";
import { renameIdentityInJobs } from "./jobStore";
import { describeUnfinishable, describeUnfinishedRename, discardJournalCommand, finishabilityOf, readRenameJournal, readRenameJournals, removeRenameJournal, renameJournalFile, unfinishedRenameFor, writeRenameJournal, type RenameFinishability, type RenameJournal } from "./identityRenameJournal";
import { deleteKeychainLogin, planKeychainLogin, readKeychainLogin, writeKeychainLogin, type KeychainLoginPlan } from "./keychainLogin";
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
import { claudeCodeKeychainService, keychainHasItem } from "./usage/signIn";

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
  /** Where a path really is, following symlinks; a path that does not exist answers as itself. A source may name a moved path through a symlinked directory above it, and this is how the rename finds that spelling. */
  readonly realpath: (target: string) => string;
  /** Tells whether a session is running against the identity's directory. */
  readonly sessions: IdentitySessionProbe;
  /** How the rename hears that the process was told to stop, and how it lets such a signal be heard. */
  readonly signals: IdentityRenameSignals;
  /** The launches in progress for an identity: a launcher that has recorded itself and not yet exited, which is a session about to start when no process carries the directory yet. */
  readonly launches: IdentityLaunchProbe;
  /** What taking a resync lock needs from the machine. */
  readonly lock: Pick<AcquireIdentityLockParams, "nowMs" | "pid" | "isRunning" | "sleep">;
}

/** What the rename needs to stop cleanly when the process is told to: a handler for the signals, and a way to let one that arrived during synchronous work be delivered. */
export interface IdentityRenameSignals {
  /** Calls `handler` with the signal's name when the process is sent SIGINT or SIGTERM, until the returned function is called. */
  readonly onInterrupt: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /** Resolves after the event loop has turned, which is when a signal that arrived during synchronous work reaches its handler. */
  readonly turn: () => Promise<void>;
}

/** Tells which launches are in progress for an identity. Injected so the rename never reads the real launch records in a test. */
export interface IdentityLaunchProbe {
  /** The launchers that are launching `identity` now, in the shape of the sessions found on its directory. */
  readonly liveOn: (identity: string) => readonly SessionProcess[];
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
    super(`Identity "${identity}" is in use: ${sessions.map((session) => `pid ${String(session.pid)} (${session.program})`).join(", ")} ${sessions.length === 1 ? "is" : "are"} using ${directory}. End ${sessions.length === 1 ? "it" : "them"}, then run the command again.`);
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

/** The names' own checks, which need no state: they run before anything is locked, so a bad name leaves no lock file behind and a name that would leave the identities directory never reaches a path. The old name need only stay inside the directory, since an identity created under an older, looser rule may have it; the new name must have the shape a new identity is given. */
function requireNames(from: string, to: string): void {
  if (from === to) {
    throw new UsageError(`"${from}" is already the identity's name.`);
  }
  if (!isStoredName(from)) {
    throw new UnsafeNameError(from, "identity");
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

/** Raised when a rename was left unfinished that names `from` or `to` and is not this same rename: the identities are partly moved, and anything else done to them now would be done to a state nobody chose. */
class UnfinishedRenameError extends CliError {
  constructor(from: string, to: string, journal: Readonly<RenameJournal>, finishability: RenameFinishability) {
    super(`Cannot rename "${from}" to "${to}": there is ${describeUnfinishedRename(journal, finishability)}`);
    this.name = "UnfinishedRenameError";
  }
}

/** Raised when a rename was left unfinished and the identity is under neither name or under both, so no run of it can finish it and nothing else can clear it: the journal is discarded by hand with `--discard-journal`, which changes no identity. */
class UnfinishableRenameError extends CliError {
  constructor(from: string, to: string, both: boolean) {
    super(`The unfinished rename of "${from}" to "${to}" cannot be finished: ${describeUnfinishable(both)}. If nothing is left of it to keep, discard its record with \`${discardJournalCommand({ from, to })}\`; that removes only the record of the rename and changes no identity.`);
    this.name = "UnfinishableRenameError";
  }
}

/** Raised when the journal of a rename is asked to be discarded while the identity is under exactly one of its names, where running the rename again finishes it. */
class FinishableRenameError extends CliError {
  constructor(from: string, to: string) {
    super(`The unfinished rename of "${from}" to "${to}" can be finished, so its record is kept: run \`agent-shim identity rename ${from} ${to}\` to finish it.`);
    this.name = "FinishableRenameError";
  }
}

/** Raised when there is no unfinished rename of the pair to discard. */
class NoRenameToDiscardError extends CliError {
  constructor(from: string, to: string) {
    super(`There is no unfinished rename of "${from}" to "${to}" to discard.`);
    this.name = "NoRenameToDiscardError";
  }
}

/**
 * The checks that read the machine's state. `from` must exist and `to` must be free in every place its name would be filed. When `resuming` a rename that was left unfinished, the identity is wherever the earlier run got it to, under either name, and the places already moved are no clash; an identity under neither name or under both cannot be finished and throws `UnfinishableRenameError`.
 */
function requireRenamable(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, resuming: boolean): void {
  if (resuming) {
    const underFrom = identityExists(paths, from);
    const underTo = identityExists(paths, to);
    if (underFrom === underTo) {
      throw new UnfinishableRenameError(from, to, underFrom);
    }
    return;
  }
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

/** One path that moves: where it is, and where it goes. */
interface MovedPlace {
  readonly from: string;
  readonly to: string;
}

/** Where the renamed identity's files go, as the credential `file` sources that name them must follow. */
interface MovedPaths {
  /** The stored token file: where it is and where it goes, spelled directly and, when a directory above it is a symlink, through the real path of the directory that holds it, since a source can name it either way. */
  readonly tokens: readonly MovedPlace[];
  /** The identity's directory, spelled the same ways. */
  readonly directories: readonly MovedPlace[];
  /** The Keychain service names Claude Code files the login of each directory under: a credential `keychain` source naming the old one names the login this rename moves. */
  readonly fromService: string;
  readonly toService: string;
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
 * A credential source after the rename. A `file` source that names the identity's stored token file follows the file to its new name, and one that points inside the identity's directory follows the directory; any other path is the person's own and stays where it points. A `keychain` source naming the Keychain service of the old directory's login follows the login to its new service. Sources of every other kind name things the rename does not move and are untouched.
 */
function repointedSource(source: CredentialSource, moved: MovedPaths): CredentialSource {
  if ("keychain" in source) {
    // The login is copied to the new service and the old item deleted last, so a source still naming the old service would name an item that is gone.
    return source.keychain.service === moved.fromService ? { ...source, keychain: { ...source.keychain, service: moved.toService } } : source;
  }
  if (!("file" in source)) {
    return source;
  }
  const file = expandHome(source.file, moved.home);
  for (const { from, to } of moved.tokens) {
    if (file === from) {
      return { file: spelledLike(source.file, to, moved.home) };
    }
  }
  for (const { from, to } of moved.directories) {
    if (file === from || file.startsWith(`${from}${path.sep}`)) {
      return { file: spelledLike(source.file, `${to}${file.slice(from.length)}`, moved.home) };
    }
  }
  return source;
}

/**
 * `place` and, when it differs, the same place spelled through the real path of the directory that holds it: a state root reached through a symlink can be named by either. The place itself is not resolved, since when it is a symlink only the link moves and what it points at stays where it is.
 */
function placesThroughRealParent(place: MovedPlace, realpath: (target: string) => string): readonly MovedPlace[] {
  const through = (target: string): string => path.join(realpath(path.dirname(target)), path.basename(target));
  const real = { from: through(place.from), to: through(place.to) };
  return real.from === place.from && real.to === place.to ? [place] : [place, real];
}

/** `target` as a person or a shell script could write it: in full, and when it is under the home directory also with a leading `~`, `$HOME` or `${HOME}`. */
function spellingsOf(target: string, home: string): readonly string[] {
  if (!target.startsWith(`${home}${path.sep}`)) {
    return [target];
  }
  const rest = target.slice(home.length);
  return [target, `~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`];
}

/** `sources` with each one re-pointed, or undefined when none of them names anything that moved. */
function repointedSources(sources: readonly CredentialSource[], moved: MovedPaths): CredentialSource[] | undefined {
  const next = sources.map((source) => repointedSource(source, moved));
  return JSON.stringify(next) === JSON.stringify(sources) ? undefined : next;
}

/** Whether `text` holds `target` as a whole path: not as the start of a longer name, so the directory of `work` is not found in that of `work-two`. */
function namesPath(text: string, target: string): boolean {
  for (let at = text.indexOf(target); at !== -1; at = text.indexOf(target, at + 1)) {
    if (!/[A-Za-z0-9._@-]/u.test(text.charAt(at + target.length))) {
      return true;
    }
  }
  return false;
}

/** Whether `text`, a file that could not be read or the arguments of a source, names something the rename moves: the token file or directory in any spelling a source could take, or the Keychain service of the login, which is deleted once it has been copied. A service is a name ending in a hash, so it is told from a longer one by the same boundary as a path. */
function namesMovedPath(text: string, moved: MovedPaths): boolean {
  return namesPath(text, moved.fromService) || [...moved.tokens, ...moved.directories].some(({ from }) => spellingsOf(from, moved.home).some((spelling) => namesPath(text, spelling)));
}

/** Raised when a file that holds credential sources cannot be read and names a path or the Keychain login the rename would move, so it cannot be re-pointed and would be left broken. Nothing has been changed. */
class UnreadableCredentialFileError extends CliError {
  constructor(file: string, detail: string) {
    super(`Cannot rename: ${file} cannot be read (${detail}) and names a path or the Keychain login this rename moves, so it could not be updated. Fix or remove it, then run the command again; nothing was changed.`);
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
function jsonRewriteStep<S extends z.ZodType>(paths: LayoutPaths, ports: IdentityRenamePorts, file: string, schema: S, rewrite: (value: z.infer<S>) => Rewrite<z.infer<S>> | undefined): Step | undefined {
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
      // A file that moved with its directory has no place to be put back: writing here would make a stray directory under the old name, and the moved copy already holds what a resume expects.
      if (original !== undefined && ports.fs.lstat(path.dirname(file)) !== undefined) {
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
      if (original !== undefined && ports.fs.lstat(path.dirname(file)) !== undefined) {
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

/**
 * The Keychain steps: copy the macOS login to the service the new directory hashes to now, and delete the old item once everything else has succeeded. `login` is the plan and the password bytes read before the locks were taken; a dry run reads no password, so the step it plans has no bytes and is never applied.
 */
function keychainPlan(ports: IdentityRenamePorts, login: GatheredLogin | undefined, toDir: string): { readonly step: Step | undefined; readonly finisher: Finisher } | undefined {
  if (login === undefined) {
    return undefined;
  }
  const { plan } = login;
  return {
    step: plan.alreadyCopied
      ? undefined
      : {
          description: `copy the Keychain login "${plan.fromService}" to "${plan.toService}"`,
          apply: () => {
            if (login.bytes === undefined) {
              throw new Error("a plan made for a dry run reads no login, so it cannot be applied");
            }
            writeKeychainLogin(ports.run, plan, login.bytes);
          },
          undo: () => {
            deleteKeychainLogin(ports.run, plan.toService, plan.account);
          },
        },
    finisher: {
      description: `delete the former Keychain login "${plan.fromService}"`,
      finish: () => {
        const remove = `security delete-generic-password -s "${plan.fromService}" -a "${plan.account}"`;
        if (!keychainHasItem(ports.run, toDir)) {
          return `The new Keychain login "${plan.toService}" could not be found after the rename, so the former one "${plan.fromService}" was kept. Look at the new one before deleting the old with \`${remove}\`.`;
        }
        try {
          deleteKeychainLogin(ports.run, plan.fromService, plan.account);
        } catch (error) {
          return `The former Keychain login "${plan.fromService}" could not be deleted (${error instanceof Error ? error.message : String(error)}). It is harmless: delete it with \`${remove}\`.`;
        }
        return undefined;
      },
    },
  };
}

/** The step that moves the cached credential from the old owner to the new, when the identity's credential block turns caching on. `cached` is the entry read before the locks were taken, because reading it can wait on a person; the plan names the step whether or not one is stored, and applying it moves nothing when none is. */
function credentialCacheStep(ports: IdentityRenamePorts, from: string, to: string, store: CredentialCacheStore, cached: CachedCredential | undefined): Step {
  const { port } = ports.credentialCache;
  return {
    description: `move the cached credential of identity ${from} to identity ${to}, if one is stored`,
    apply: () => {
      if (cached !== undefined) {
        port.write(store, `identity ${to}`, cached);
        port.remove(store, `identity ${from}`);
      }
    },
    undo: () => {
      if (cached !== undefined) {
        port.write(store, `identity ${from}`, cached);
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
      return jsonRewriteStep(paths, ports, file, IdentitySchema, (stored) => {
        const sources = stored.credential === undefined ? undefined : repointedSources(stored.credential.sources, moved);
        return stored.credential === undefined || sources === undefined ? undefined : { value: { ...stored, credential: { ...stored.credential, sources } }, changes: ["credential source"] };
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
    jsonRewriteStep(paths, ports, providerJsonPath(paths, name), ProviderSchema, (stored) => {
      if (isRouterProvider(stored)) {
        return undefined;
      }
      const sources = repointedSources(stored.credential.sources, moved);
      return sources === undefined ? undefined : { value: { ...stored, credential: { ...stored.credential, sources } }, changes: ["credential source"] };
    }),
  );
  return [...identitySteps, ...providerSteps];
}

/**
 * A note for each credential source the rename cannot update: a `command` source runs a program and an `op` source asks 1Password, and either may name a path the rename moves, or the service of the login it deletes, in its arguments or its reference. Program arguments are not rewritten, since nothing says which of them is the path, so the source is left as it is and the person is told which holder has it. The note names the holder and the kind, never the arguments, which may hold a secret.
 */
function unrewritableSourceNotes(paths: LayoutPaths, from: string, to: string, moved: MovedPaths): readonly string[] {
  const noteFor = (holder: string, source: CredentialSource): readonly string[] => {
    const named = "command" in source ? namesMovedPath(source.command.join("\n"), moved) && "command" : "op" in source ? namesMovedPath(source.op, moved) && "op" : false;
    return named === false ? [] : [`${holder} has ${named === "op" ? "an op" : "a command"} credential source that names a path or the Keychain login this rename moves, which it cannot update. Change it by hand once the rename is done.`];
  };
  const identities = listIdentities(paths).flatMap((entry) => entry.identity?.credential?.sources.flatMap((source) => noteFor(`Identity "${entry.name === from ? to : entry.name}"`, source)) ?? []);
  const providers = listProviders(paths, () => undefined).flatMap(({ name, provider }) => (isRouterProvider(provider) ? [] : provider.credential.sources.flatMap((source) => noteFor(`Provider "${name}"`, source))));
  return [...identities, ...providers];
}

/** The login a dry run plans around: which services it would copy between, found from attributes alone, and no password. */
function dryRunLogin(ports: IdentityRenamePorts, fromDir: string, toDir: string, resuming: boolean): GatheredLogin | undefined {
  const plan = ports.platform === "darwin" ? planKeychainLogin(ports.run, fromDir, toDir, resuming) : undefined;
  return plan === undefined ? undefined : { plan, bytes: undefined };
}

/** The login of the identity in the macOS Keychain: how to copy it, and its password bytes when they were read (a dry run reads none). */
interface GatheredLogin {
  readonly plan: KeychainLoginPlan;
  readonly bytes: Buffer | undefined;
}

/** What the rename reads before it takes any lock, because each read can wait on a person: the Keychain asks to approve `security` reading an item Claude Code wrote, and may ask for the Keychain to be unlocked. Holding a lock across such a wait would let it go stale. */
interface Gathered {
  readonly login: GatheredLogin | undefined;
  readonly cached: CachedCredential | undefined;
}

/** Reads what `Gathered` holds. Throws `KeychainLoginError` when the new directory's service already holds an item that no earlier run of this rename put there, or the login cannot be read. */
function gather(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, resuming: boolean): Gathered {
  const plan = ports.platform === "darwin" ? planKeychainLogin(ports.run, path.join(paths.identitiesDir, from), path.join(paths.identitiesDir, to), resuming) : undefined;
  const cache = readIdentity(paths, currentName(paths, from, to))?.credential?.cache;
  return {
    login: plan === undefined ? undefined : { plan, bytes: plan.alreadyCopied ? undefined : readKeychainLogin(ports.run, plan) },
    cached: cache === undefined ? undefined : ports.credentialCache.port.read(effectiveStore(cache, ports.credentialCache.platform), `identity ${from}`),
  };
}

/** The name the identity is under now: `from`, or `to` when an earlier run of this rename had already moved it. */
function currentName(paths: LayoutPaths, from: string, to: string): string {
  return identityExists(paths, from) ? from : to;
}

/** Throws `IdentityInUseError` when a session is running against `from`'s directory, or a launch of it is between its farm resync and its spawn. */
function requireNoSessions(paths: LayoutPaths, from: string, ports: IdentityRenamePorts): void {
  const directory = path.join(paths.identitiesDir, from);
  const using = [...ports.sessions.sessionsOn(directory), ...ports.launches.liveOn(from)];
  if (using.length > 0) {
    throw new IdentityInUseError(from, directory, using);
  }
}

/** Builds the plan: every check that can refuse, then every step in the order it is applied. The order puts what can fail for reasons outside the files first and the Keychain's old item last, and rewrites the identity's own files before the directory moves so each path is read where it is. */
function planRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, gathered: Gathered | undefined, resuming: boolean): Plan {
  requireRenamable(paths, from, to, ports, resuming);
  const fromDir = path.join(paths.identitiesDir, from);
  const toDir = path.join(paths.identitiesDir, to);
  requireNoSessions(paths, from, ports);
  if (resuming) {
    requireNoSessions(paths, to, ports);
  }
  const fromToken = identityTokenPath(paths, from);
  const toToken = identityTokenPath(paths, to);
  const tokenExists = ports.fs.lstat(fromToken) !== undefined;
  if (tokenExists && ports.fs.lstat(toToken) !== undefined) {
    throw new RenameTargetTakenError(`A token file for "${to}" already exists at ${toToken}, so the one for "${from}" cannot move there.`);
  }
  const identityDir = path.join(paths.identitiesDir, currentName(paths, from, to));
  const identity = readIdentity(paths, currentName(paths, from, to));
  if (identity === undefined) {
    throw new IdentityNotFoundError(from);
  }

  const moved: MovedPaths = { tokens: placesThroughRealParent({ from: fromToken, to: toToken }, ports.realpath), directories: placesThroughRealParent({ from: fromDir, to: toDir }, ports.realpath), fromService: claudeCodeKeychainService(fromDir), toService: claudeCodeKeychainService(toDir), home: ports.home };
  const keychain = keychainPlan(ports, gathered === undefined ? dryRunLogin(ports, fromDir, toDir, resuming) : gathered.login, toDir);
  const farmFiles = [FARM_MANIFEST_FILENAME, LEGACY_FARM_MANIFEST_FILENAME].map((name) => path.join(identityDir, name));
  const steps: (Step | undefined)[] = [
    keychain?.step,
    jsonRewriteStep(paths, ports, path.join(identityDir, "identity.json"), IdentitySchema, (stored) => {
      const sources = stored.credential === undefined ? undefined : repointedSources(stored.credential.sources, moved);
      if (stored.name === to && sources === undefined) {
        return undefined;
      }
      return {
        value: { ...stored, name: to, ...(stored.credential === undefined || sources === undefined ? {} : { credential: { ...stored.credential, sources } }) },
        changes: ["name", ...(sources === undefined ? [] : ["credential source"])],
      };
    }),
    ...farmFiles.map((file) => textRewriteStep(paths, ports, file, (target, text) => { ports.fs.writeFileUtf8(target, text); }, (raw) => {
      const text = manifestWithIdentity(raw, to);
      return text === undefined ? undefined : { text, summary: "identity" };
    })),
    ...identityFarmEntries(paths, from).map((entry) => moveStep(paths, ports, path.join(paths.identitiesDir, entry), path.join(paths.identitiesDir, renamedFarmEntry(entry, from, to)))),
    tokenExists ? moveStep(paths, ports, fromToken, toToken) : undefined,
    identity.credential?.cache === undefined ? undefined : credentialCacheStep(ports, from, to, effectiveStore(identity.credential.cache, ports.credentialCache.platform), gathered?.cached),
    jsonRewriteStep(paths, ports, paths.globalConfigFile, GlobalConfigSchema, (config) => {
      const pools = config.pools === undefined ? undefined : renameIdentityInPools(config.pools, from, to);
      const jobs = config.jobs === undefined ? undefined : renameIdentityInJobs(config.jobs, from, to);
      const models = config.models === undefined ? undefined : renameAccountModelRefs(config.models, from, to);
      const changes = [...(pools?.renamedIn.map((name) => `pool ${name}`) ?? []), ...(jobs?.renamed.map((name) => `job ${name}`) ?? []), ...(models === undefined ? [] : ["models"])];
      return changes.length === 0
        ? undefined
        : { value: { ...config, ...(pools === undefined ? {} : { pools: pools.pools }), ...(jobs === undefined ? {} : { jobs: jobs.jobs }), ...(models === undefined ? {} : { models }) }, changes };
    }),
    ...listProfiles(paths).map(({ name }) =>
      jsonRewriteStep(paths, ports, path.join(paths.configProfilesDir, `${name}.json`), ConfigProfileSchema, (profile) => {
        const models = profile.models === undefined ? undefined : renameAccountModelRefs(profile.models, from, to);
        return models === undefined ? undefined : { value: { ...profile, models }, changes: ["models"] };
      }),
    ),
    ...credentialHolderSteps(paths, ports, from, moved),
    jsonRewriteStep(paths, ports, paths.directoryRulesFile, DirectoryRulesSchema, (rules) => {
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
  const usageNote = usageWindowNote(paths, ports, from, to);
  return {
    steps: steps.filter((step): step is Step => step !== undefined),
    finishers: keychain === undefined ? [] : [keychain.finisher],
    notes: [...unrewritableSourceNotes(paths, from, to, moved), ...(usageNote === undefined ? [] : [usageNote])],
  };
}

/** The shell's convention for the exit status of a process ended by a signal: this plus the signal's number. */
const SIGNAL_EXIT_STATUS_BASE = 128;

/** What a rollback that undid every step this run applied leaves, as a sentence: nothing half done for a rename that began here, and for one that was finishing an earlier run the earlier run's state, which is still unfinished. */
function rolledBackOutcome(resuming: boolean): string {
  return resuming ? "the steps this run applied were rolled back; the rename it was finishing is still unfinished, and running the same command again finishes it" : "the rename was rolled back and nothing was changed";
}

/** Raised when the process was sent SIGINT or SIGTERM while the rename was applying its steps. Everything this run did has been undone. The exit status is the shell's convention for a process ended by that signal. */
class RenameInterruptedError extends CliError {
  override readonly exitCode: number;

  constructor(readonly signal: NodeJS.Signals, resuming: boolean) {
    super(`Interrupted by ${signal}: ${rolledBackOutcome(resuming)}.`);
    this.name = "RenameInterruptedError";
    this.exitCode = SIGNAL_EXIT_STATUS_BASE + os.constants.signals[signal];
  }
}

/** What the sentence about the journal says when a rollback could not record that it undid steps: they were undone, and only the record of them is behind. */
function unrecordedSentence(unrecorded: readonly string[]): string {
  return `The journal under identity-renames/ could not be updated for ${unrecorded.join("; ")}, so it may still show steps as done that were undone; a run of the same rename plans from what is on disk and is not misled by it.`;
}

/** Raised when the rollback after a failed step could not undo everything: the first failure, and what was left. `unrecorded` names the steps that were undone but whose journal update failed, when any. */
class RollbackFailedError extends CliError {
  constructor(cause: string, leftovers: readonly string[], unrecorded: readonly string[]) {
    super(`${cause}\nRolling back also failed, so the rename is partly done: ${leftovers.join("; ")}. Look at the steps named before running anything else.${unrecorded.length === 0 ? "" : `\n${unrecordedSentence(unrecorded)}`}`);
    this.name = "RollbackFailedError";
  }
}

/** Raised when every step this run applied was undone but the journal could not be updated to say so: the rollback is complete, and the failure is the record's. */
class RollbackNotRecordedError extends CliError {
  override readonly exitCode: number;

  /** `cause` is what failed the rename: its message leads, and its exit status is kept, since a signal that rolled the rename back still ends the process with the signal's status. An interruption already says what the rollback left, so only another cause is followed by that outcome. */
  constructor(cause: unknown, unrecorded: readonly string[], resuming: boolean) {
    const outcome = cause instanceof RenameInterruptedError ? "" : `\nThis run's rollback is complete: ${rolledBackOutcome(resuming)}.`;
    super(`${messageOf(cause)}${outcome}\n${unrecordedSentence(unrecorded)}`);
    this.name = "RollbackNotRecordedError";
    this.exitCode = cause instanceof CliError ? cause.exitCode : EXIT_FAILURE;
  }
}

/** Raised when a rename was rolled back, or failed, and its journal could not be removed: the failure that ended the rename leads and keeps its exit status, and the journal is left, which a re-run of the same rename carries on from. */
class JournalNotRemovedError extends CliError {
  override readonly exitCode: number;

  constructor(cause: unknown, file: string, removal: unknown) {
    super(`${messageOf(cause)}\nThe journal ${path.join("identity-renames", path.basename(file))} could not be removed (${messageOf(removal)}), so it still describes this rename as unfinished and stops any other rename of either name; running the same command again finishes it.`);
    this.name = "JournalNotRemovedError";
    this.exitCode = cause instanceof CliError ? cause.exitCode : EXIT_FAILURE;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the apply loop does between steps. */
interface ApplyHooks {
  /** Called after each step with its position in the plan: the locks are refreshed and the journal marked here, and the call throws when a lock was taken over. */
  readonly afterStep: (index: number) => void;
  /** Called after each step is undone during a rollback, with its position in the plan: the journal marks the step as not done here, so that what it records is what is still applied. */
  readonly afterUndo: (index: number) => void;
  /** Whether this run finishes a rename an earlier one left unfinished, which an interruption's message says. */
  readonly resuming: boolean;
  /** The signal the process received, if it has received one. */
  readonly interrupted: () => NodeJS.Signals | undefined;
  /** Lets the event loop turn, so that a signal that arrived during the last step is delivered to its handler. */
  readonly turn: () => Promise<void>;
}

/**
 * Applies the steps in order. Before each step the event loop is let turn and the process is checked for a SIGINT or SIGTERM, and after each the locks are refreshed; a signal during the last step lets the rename finish, since there is nothing left to undo. If a step, the refresh or an interrupt fails the rename, every step applied so far, the failing one included, is undone in reverse order and the failure is thrown.
 */
async function applyAll(steps: readonly Step[], hooks: ApplyHooks): Promise<void> {
  const started: { readonly step: Step; readonly index: number }[] = [];
  try {
    for (const [index, step] of steps.entries()) {
      await hooks.turn();
      const signal = hooks.interrupted();
      if (signal !== undefined) {
        throw new RenameInterruptedError(signal, hooks.resuming);
      }
      started.push({ step, index });
      step.apply();
      hooks.afterStep(index);
    }
  } catch (error) {
    const leftovers: string[] = [];
    const unrecorded: string[] = [];
    for (const { step, index } of started.reverse()) {
      try {
        step.undo();
      } catch (undoError) {
        leftovers.push(`${step.description} (${messageOf(undoError)})`);
        continue;
      }
      // Its own try: the step is undone, so a journal that cannot be written is not a step that could not be undone.
      try {
        hooks.afterUndo(index);
      } catch (journalError) {
        unrecorded.push(`${step.description} (${messageOf(journalError)})`);
      }
    }
    if (leftovers.length > 0) {
      throw new RollbackFailedError(messageOf(error), leftovers, unrecorded);
    }
    if (unrecorded.length > 0) {
      throw new RollbackNotRecordedError(error, unrecorded, hooks.resuming);
    }
    throw error;
  }
}

/** The resync locks a rename holds. */
interface HeldLocks {
  /** Restarts each lock's staleness clock; throws `IdentityLockLostError` when one was taken over. */
  readonly refresh: () => void;
  readonly release: () => void;
}

/** Takes the resync lock of each identity in `names`, in name order, and returns what refreshes and releases them all. The order does not depend on which name is the old one, so two renames running in opposite directions over the same pair ask for the locks in the same order and cannot each hold one and wait for the other. If one is busy, those already taken are released before its error is thrown. */
function holdLocks(paths: LayoutPaths, names: readonly string[], ports: IdentityRenamePorts): HeldLocks {
  const held: IdentityLock[] = [];
  const release = (): void => {
    for (const lock of [...held].reverse()) {
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
  return {
    refresh: () => {
      for (const lock of held) {
        lock.refresh();
      }
    },
    release,
  };
}

/** What a plan reports: each step's description, then each finisher's. */
function descriptionsOf(plan: Plan): readonly string[] {
  return [...plan.steps.map((step) => step.description), ...plan.finishers.map((finisher) => finisher.description)];
}

/** The unfinished rename, if any, that a rename of `from` to `to` finishes. Throws `UnfinishedRenameError` when one is left that names either identity and is not this rename, and what `readRenameJournals` throws for a journal it cannot read. */
function unfinishedRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): RenameJournal | undefined {
  const found = unfinishedRenameFor(readRenameJournals(ports.fs, paths.identityRenamesDir), from, to);
  if (found?.kind === "blocked") {
    throw new UnfinishedRenameError(from, to, found.journal, finishabilityOf(found.journal, (name) => identityExists(paths, name)));
  }
  return found?.journal;
}

/**
 * Says what `renameIdentity` would do, without doing it or taking a lock: the same checks, which refuse for the same reasons, and the same steps in the same order. The macOS Keychain is asked only for the attributes of the two items, never for a secret, and a cached credential is not read. When an earlier run of this rename was left unfinished it lists what is left, and says so.
 *
 * Throws what `renameIdentity` throws before it changes anything.
 */
export function describeIdentityRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): IdentityRenameReport {
  requireNames(from, to);
  const unfinished = unfinishedRename(paths, from, to, ports);
  const plan = planRename(paths, from, to, ports, undefined, unfinished !== undefined);
  return { from, to, dryRun: true, steps: descriptionsOf(plan), warnings: unfinished === undefined ? plan.notes : [resumeNote(unfinished), ...plan.notes] };
}

/** What a resumed rename tells the person: that it is finishing an earlier one, and that the steps it lists are what that one had left. */
function resumeNote(journal: Readonly<RenameJournal>): string {
  return `This finishes the rename of "${journal.from}" to "${journal.to}" that was left unfinished on ${journal.startedAt}: the steps listed are what was left to do.`;
}

/**
 * Renames identity `from` to `to` without losing its login or anything kept under its name. Takes the resync lock of both names, refuses while a session runs against the identity's directory, then applies, in order: the macOS Keychain login is copied to the service the new directory hashes to; the identity's own `identity.json` and farm record are rewritten; the directory (and any superseded farm beside it) and the stored token file move; the cached credential follows; every reference to the old name is rewritten (pools, jobs, account model refs, directory rules, the active selection, the usage snapshot, recorded picks, anchor stamps); and last, the old Keychain item is deleted once the new one is found. The old name is not kept as an alias: nothing can be running under it, and a stale name would only hide a mistake.
 *
 * It is transactional up to the last step. If any step fails, or the process is sent SIGINT or SIGTERM between steps, every earlier one is undone, the new Keychain item removed and the old one kept, and the failure is thrown. A failure in the last step only (deleting the old Keychain item) is a warning in the report, because the rename is complete by then and the leftover item is harmless.
 *
 * A journal in the state root's `identity-renames` directory is written before the first step and marked as each completes. A rename that is killed, or whose rollback fails, leaves it behind, and running the same rename again plans from what is on disk, so it does only what is left, and removes the journal at the end. A rename of anything else that names either identity refuses until then.
 *
 * Throws `IdentityNotFoundError`, `IdentityAlreadyExistsError`, `InvalidIdentityNameError`, `UsageError` for equal names, `IdentityInUseError`, `UnfinishedRenameError`, `UnfinishableRenameError`, `KeychainLoginError` and `IdentityLockBusyError`. A committed `.agent-shim.json` in a project is not reachable from here, and neither is the usage log, which keeps its records under the name they were written with.
 */
export async function renameIdentity(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): Promise<IdentityRenameReport> {
  requireNames(from, to);
  // Every refusal that needs no secret comes first, so a person is never asked to approve a read for a rename that was going to fail. The plan is made again under the locks, from what is on disk by then.
  const resuming = unfinishedRename(paths, from, to, ports) !== undefined;
  planRename(paths, from, to, ports, undefined, resuming);
  let received: NodeJS.Signals | undefined;
  const stopListening = ports.signals.onInterrupt((signal) => {
    received ??= signal;
  });
  try {
    let gathered: Gathered;
    try {
      gathered = gather(paths, from, to, ports, resuming);
    } catch (error) {
      // Ctrl-C reaches the terminal's whole foreground group, so it also kills the `security` child reading the login: the call returns no status, which reads as a Keychain failure. The handler for the signal runs only once the event loop has turned, so it is let turn before deciding which this was.
      await ports.signals.turn();
      if (received !== undefined) {
        throw new RenameInterruptedError(received, resuming);
      }
      throw error;
    }
    if (received !== undefined) {
      throw new RenameInterruptedError(received, resuming);
    }
    const applied = await applyUnderLocks(paths, from, to, ports, gathered, { interrupted: () => received, turn: ports.signals.turn });
    const warnings = applied.plan.finishers.flatMap((finisher) => finisher.finish() ?? []);
    const notes = applied.resumed === undefined ? applied.plan.notes : [resumeNote(applied.resumed), ...applied.plan.notes];
    return { from, to, dryRun: false, steps: descriptionsOf(applied.plan), warnings: [...notes, ...warnings] };
  } finally {
    stopListening();
  }
}

/** What `discardRenameJournal` removed: the pair whose journal it was. */
export interface DiscardedRenameJournal {
  readonly from: string;
  readonly to: string;
}

/**
 * Removes the journal of an unfinished rename of `from` to `to` that nothing can finish: the identity is under neither name, or under both. It takes the resync lock of both names first, so a process still running that rename, which holds them, is never robbed of its journal, and it changes no identity, file or login. The journal is read again under the locks, so the verdict is of the state it removes.
 *
 * Throws `UsageError` for equal names, `UnsafeNameError` for an old name that would leave the identities directory, `InvalidIdentityNameError` for a new name that is not valid, all before taking a lock, a `CliError` saying there is nothing to discard when the pair has no journal, one saying the rename can be finished when the identity is under exactly one of the names, `IdentityLockBusyError` when the lock of either name is held, and what `readRenameJournal` throws for a journal it cannot read.
 */
export function discardRenameJournal(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): DiscardedRenameJournal {
  requireNames(from, to);
  const held = holdLocks(paths, [from, to], ports);
  try {
    const file = renameJournalFile(paths.identityRenamesDir, from, to);
    if (readRenameJournal(ports.fs, file) === undefined) {
      throw new NoRenameToDiscardError(from, to);
    }
    if (identityExists(paths, from) !== identityExists(paths, to)) {
      throw new FinishableRenameError(from, to);
    }
    removeRenameJournal(ports.fs, file);
    return { from, to };
  } finally {
    held.release();
  }
}

/** What `applyUnderLocks` did: the plan it applied, and the journal of the earlier run it finished, if it finished one. */
interface Applied {
  readonly plan: Plan;
  readonly resumed: RenameJournal | undefined;
}

/**
 * Takes the locks, plans again from what is on disk by then, writes the journal, applies the plan marking each step done, removes the journal and releases the locks. The locks are not held while the old Keychain item is deleted, since that can wait on a person too.
 *
 * The journal is removed when the rename is over, and when a rename that began here has been rolled back completely, since nothing is then left half done. It stays when the rollback failed, and when the run was finishing an earlier rename and failed: the state is then the earlier run's unfinished one, which the journal still describes. A run that finishes an earlier rename keeps that run's done marks and adds its own steps after them, and a rollback marks each step it undoes as not done as it goes, so a journal kept after a failure records the steps still applied. A process killed between an undo and its journal write leaves that step marked, which a re-run is not misled by, since it plans from what is on disk.
 */
async function applyUnderLocks(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, gathered: Gathered, hooks: Pick<ApplyHooks, "interrupted" | "turn">): Promise<Applied> {
  const held = holdLocks(paths, [from, to], ports);
  try {
    const resumed = unfinishedRename(paths, from, to, ports);
    const plan = planRename(paths, from, to, ports, gathered, resumed !== undefined);
    const file = renameJournalFile(paths.identityRenamesDir, from, to);
    // The steps an earlier run applied stay in the journal marked done, ahead of the steps this run has left to do: they are still applied, and a journal kept after this run fails and rolls back must still say so.
    const carried = (resumed?.steps ?? []).filter((step) => step.done);
    const journal: RenameJournal = {
      version: 1,
      from,
      to,
      startedAt: resumed?.startedAt ?? new Date(ports.lock.nowMs()).toISOString(),
      pid: ports.lock.pid,
      steps: [...carried, ...plan.steps.map((step) => ({ description: step.description, done: false }))],
    };
    writeRenameJournal(ports.fs, file, journal);
    const applied = new Set<number>(carried.keys());
    const record = (): void => {
      writeRenameJournal(ports.fs, file, { ...journal, steps: journal.steps.map((step, position) => ({ ...step, done: applied.has(position) })) });
    };
    try {
      await applyAll(plan.steps, {
        ...hooks,
        resuming: resumed !== undefined,
        afterStep: (index) => {
          held.refresh();
          applied.add(carried.length + index);
          record();
        },
        afterUndo: (index) => {
          applied.delete(carried.length + index);
          record();
        },
      });
    } catch (error) {
      // Every step is undone unless the rollback itself failed, so a run that began here leaves nothing half done and its journal goes, whether or not the journal could be kept up to date while it rolled back. A journal that cannot be removed is reported with the failure, never in place of it.
      if (resumed === undefined && !(error instanceof RollbackFailedError)) {
        try {
          removeRenameJournal(ports.fs, file);
        } catch (removal) {
          throw new JournalNotRemovedError(error, file, removal);
        }
      }
      throw error;
    }
    removeRenameJournal(ports.fs, file);
    return { plan, resumed };
  } finally {
    held.release();
  }
}

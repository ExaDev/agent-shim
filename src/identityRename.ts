import os from "node:os";
import path from "node:path";

import { CliError, EXIT_FAILURE, UsageError } from "./cliError";
import { UnsafeNameError, isStoredName } from "./config/names";
import { IdentitySchema, ProviderSchema, isRouterProvider, type CredentialSource } from "./config/schema";
import { effectiveStore, type CachedCredential, type CredentialCachePort } from "./credentialCache";
import { IdentityAlreadyExistsError, identityExists, identityFarmEntries, identityIdExists, identityIdOf, listIdentities, readIdentityById, renamedFarmEntry, requireNewIdentityName, requireNoUnreachableIdentities, sameIdentityName, identityNotFound, displacedIdentity, stateFiledUnderId } from "./identityStore";
import { renamedIdentity, type RenameOptions } from "./identityRenameTarget";
import { identityTokenPath } from "./identityToken";
import type { IdentitySessionProbe, SessionProcess } from "./identitySessions";
import { describeUnfinishable, describeUnfinishedRename, discardJournalCommand, finishabilityOf, readRenameJournal, recordsNothingApplied, readRenameJournals, removeRenameJournal, renameJournalFile, unfinishedRenameFor, writeRenameJournal, type RenameFinishability, type RenameJournal } from "./identityRenameJournal";
import { deleteKeychainLogin, keychainDeleteCommand, planKeychainLogin, readKeychainLogin, writeKeychainLogin, type KeychainLoginPlan } from "./keychainLogin";
import { FARM_MANIFEST_FILENAME, manifestWithIdentity } from "./launcher/farm";
import type { AcquireIdentityLockParams } from "./launcher/lock";
import { holdLocks } from "./identityRenameLocks";
import { removeNameRenameRecord, removeSettledNameRenames, requireNoInterruptedNameRename, unfinishedNameRenames, writeNameRenameRecord } from "./identityNameRenameRecord";
import type { FarmFs, RunPort } from "./launcher/ports";
import { LEGACY_FARM_MANIFEST_FILENAME } from "./legacy";
import { namesMovedPath, placesThroughRealParent, repointedSources, type MovedPaths } from "./renamedCredentialSources";
import type { LayoutPaths } from "./paths";
import { listProviders, providerJsonPath } from "./providersStore";
import { ANTHROPIC_PROVIDER } from "./usage/middleware";
import { FIVE_HOUR_WINDOW_MS } from "./usage/pick";
import { readUsageLog, readUsageSnapshot, snapshotPath, UsageSnapshotError } from "./usage/read";
import { UsageSnapshotSchema } from "./usage/schema";
import { claudeCodeKeychainService, keychainHasItem } from "./usage/signIn";
import { anchorStampStep, configReferenceSteps, credentialCacheStep, jsonRewriteStep, selectionReferenceSteps, textRewriteStep, usageReferenceSteps, type Step } from "./identityRenameSteps";

/** What `moveIdentity` reaches beyond the configuration files it reads through `LayoutPaths`. Injected so a test renames against a temporary root, a fake Keychain and a fake process table, and the library never imports the real ones. */
export interface IdentityRenamePorts {
  /** Moves directories and files, reads and writes the usage files, and takes the resync locks. */
  readonly fs: FarmFs;
  /** Where the identity's cached credential lives, with the platform that picks the default store. */
  readonly credentialCache: { readonly port: CredentialCachePort; readonly platform: NodeJS.Platform };
  /** Runs `security`. Only used when `platform` is `darwin`. */
  readonly run: RunPort;
  /** Runs the attribute-only `security` lookups (which never read a secret, so never wait on a person), stopped at a bound so a hung `security` cannot hold the caller's lock. Only used when `platform` is `darwin`. */
  readonly lookupRun: RunPort;
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
  /** Calls `handler` with the signal's name when the process is sent SIGINT, SIGTERM or SIGHUP, until the returned function is called. */
  readonly onInterrupt: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /** Resolves after the event loop has turned, which is when a signal that arrived during synchronous work reaches its handler. */
  readonly turn: () => Promise<void>;
}

/** Tells which launches are in progress for an identity. Injected so the rename never reads the real launch records in a test. */
export interface IdentityLaunchProbe {
  /** The launchers that are launching `identity` now, in the shape of the sessions found on its directory. */
  readonly liveOn: (identity: string) => readonly SessionProcess[];
}

/** What a rename did, or in a dry run would do, for the command to report. `from` is the identity's name before it, which with `--id` is not the id the command named, and `shared` says another identity also claims that name, so the references to it were left to mean that identity (always false for `--move`, which refuses a shared name). */
export interface IdentityRenameReport {
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
  readonly shared: boolean;
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

/** Raised when state is filed under the id the move would give the identity (see `stateFiledUnderId`), or, on a resumed rename, a token file stands at the new name. Nothing is overwritten. */
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

/** Raised when the new name differs from the old only in case, which a filesystem that ignores case makes one directory, so the two are never both ids whatever the filesystem in use; the Keychain login is filed under the exact spelling of the path. A route through a temporary name is refused for any identity with requests in the usage log, which keeps them under the old id, the new one with case folded, so the message points to the rename without `--move` instead. */
class CaseOnlyMoveError extends CliError {
  constructor(from: string, to: string) {
    super(`"${from}" and "${to}" differ only in case, which a filesystem that ignores case makes one directory, so --move cannot change the case. Rename without --move, which changes the name, case included, and leaves the directory: agent-shim identity rename ${from} ${to}`);
    this.name = "CaseOnlyMoveError";
  }
}

/** Raised when the new name is already an entry of the identities directory that is a link to the old identity's directory, so the directory cannot be moved onto it. */
class LinkToDirectoryError extends CliError {
  constructor(from: string, to: string) {
    super(`"${to}" is a link to the directory of "${from}" (identities/${to}), so --move cannot move onto it; remove the link or choose another name.`);
    this.name = "LinkToDirectoryError";
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

/** Raised when the journal of a rename is asked to be discarded while the identity is under exactly one of its names and either a step is recorded as begun or done or the identity is under the new name, where running the rename again finishes it. `underNew` says which. */
class FinishableRenameError extends CliError {
  constructor(from: string, to: string, underNew: boolean) {
    const why = underNew ? `the identity is already under "${to}"` : "a step is recorded as begun or done";
    super(`The unfinished rename of "${from}" to "${to}" can be finished, so its record is kept: ${why}. Run \`agent-shim identity rename ${from} ${to} --move\` to finish it.`);
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

/** Raised when `--move` is asked for an identity whose directory does not carry its name, as one renamed without `--move` has: the physical rename moves the directory named after the identity, and there is none. */
class DirectoryNotNamedAfterIdentityError extends CliError {
  constructor(name: string, id: string) {
    super(`Identity "${name}" is stored in identities/${id}, not identities/${name}, so --move has no directory of its name to move. Rename it without --move, which changes the name alone.`);
    this.name = "DirectoryNotNamedAfterIdentityError";
  }
}

/**
 * The checks that read the machine's state. `from` must name an identity whose directory has its name, and `to` must be free in every place its name would be filed: no identity may be named it, and nothing may stand in its directory. When `resuming` a rename that was left unfinished, the identity is wherever the earlier run got it to, under either name, and the places already moved are no clash; an identity under neither name or under both cannot be finished and throws `UnfinishableRenameError`.
 */
function requireRenamable(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, resuming: boolean): void {
  if (resuming) {
    const underFrom = identityIdExists(paths, from);
    const underTo = identityIdExists(paths, to);
    if (underFrom === underTo) {
      throw new UnfinishableRenameError(from, to, underFrom);
    }
    return;
  }
  const id = identityIdOf(paths, from);
  if (id === undefined) {
    throw identityNotFound(paths, from);
  }
  if (id !== from) {
    throw new DirectoryNotNamedAfterIdentityError(from, id);
  }
  // A record read from a superseded farm has no identity.json in the directory to move.
  if (!identityIdExists(paths, id)) {
    throw displacedIdentity(paths, "moved", from, id);
  }
  // The new id may not differ from the old one only in case: that is one directory on a filesystem that ignores case.
  if (from.toLowerCase() === to.toLowerCase()) {
    throw new CaseOnlyMoveError(from, to);
  }
  if (ports.sameDirectory(path.join(paths.identitiesDir, from), path.join(paths.identitiesDir, to))) {
    throw new LinkToDirectoryError(from, to);
  }
  if (identityExists(paths, to)) {
    throw new IdentityAlreadyExistsError(to);
  }
  // The identity takes `to` as its id, so anything filed under it (another id's directory, stray file or farm under any case, a resync lock under another spelling, a token file, a cached credential, a usage snapshot, usage-log records, or another identity whose cached credential the file store would file in the same file) would be read as its own: the test `identity add` makes of an id.
  const taken = stateFiledUnderId(paths, to, { run: ports.run, platform: ports.platform }, from);
  if (taken !== undefined) {
    throw new RenameTargetTakenError(`"${to}" is already in use: ${taken}.`);
  }
}

/** Raised when a file that holds credential sources cannot be read and names a path or the Keychain login the rename would move, so it cannot be re-pointed and would be left broken. Nothing has been changed. */
class UnreadableCredentialFileError extends CliError {
  constructor(file: string, detail: string) {
    super(`Cannot rename: ${file} cannot be read (${detail}) and names a path or the Keychain login this rename moves, so it could not be updated. Fix or remove it, then run the command again; nothing was changed.`);
    this.name = "UnreadableCredentialFileError";
  }
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
function keychainPlan(ports: IdentityRenamePorts, login: GatheredLogin | undefined, toDir: string, from: string): { readonly step: Step | undefined; readonly finisher: Finisher } | undefined {
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
        const remove = keychainDeleteCommand(plan.fromService, plan.account);
        if (!keychainHasItem(ports.run, toDir)) {
          return `The new Keychain login "${plan.toService}" could not be found after the rename, so the former one "${plan.fromService}" was kept. Look at the new one before deleting the old with \`${remove}\`.`;
        }
        try {
          deleteKeychainLogin(ports.run, plan.fromService, plan.account);
        } catch (error) {
          return `The former Keychain login "${plan.fromService}" could not be deleted (${error instanceof Error ? error.message : String(error)}). The renamed identity does not use it, but a new identity created under the name "${from}" would start signed in as that account, so \`identity add ${from}\` refuses until it is deleted: delete it with \`${remove}\`.`;
        }
        return undefined;
      },
    },
  };
}

/** The step that moves identity `from`'s usage snapshot, filed under its id, to the new id `to` with the id inside it (a `--move` changes the id); a snapshot already under `to` refuses the move before this step (see `stateFiledUnderId`), so one can stand there only on a resumed rename. */
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
 * A note for the person when the usage log holds requests of identity `from` from the current five-hour window, which the move leaves under that id. The log is append-only with one writer per segment, and the front door that writes it is running, so rewriting a segment from here would race its appends and lose records. Pool ranking reads those records for a member's burn rate and five-hour to seven-day ratio, so the renamed member has neither from them until the window passes; its quota windows come from its snapshot, which moves with it.
 */
function usageWindowNote(paths: LayoutPaths, ports: IdentityRenamePorts, from: string, to: string): string | undefined {
  const windowStartMs = ports.lock.nowMs() - FIVE_HOUR_WINDOW_MS;
  const { records } = readUsageLog(ports.fs, paths.usageLogDir, { sinceMs: windowStartMs });
  const logged = records.some((record) => record.identity === from && record.provider === ANTHROPIC_PROVIDER && Date.parse(record.at) >= windowStartMs);
  return logged
    ? `Usage already logged for "${from}" in the last five hours stays filed under that id: the usage log is appended to by the running front door, so it is not rewritten. Until those hours pass, pool ranking has no burn rate or five-hour to seven-day ratio for "${to}" from them. Its quota windows come from its snapshot, which moved, and are unaffected.`
    : undefined;
}

/** The steps that re-point the credential `file` sources of every identity but the renamed one, and of every provider, that name the token file or sit inside the directory being moved. A file that cannot be parsed and names a moved path is refused, since it can be neither updated nor trusted. */
function credentialHolderSteps(paths: LayoutPaths, ports: IdentityRenamePorts, from: string, to: string, moved: MovedPaths): readonly (Step | undefined)[] {
  // An identity nobody can read is left out of the listing, so its credential sources could be neither re-pointed nor checked; refusing is what reading it did before it was reported apart.
  requireNoUnreachableIdentities(paths, `rename "${from}" to "${to}"`, "a credential source in it that names what the rename moves could be neither updated nor warned about");
  const refuseIfNamed = (file: string, detail: string): void => {
    const text = ports.fs.readFileUtf8(file);
    if (text !== undefined && namesMovedPath(text, moved)) {
      throw new UnreadableCredentialFileError(path.relative(paths.root, file), detail);
    }
  };
  const identitySteps = listIdentities(paths)
    .filter((entry) => entry.id !== from)
    .map((entry) => {
      const file = path.join(paths.identitiesDir, entry.id, "identity.json");
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
  const identities = listIdentities(paths).flatMap((entry) => entry.identity?.credential?.sources.flatMap((source) => noteFor(`Identity "${entry.id === from ? to : entry.name}"`, source)) ?? []);
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
  const cache = readIdentityById(paths, currentName(paths, from, to))?.credential?.cache;
  return {
    login: plan === undefined ? undefined : { plan, bytes: plan.alreadyCopied ? undefined : readKeychainLogin(ports.run, plan) },
    cached: cache === undefined ? undefined : ports.credentialCache.port.read(effectiveStore(cache, ports.credentialCache.platform), `identity ${from}`),
  };
}

/** The directory the identity is in now: `from`, or `to` when an earlier run of this rename had already moved it. A partly applied rename can leave the name in `identity.json` and the directory disagreeing, so this asks the directories. */
function currentName(paths: LayoutPaths, from: string, to: string): string {
  return identityIdExists(paths, from) ? from : to;
}

/** Throws `IdentityInUseError` when a session is running against `from`'s directory, or a launch of it is between its farm resync and its spawn. */
function requireNoSessions(paths: LayoutPaths, from: string, ports: IdentityRenamePorts): void {
  const directory = path.join(paths.identitiesDir, from);
  const using = [...ports.sessions.sessionsOn(directory), ...ports.launches.liveOn(from)];
  if (using.length > 0) {
    throw new IdentityInUseError(from, directory, using);
  }
}

/** Builds the plan: every check that needs neither a lock nor a secret, then every step in the order it is applied. The order puts what can fail for reasons outside the files first and the Keychain's old item last, and rewrites the identity's own files before the directory moves so each path is read where it is. */
function planRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, gathered: Gathered | undefined, resuming: boolean): Plan {
  // A rename of the name alone left half done has rewritten references to its new name; moving either identity now would leave them pointing at a name nothing can finish.
  for (const held of new Set([from, to])) {
    requireNoInterruptedNameRename(paths, held, `rename "${from}" to "${to}" with --move`);
  }
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
  const identity = readIdentityById(paths, currentName(paths, from, to));
  if (identity === undefined) {
    throw identityNotFound(paths, from);
  }

  const moved: MovedPaths = { tokens: placesThroughRealParent({ from: fromToken, to: toToken }, ports.realpath), directories: placesThroughRealParent({ from: fromDir, to: toDir }, ports.realpath), fromService: claudeCodeKeychainService(fromDir), toService: claudeCodeKeychainService(toDir), home: ports.home };
  const keychain = keychainPlan(ports, gathered === undefined ? dryRunLogin(ports, fromDir, toDir, resuming) : gathered.login, toDir, from);
  const farmFiles = [FARM_MANIFEST_FILENAME, LEGACY_FARM_MANIFEST_FILENAME].map((name) => path.join(identityDir, name));
  const cacheStore = identity.credential?.cache === undefined ? undefined : effectiveStore(identity.credential.cache, ports.credentialCache.platform);
  // A credential the file store holds for the identity is moved with it whatever its credential block says: caching may be off now, or on in the Keychain, with an entry left in the file from before. It is read through the same port as the configured store's.
  const orphanedFileEntry = cacheStore === "file" ? undefined : ports.credentialCache.port.read("file", `identity ${from}`);
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
    cacheStore === undefined && orphanedFileEntry === undefined
      ? undefined
      : credentialCacheStep(ports.credentialCache.port, from, to, [
          ...(cacheStore === undefined ? [] : [{ store: cacheStore, cached: gathered?.cached }]),
          ...(orphanedFileEntry === undefined ? [] : [{ store: "file" as const, cached: orphanedFileEntry }]),
        ]),
    ...configReferenceSteps(paths, ports, from, to),
    ...credentialHolderSteps(paths, ports, from, to, moved),
    ...selectionReferenceSteps(paths, ports, from, to),
    snapshotStep(paths, ports, from, to),
    ...usageReferenceSteps(paths, ports, from, to),
    anchorStampStep(paths, ports, from, to),
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

/** Raised when the process was sent SIGINT, SIGTERM or SIGHUP while the rename was applying its steps. Everything this run did has been undone. The exit status is the shell's convention for a process ended by that signal. */
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
  return `The journal under identity-renames/ could not be updated for ${unrecorded.join("; ")}, so it may still show steps as begun or done that were undone; a run of the same rename plans from what is on disk and is not misled by it.`;
}

/** Raised when the rollback after a failed step could not undo everything: the first failure, and what was left. `unrecorded` names the steps that were undone but whose journal update failed, when any. */
class RollbackFailedError extends CliError {
  constructor(cause: string, leftovers: readonly string[], unrecorded: readonly string[]) {
    super(`${cause}\nRolling back also failed, so the rename is partly done: ${leftovers.join("; ")}. Look at the steps named before running anything else.${unrecorded.length === 0 ? "" : `\n${unrecordedSentence(unrecorded)}`}`);
    this.name = "RollbackFailedError";
  }
}

/**
 * Raised when the journal could not be written ahead of a step, after one, or before the first, so the rename went no further. `where` says which write, `failure` is what the filesystem said, and `outcome` says what the rollback left once it has finished (see `rolledBackOutcome`); it is absent while the rollback is still to be done, which is how an error that reaches `applyAll` is told from one it has already finished.
 */
class JournalWriteError extends CliError {
  constructor(readonly failure: unknown, readonly where: string, readonly outcome?: string) {
    super(`The journal under identity-renames/ could not be written ${where} (${messageOf(failure)}), so the rename went no further${outcome === undefined ? "" : `: ${outcome}`}.`);
    this.name = "JournalWriteError";
  }

  /** The same error with the outcome of the rollback that followed it. */
  withOutcome(outcome: string): JournalWriteError {
    return new JournalWriteError(this.failure, this.where, outcome);
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

/** Raised when a rename was rolled back, or failed, and its journal could not be removed: the failure that ended the rename leads and keeps its exit status, and the journal is left. `discard` is the command that removes the record when the journal records no step as begun or done, which is the case for a rollback that completed: running the rename again would then perform the rename that was just cancelled, so the way out is to discard the record. Otherwise a re-run of the same rename carries on from the journal. */
class JournalNotRemovedError extends CliError {
  override readonly exitCode: number;

  constructor(cause: unknown, file: string, removal: unknown, discard: string | undefined) {
    const consequence = "so it still describes this rename as unfinished and stops any other rename of either name";
    const way = discard === undefined ? "running the same command again finishes it" : `the rename was rolled back and the journal records no step as begun or done, so discard the record with \`${discard}\`; running the rename again would perform it`;
    super(`${messageOf(cause)}\nThe journal ${path.join("identity-renames", path.basename(file))} could not be removed (${messageOf(removal)}), ${consequence}; ${way}.`);
    this.name = "JournalNotRemovedError";
    this.exitCode = cause instanceof CliError ? cause.exitCode : EXIT_FAILURE;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the apply loop does between steps. */
interface ApplyHooks {
  /** Called before each step runs, with its position in the plan: the journal records the step as begun here, ahead of it, so that a process that dies after the step took effect and before `afterStep` marks it leaves a record that it may have. The step does not run if this throws. */
  readonly beforeStep: (index: number) => void;
  /** Called after each step with its position in the plan: the locks are refreshed and the journal marked here, and the call throws when a lock was taken over. */
  readonly afterStep: (index: number) => void;
  /** Called after each step is undone during a rollback, with its position in the plan: the journal clears both of the step's marks (begun and done) here, so that it records only the steps that may still be applied. */
  readonly afterUndo: (index: number) => void;
  /** Whether this run finishes a rename an earlier one left unfinished, which an interruption's message says. */
  readonly resuming: boolean;
  /** The signal the process received, if it has received one. */
  readonly interrupted: () => NodeJS.Signals | undefined;
  /** Lets the event loop turn, so that a signal that arrived during the last step is delivered to its handler. */
  readonly turn: () => Promise<void>;
}

/**
 * Applies the steps in order. Before each step the event loop is let turn and the process is checked for a SIGINT, SIGTERM or SIGHUP, and after each the locks are refreshed; a signal during the last step lets the rename finish, since there is nothing left to undo. If a step, the refresh or an interrupt fails the rename, every step applied so far, the failing one included, is undone in reverse order and the failure is thrown.
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
      hooks.beforeStep(index);
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
    throw error instanceof JournalWriteError && error.outcome === undefined ? error.withOutcome(rolledBackOutcome(hooks.resuming)) : error;
  }
}

/** What a plan reports: each step's description, then each finisher's. */
function descriptionsOf(plan: Plan): readonly string[] {
  return [...plan.steps.map((step) => step.description), ...plan.finishers.map((finisher) => finisher.description)];
}

/** The unfinished rename, if any, that a rename of `from` to `to` finishes. Throws `UnfinishedRenameError` when one is left that names either identity and is not this rename, and what `readRenameJournals` throws for a journal it cannot read. */
function unfinishedRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): RenameJournal | undefined {
  const found = unfinishedRenameFor(readRenameJournals(ports.fs, paths.identityRenamesDir), from, to, (first, second) => sameIdentityName(paths, first, second));
  if (found?.kind === "blocked") {
    throw new UnfinishedRenameError(from, to, found.journal, finishabilityOf(found.journal, (name) => identityIdExists(paths, name)));
  }
  return found?.journal;
}

/**
 * Says what `moveIdentity` would do (`identity rename --move --dry-run`), without doing it or taking a lock: it makes every check a rename makes that needs neither a lock nor a secret, so it refuses for those reasons, and it lists the same steps in the same order. The macOS Keychain is asked only for the attributes of the two items, never for a secret, and a cached credential is not read, so what only the real run can refuse on is not checked: a lock another process holds, a login that cannot be read or is too long for one `security -i` line, and a cached credential that cannot be read. When an earlier run of this rename was left unfinished it lists what is left, and says so.
 *
 * Throws what `moveIdentity` throws for a refusal that needs neither a lock nor a secret.
 */
export function describeIdentityMove(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): IdentityRenameReport {
  requireNames(from, to);
  const unfinished = unfinishedRename(paths, from, to, ports);
  const plan = planRename(paths, from, to, ports, undefined, unfinished !== undefined);
  return { from, to, dryRun: true, shared: false, steps: descriptionsOf(plan), warnings: unfinished === undefined ? plan.notes : [resumeNote(unfinished), ...plan.notes] };
}

/** What a resumed rename tells the person: that it is finishing an earlier one, and that the steps it lists are what that one had left. */
function resumeNote(journal: Readonly<RenameJournal>): string {
  return `This finishes the rename of "${journal.from}" to "${journal.to}" that was left unfinished on ${journal.startedAt}: the steps listed are what was left to do.`;
}

/**
 * Renames identity `from` to `to` and moves its directory with it (`identity rename --move`), without losing its login or anything kept under its name or its id. The identity's directory must carry its name, as it does unless the identity was created under `<name>-<n>` or renamed without `--move`; the directory moves to `to`, so the identity's id becomes `to` as well. Takes the identity names lock and then the resync lock of both names, refuses while a session runs against the identity's directory, then applies, in order: the macOS Keychain login is copied to the service the new directory hashes to; the identity's own `identity.json` and farm record are rewritten; the directory (and any superseded farm beside it) and the stored token file move; the cached credential follows when it is its own or was cached before owners were recorded (never one recorded for another identity whose id names the same file); every reference to the old name is rewritten (pools, jobs, account model refs, directory rules, the active selection, the usage snapshot, recorded picks, anchor stamps); and last, the old Keychain item is deleted once the new one is found. The old name is not kept as an alias: nothing can be running under it, and a stale name would only hide a mistake.
 *
 * It is transactional up to the last step. If any step fails, or the process is sent SIGINT, SIGTERM or SIGHUP between steps, every earlier one is undone, the new Keychain item removed and the old one kept, and the failure is thrown. A failure in the last step only (deleting the old Keychain item) is a warning in the report, because the rename is complete by then. The leftover item is not used by the renamed identity, but a new identity created under the old name would start signed in as that account, so `identity add` refuses that name until the item is deleted or `--keep-keychain-login` says the login is wanted, and the warning says so and gives the command.
 *
 * A journal in the state root's `identity-renames` directory is written before the first step, each step is marked as begun before it runs and as done as it completes, and every save is flushed to disk. A rename that is killed, or whose rollback fails, leaves it behind, and running the same rename again plans from what is on disk, so it does only what is left, and removes the journal at the end. A rename of anything else that names either identity refuses until then.
 *
 * Throws `IdentityNotFoundError`, `IdentityAlreadyExistsError`, `InvalidIdentityNameError`, `UsageError` for equal names, `IdentityInUseError`, `UnfinishedRenameError`, `UnfinishableRenameError`, `KeychainLoginError`, `IdentityLockBusyError`, and a `CliError` when the identity's directory does not carry its name, when the new name differs from the old only in case, when the new name is a link to the identity's directory, or when state is filed under the new id (see `stateFiledUnderId`). A committed `.agent-shim.json` in a project is not reachable from here, and neither is the usage log, which keeps its records under the id they were written with.
 */
export async function moveIdentity(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): Promise<IdentityRenameReport> {
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
    return { from, to, dryRun: false, shared: false, steps: descriptionsOf(applied.plan), warnings: [...notes, ...warnings] };
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
 * Removes the journal of an unfinished rename of `from` to `to` when the identity is under neither name or under both, or when it is under `from` alone and the journal records no step as begun or done (a step is recorded as begun before it runs, so a process killed mid-step is not taken for one that applied nothing). It refuses when the identity is under exactly one name and either a step is recorded as begun or done or the identity is under `to`, where running the rename again finishes it. It takes the resync lock of both names first, so a process still running that rename, which holds them, is never robbed of its journal, and it changes no identity, file or login. The journal is read again under the locks, so the verdict is of the state it removes.
 *
 * Throws `UsageError` for equal names, `UnsafeNameError` for an old name that would leave the identities directory, `InvalidIdentityNameError` for a new name that is not valid, all before taking a lock, a `CliError` saying there is nothing to discard when the pair has no journal, one saying the rename can be finished when the identity is under exactly one of the names and either a step is recorded as begun or done or the identity is under `to`, `IdentityLockBusyError` when the lock of either name is held, and what `readRenameJournal` throws for a journal it cannot read.
 */
export function discardRenameJournal(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts): DiscardedRenameJournal {
  requireNames(from, to);
  const held = holdLocks(paths, () => ({ names: [from, to], value: undefined }), ports);
  try {
    const file = renameJournalFile(paths.identityRenamesDir, from, to);
    const journal = readRenameJournal(ports.fs, file);
    if (journal === undefined) {
      throw new NoRenameToDiscardError(from, to);
    }
    // Under one name only, a re-run finishes the rename, unless the journal records no step as begun or done and the identity is still under the old name: that is a rename rolled back completely, or ended before its first step.
    const finishability = finishabilityOf(journal, (name) => identityIdExists(paths, name));
    if (finishability.finishable && finishability.discardable !== true) {
      throw new FinishableRenameError(from, to, identityIdExists(paths, to));
    }
    removeRenameJournal(ports.fs, file);
    return { from, to };
  } finally {
    held.release();
  }
}

/** Whether the journal now in `file` records no step as begun or done. A journal that cannot be read is not known to, since the failure being reported is the one that matters and this only chooses the words after it. */
function recordsNothingAppliedOn(ports: IdentityRenamePorts, file: string): boolean {
  try {
    const journal = readRenameJournal(ports.fs, file);
    return journal !== undefined && recordsNothingApplied(journal);
  } catch {
    return false;
  }
}

/** What `applyUnderLocks` did: the plan it applied, and the journal of the earlier run it finished, if it finished one. */
interface Applied {
  readonly plan: Plan;
  readonly resumed: RenameJournal | undefined;
}

/**
 * Takes the locks, plans again from what is on disk by then, writes the journal, applies the plan marking each step as begun before it runs and as done after, removes the journal and releases the locks. The locks are not held while the old Keychain item is deleted, since that can wait on a person too.
 *
 * The journal is removed when the rename is over, and when a rename that began here has been rolled back completely, since nothing is then left half done. It stays when the rollback failed, and when the run was finishing an earlier rename and failed: the state is then the earlier run's unfinished one, which the journal still describes. A run that finishes an earlier rename keeps that run's done marks and adds its own steps after them, and a rollback clears the marks of each step it undoes as it goes, so a journal kept after a failure records the steps that may still be applied. A process killed between a step taking effect and its being marked done leaves it marked as begun, and one killed between an undo and its journal write leaves the step marked; a re-run is not misled by either, since it plans from what is on disk.
 */
async function applyUnderLocks(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, gathered: Gathered, hooks: Pick<ApplyHooks, "interrupted" | "turn">): Promise<Applied> {
  const held = holdLocks(
    paths,
    () => {
      // The real run clears a record of a rename of the name alone that holds nothing, under the names lock; the dry run (`describeIdentityMove`) only leaves it out.
      removeSettledNameRenames(paths);
      return { names: [from, to], value: undefined };
    },
    ports,
  );
  try {
    const resumed = unfinishedRename(paths, from, to, ports);
    const plan = planRename(paths, from, to, ports, gathered, resumed !== undefined);
    const file = renameJournalFile(paths.identityRenamesDir, from, to);
    // The steps an earlier run applied stay in the journal with their marks, ahead of the steps this run has left to do: they are still applied, and a journal kept after this run fails and rolls back must still say so. A step the earlier run began and did not mark done is kept only when this run's plan no longer lists it, which is when its effect is on disk; one the plan lists again is this run's to begin.
    const planned = new Set(plan.steps.map((step) => step.description));
    const carried = (resumed?.steps ?? []).filter((step) => step.done || (step.started && !planned.has(step.description)));
    const marks: { started: boolean; done: boolean }[] = [...carried.map((step) => ({ started: true, done: step.done })), ...plan.steps.map(() => ({ started: false, done: false }))];
    const descriptions = [...carried.map((step) => step.description), ...plan.steps.map((step) => step.description)];
    const startedAt = resumed?.startedAt ?? new Date(ports.lock.nowMs()).toISOString();
    const record = (): void => {
      writeRenameJournal(ports.fs, file, { version: 1, from, to, startedAt, pid: ports.lock.pid, steps: descriptions.map((description, position) => ({ description, started: marks[position]?.started === true, done: marks[position]?.done === true })) });
    };
    // A step's position in the journal is after the steps carried from the earlier run.
    const positionOf = (index: number): number => carried.length + index;
    const markOf = (index: number): { started: boolean; done: boolean } => {
      const mark = marks[positionOf(index)];
      if (mark === undefined) {
        throw new Error(`no step at position ${String(index)}`);
      }
      return mark;
    };
    /** Saves the journal at one point of a step, reporting a failure as a `JournalWriteError` that names the step. */
    const save = (index: number, when: "ahead of" | "after"): void => {
      try {
        record();
      } catch (failure) {
        throw new JournalWriteError(failure, `${when} "${descriptions[positionOf(index)] ?? String(index)}"`);
      }
    };
    try {
      try {
        record();
      } catch (failure) {
        // Nothing has run, so this run changed nothing. The file may still have landed, though: it is renamed into place before the directory is flushed, and a flush that fails leaves a complete journal behind, which the catch below removes for a run that began here (an earlier run's journal, for one that is resuming, stays and describes the state it left).
        throw new JournalWriteError(failure, "before the first step", rolledBackOutcome(resumed !== undefined));
      }
      await applyAll(plan.steps, {
        ...hooks,
        resuming: resumed !== undefined,
        beforeStep: (index) => {
          const mark = markOf(index);
          mark.started = true;
          try {
            save(index, "ahead of");
          } catch (error) {
            // The step does not run, so it must not be left marked as begun for a later write of the journal to save.
            mark.started = false;
            throw error;
          }
        },
        afterStep: (index) => {
          held.refresh();
          markOf(index).done = true;
          save(index, "after");
        },
        afterUndo: (index) => {
          const mark = markOf(index);
          mark.started = false;
          mark.done = false;
          record();
        },
      });
    } catch (error) {
      // Every step is undone unless the rollback itself failed, so a run that began here leaves nothing half done and its journal goes, whether or not the journal could be kept up to date while it rolled back. A journal that cannot be removed is reported with the failure, never in place of it.
      if (resumed === undefined && !(error instanceof RollbackFailedError)) {
        try {
          removeRenameJournal(ports.fs, file);
        } catch (removal) {
          throw new JournalNotRemovedError(error, file, removal, recordsNothingAppliedOn(ports, file) ? discardJournalCommand({ from, to }) : undefined);
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

/** The step that writes the new name into the `identity.json` of id `id`, last in a rename of the name alone. It fails, so the references already rewritten are rolled back, when that file has gone by the time it runs: a rename whose identity vanished must not report success. Undefined when the file already holds the new name. */
function nameStep(paths: LayoutPaths, ports: IdentityRenamePorts, id: string, from: string, to: string): Step | undefined {
  const step = jsonRewriteStep(paths, ports, path.join(paths.identitiesDir, id, "identity.json"), IdentitySchema, (stored) => (stored.name === to ? undefined : { value: { ...stored, name: to }, changes: ["name"] }));
  return step === undefined
    ? undefined
    : {
        description: step.description,
        apply: () => {
          if (!identityIdExists(paths, id)) {
            throw identityNotFound(paths, from);
          }
          step.apply();
        },
        undo: step.undo,
      };
}

/** The checks of a rename of the name alone, and its plan: `to` must have the shape a new identity is given and be no identity's name, `from` must name an identity, and no unfinished physical rename may name either, since it is moving one of them. The steps rewrite every reference to the name and, last, the name in the identity's own `identity.json`: a run that is killed part way leaves the references it reached pointing at a name nothing has yet, and running it again plans from what is on disk, finds the identity still under `from` and does what is left. */
function planNameChange(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, options: RenameOptions): Plan & { readonly name: string; readonly shared: boolean } {
  requireNames(from, to);
  const { id, name, shared } = renamedIdentity(paths, from, options);
  for (const held of new Set([name, id])) {
    const found = unfinishedRenameFor(readRenameJournals(ports.fs, paths.identityRenamesDir), held, to, (first, second) => sameIdentityName(paths, first, second));
    if (found !== undefined) {
      throw new UnfinishedRenameError(held, to, found.journal, finishabilityOf(found.journal, (candidate) => identityIdExists(paths, candidate)));
    }
  }
  if (identityExists(paths, to)) {
    throw new IdentityAlreadyExistsError(to);
  }
  // An interrupted rename of the name alone that is not this one holds its names: only running it again resumes it.
  for (const held of new Set([name, to])) {
    requireNoInterruptedNameRename(paths, held, `rename "${name}" to "${to}"`, { id, from: name, to });
  }
  // A name another identity also claims names neither of them, so a reference to it is not this identity's to carry away: it is left to mean the identity that keeps the name.
  const steps: (Step | undefined)[] = [
    ...(shared ? [] : [...configReferenceSteps(paths, ports, name, to), ...selectionReferenceSteps(paths, ports, name, to), ...usageReferenceSteps(paths, ports, name, to)]),
    nameStep(paths, ports, id, name, to),
  ];
  return { steps: steps.filter((step): step is Step => step !== undefined), finishers: [], notes: [], name, shared };
}

/**
 * Says what `renameIdentity` would do, without doing it or taking a lock: the same checks and the same steps in the same order.
 *
 * Throws what `renameIdentity` throws for a refusal that needs no lock.
 */
export function describeIdentityRename(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, options: RenameOptions = {}): IdentityRenameReport {
  const plan = planNameChange(paths, from, to, ports, options);
  return { from: plan.name, to, dryRun: true, shared: plan.shared, steps: descriptionsOf(plan), warnings: [] };
}

/**
 * Renames identity `from` (with `options.byId`, the identity stored under id `from`) to `to` by changing its name and every reference to it, and nothing else: the pools (nested pool refs and members with a `when` included), jobs and account model refs of the global configuration and of every profile, the directory rules, the active selection, and the recorded pool picks, and the `name` in the identity's own `identity.json`. When another identity also claims the name, only that `name` changes and the references stay, since they cannot be told apart. The identity keeps its id, so its directory, the `CLAUDE_CONFIG_DIR` every session holds, the macOS Keychain login filed under that path, its usage snapshot and usage log records, the window keeper's anchor stamp, its token file and its cached credential stay where they are and stay valid. That is why it takes no Keychain action and goes ahead while sessions run on the identity: they keep running against the same directory and their usage keeps being filed under the same id.
 *
 * It makes every refusal that needs no lock first, then takes the identity names lock, removes there any record under `identity-name-renames/` that holds nothing any more (a refused run leaves such records to the next add, remove or rename that acts) and resolves the identity's id, then takes that id's resync lock, so no add, remove or other rename changes which identity holds which name meanwhile, the lock it holds is the resync lock of the identity it renames, and it never runs beside a `--move` or a resync of that identity; it plans again under them from what is on disk. Before the first step it writes a record of the rename under `identity-name-renames/`, which makes `identity add` of either name, `identity remove` of the identity, another rename of either name and `--move` of either refuse until it is removed; it is removed once the rename ends or every step has been undone, and kept when the rollback itself fails. A failing step, or SIGINT, SIGTERM or SIGHUP between steps, undoes the steps already applied in reverse. It keeps no journal: the name in `identity.json` is rewritten last, so a run killed part way leaves the identity under `from` with some references already naming `to` and its record in place, and running the same rename again does what is left and removes the record.
 *
 * Throws `UsageError` for equal names, `UnsafeNameError` for an old name that would leave the identities directory, `InvalidIdentityNameError` for a new name that is not valid, `IdentityNotFoundError` when no identity is named (or, with `byId`, stored under) `from` or its `identity.json` has gone by the time the name is written, `NamelessIdentityError` for an identity addressed by id whose name cannot be read, `DisplacedIdentityError` for one whose `identity.json` an interrupted resync left only in a superseded farm, `DuplicateIdentityNameError` when two identities claim `from`, `IdentityAlreadyExistsError` when an identity is already named `to`, a `CliError` naming the command that finishes an unfinished `--move` of either name, `InterruptedNameRenameError` when another interrupted rename of the name alone holds either name, `IdentityLockBusyError` (or `IdentityNamesLockBusyError`) when a lock stays held, the step's own error after a failed step is undone, `RenameInterruptedError` after a signal, and `RollbackFailedError` when undoing fails.
 */
export async function renameIdentity(paths: LayoutPaths, from: string, to: string, ports: IdentityRenamePorts, options: RenameOptions = {}): Promise<IdentityRenameReport> {
  // Every refusal that needs no lock comes first; everything is resolved again under the locks, from what is on disk by then.
  planNameChange(paths, from, to, ports, options);
  // The id is resolved under the names lock and its resync lock taken after it, so an add or remove while this waited for the lock cannot leave it holding one id's lock and renaming another. A rename killed after its last step, or one whose identity has gone, leaves a record that holds nothing; the real run clears it there, under the names lock, while the dry run leaves it.
  const held = holdLocks(
    paths,
    () => {
      removeSettledNameRenames(paths);
      const { id: resolvedId } = renamedIdentity(paths, from, options);
      return { names: [resolvedId], value: resolvedId };
    },
    ports,
  );
  const id = held.value;
  // The handler is installed only once the locks are held, inside the try whose finally removes it, so a refusal while taking them leaves none behind.
  let received: NodeJS.Signals | undefined;
  const stopListening = ports.signals.onInterrupt((signal) => {
    received ??= signal;
  });
  try {
    const plan = planNameChange(paths, from, to, ports, options);
    const resumed = unfinishedNameRenames(paths).find((record) => record.id === id && record.from === plan.name && record.to === to);
    // The record is written before the first rewrite and removed once nothing is left half done (the rename ended, or a rename that began here had every step undone), so a record that survives is the trace of a run killed part way, which `identity add` and another rename then refuse to build on.
    writeNameRenameRecord(paths, { version: 1, id, from: plan.name, to, startedAt: resumed?.startedAt ?? new Date(ports.lock.nowMs()).toISOString() });
    try {
      await applyAll(plan.steps, {
        resuming: resumed !== undefined,
        interrupted: () => received,
        turn: ports.signals.turn,
        beforeStep: () => undefined,
        afterStep: (index) => {
          if (index < plan.steps.length - 1) {
            held.refresh();
          }
        },
        afterUndo: () => undefined,
      });
    } catch (error) {
      if (resumed === undefined && !(error instanceof RollbackFailedError)) {
        removeNameRenameRecord(paths, plan.name, to);
      }
      throw error;
    }
    removeNameRenameRecord(paths, plan.name, to);
    return { from: plan.name, to, dryRun: false, shared: plan.shared, steps: descriptionsOf(plan), warnings: [] };
  } finally {
    held.release();
    stopListening();
  }
}

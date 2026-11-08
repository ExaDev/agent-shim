import fs from "node:fs";
import path from "node:path";
import { noteLocalWork } from "./blockingSteps";
import { ConfigFileNotJsonError, ConfigValidationError } from "./config/load";
import { FileNameSchema, UnsafeNameError, isStoredName } from "./config/names";
import { applyPatch, nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { IdentitySchema, type Anchor, type CredentialCache, type CredentialSource, type CredentialTarget, type Identity } from "./config/schema";
import { CliError, UsageError } from "./cliError";
import { poolNameOf } from "./launcher/identity";
import { requirePool } from "./poolStore";
import type { LayoutPaths } from "./paths";
import { readUsageLog, readUsageSnapshot, snapshotPath, type UsageReadFs } from "./usage/read";
import { identityCacheKey } from "./credential";
import { identityTokenPath } from "./identityToken";
import { cacheFileNameFor, createRealCredentialCache } from "./realCredentialCache";
import type { UsageSnapshot } from "./usage/schema";
import { acquireIdentityLock, IdentityLockBusyError, identityLockPath, type IdentityLock } from "./launcher/lock";
import { realIdentityNamesLockPorts, withIdentityNamesLock, type IdentityNamesLockPorts } from "./identityNamesLock";
import { missingIdentityRemedy, removeSettledNameRenames, requireNoInterruptedNameRename } from "./identityNameRenameRecord";
import { requireNameFreeOfUnfinishedRename } from "./identityRenameJournal";
import { keychainCacheEntryExists, requireNoLeftoverKeychainLogin, type KeychainProbe } from "./keychainLogin";
import { ignoresCase, sameDirectory, systemErrorCode, UNREACHABLE_CODES } from "./sameDirectory";
import { FARM_SUFFIX_PATTERN, IDENTITY_FILE, freeIdentityId, identityIdIn, identityNameIn, readIdentityRecords, textRecordsPort, type IdentityRecord } from "./identityRecords";
import { liveLaunchesOn } from "./launcher/launchRecords";

/** Raised by any operation that requires an identity to already exist, when it does not. `remedy` says what to do, adding the identity unless given (`identityNotFound` gives it from the state on disk). */
export class IdentityNotFoundError extends CliError {
  constructor(
    readonly name: string,
    remedy = `Run \`agent-shim identity add ${name}\` first.`,
  ) {
    super(`No identity named "${name}". ${remedy}`);
    this.name = "IdentityNotFoundError";
  }
}

/** Raised when an identity's `identity.json` is only in a superseded farm an interrupted resync left beside its directory, so nothing can be written into it where it belongs until a launch repairs it. `present` says whether the directory itself is there (holding no `identity.json` yet) or missing. */
export class DisplacedIdentityError extends CliError {
  constructor(verb: string, name: string, id: string, present: boolean) {
    super(
      `Identity "${name}" cannot be ${verb} yet: a resync of it was interrupted and its identity.json is in a superseded farm beside identities/${id}, which ${present ? "holds no identity.json yet" : "is missing"}. Launch it once (\`agent-shim run @${name}\`): the launch ${present ? "carries the file back into the directory" : "puts the directory back"}, then try again.`,
    );
    this.name = "DisplacedIdentityError";
  }
}

/** The `DisplacedIdentityError` for identity `name`, stored under `id`, that a command which would `verb` it ("renamed", "changed", "moved") raises. */
export function displacedIdentity(paths: LayoutPaths, verb: string, name: string, id: string): DisplacedIdentityError {
  return new DisplacedIdentityError(verb, name, id, fs.existsSync(identityDirectory(paths, id)));
}

/** The id of the identity named `name`, whose `identity.json` is in place to be written. Throws what `requireIdentityId` throws, and `DisplacedIdentityError` when the identity's record is only in a superseded farm. */
export function requireStoredIdentityId(paths: LayoutPaths, name: string): string {
  const id = requireIdentityId(paths, name);
  if (!identityIdExists(paths, id)) {
    throw displacedIdentity(paths, "changed", name, id);
  }
  return id;
}

/** The `IdentityNotFoundError` for `name` under the state root `paths`, naming the command that finishes an interrupted rename giving an identity that name when there is one, rather than an `identity add` that would be refused (see `missingIdentityRemedy`). */
export function identityNotFound(paths: LayoutPaths, name: string): IdentityNotFoundError {
  return new IdentityNotFoundError(name, missingIdentityRemedy(paths, name));
}

/** Raised when an identity already claims the given name: by `addIdentity`, and by a rename to that name. */
export class IdentityAlreadyExistsError extends CliError {
  constructor(readonly identityName: string) {
    super(`An identity named "${identityName}" already exists.`);
    this.name = "IdentityAlreadyExistsError";
  }
}

/** Raised by `addIdentity` when `name` fails `IdentitySchema`'s own naming rule — it must start with a letter or number and may then contain letters, numbers, dots, hyphens, underscores, and at signs, so an email address names an identity directly while a *leading* `@` stays invalid (it would collide with the `@name` selector syntax's first-`@` split). */
export class InvalidIdentityNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(
      `"${attemptedName}" is not a valid identity name — identity names must start with a letter or number and may then contain letters, numbers, dots, hyphens, underscores, and at signs.`,
    );
    this.name = "InvalidIdentityNameError";
  }
}

/** The usage log's reads over the real filesystem. */
const realUsageReadFs: UsageReadFs = { readFileUtf8: nodeStoreFs.readFileUtf8, readdir: (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory) : []) };

/** The records port over the real filesystem. */
const realRecordsPort = textRecordsPort({ readdir: (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory) : []), readFileUtf8: nodeStoreFs.readFileUtf8 });

/** Every identity's record (its id, the directory it is stored in, and its name), read fresh from the identities directory. See `readIdentityRecords`. */
export function identityRecords(paths: LayoutPaths): readonly IdentityRecord[] {
  return readIdentityRecords(realRecordsPort, paths.identitiesDir);
}

/** The id (the directory under `identitiesDir`) of the identity named `name`, or undefined when there is none. Every lookup of an identity by name goes through this, since a renamed identity keeps the directory it was created with. Throws `DuplicateIdentityNameError` when two identities claim the name. */
export function identityIdOf(paths: LayoutPaths, name: string): string | undefined {
  return identityIdIn(identityRecords(paths), name);
}

/** The id of the identity named `name`. Throws `IdentityNotFoundError` when there is none, and `DuplicateIdentityNameError` when two claim it. */
export function requireIdentityId(paths: LayoutPaths, name: string): string {
  const id = identityIdOf(paths, name);
  if (id === undefined) {
    throw identityNotFound(paths, name);
  }
  return id;
}

/** The name of the identity stored under id `id`, or undefined when no identity is. */
export function identityNameOf(paths: LayoutPaths, id: string): string | undefined {
  return identityNameIn(identityRecords(paths), id);
}

/** What reads the name of the identity stored under one id (see `createIdentityNameReader`). `reads` counts the `identity.json` files it has read, so a test can tell a cached answer from a fresh one. */
export interface IdentityNameReader {
  readonly nameOf: (id: string) => string | undefined;
  readonly reads: () => number;
  /** How many times it has read every identity's record to name an id with no `identity.json`. */
  readonly resolves: () => number;
}

/**
 * Reads the name of the identity stored under an id from that id's own `identity.json` alone, and keeps it for as long as the file's size, modification time and inode stay as they were, so a long-lived process that names an identity on every event (the front door, once per usage snapshot it writes) stats one file instead of reading every identity's. A file whose name cannot be read names no identity; where there is no file, the name is what `identityNameOf` reads, which finds an identity a resync left displaced in a superseded farm, kept for as long as the identities directory keeps its inode, modification time and entry names, since a superseded farm and an identity's directory come and go as entries of it. The file is looked at every call, so a rename is seen as soon as it is written.
 */
export function createIdentityNameReader(paths: LayoutPaths): IdentityNameReader {
  const cached = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly ino: number; readonly name: string | undefined }>();
  const absent = new Map<string, { readonly mtimeMs: number; readonly ino: number; readonly entries: string; readonly name: string | undefined }>();
  let reads = 0;
  let resolves = 0;
  return {
    nameOf: (id) => {
      if (!isStoredName(id)) {
        return undefined;
      }
      const file = identityJsonPath(paths, id);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat === undefined) {
        // No identity.json under the id: the identity has gone, or a resync was interrupted and its record is in a superseded farm, which the resolver reads as `identityNameOf` does. Every identity's record is read for that, so the answer is kept while the identities directory is the same directory (inode), with the same mtime and the same entry names: an entry added, removed or renamed changes the names even within one tick of the mtime. What it does not see is a file rewritten inside an entry, which no resync or rename does to a superseded farm.
        cached.delete(id);
        const directory = fs.statSync(paths.identitiesDir, { throwIfNoEntry: false });
        const entries = directory === undefined ? "" : fs.readdirSync(paths.identitiesDir).sort().join("\u0000");
        const known = absent.get(id);
        if (directory !== undefined && known?.mtimeMs === directory.mtimeMs && known.ino === directory.ino && known.entries === entries) {
          return known.name;
        }
        resolves += 1;
        const name = identityNameOf(paths, id);
        if (directory !== undefined) {
          absent.set(id, { mtimeMs: directory.mtimeMs, ino: directory.ino, entries, name });
        }
        return name;
      }
      absent.delete(id);
      const hit = cached.get(id);
      if (hit?.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.ino === stat.ino) {
        return hit.name;
      }
      reads += 1;
      const read = textRecordsPort({ readdir: () => [], readFileUtf8: nodeStoreFs.readFileUtf8 }).readName(file);
      const name = typeof read === "object" ? read.name : undefined;
      cached.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, name });
      return name;
    },
    reads: () => reads,
    resolves: () => resolves,
  };
}

/** What names the identity stored under an id, in a report of state filed by id (usage snapshots and records): its name; for an identity stored there whose name cannot be read, `unreadableIdentityLabel` of the id; and for state left under an id no identity is stored under now, `goneIdentityLabel` of the id. The records are read once, when this is called. */
export function identityLabeller(paths: LayoutPaths): (id: string) => string {
  const records = new Map(identityRecords(paths).map((record) => [record.id, record]));
  return (id) => {
    const record = records.get(id);
    return record === undefined ? goneIdentityLabel(id) : (record.name ?? unreadableIdentityLabel(id));
  };
}

/** How a report names state filed under id `id` when the identity stored under it has an `identity.json` whose name cannot be read: its directory, marked `(unreadable)`, which holds a `/` no name can, as `goneIdentityLabel` does. */
export function unreadableIdentityLabel(id: string): string {
  return `identities/${id} (unreadable)`;
}

/** How a report names state filed under id `id` when no identity is stored under it now: its directory, `identities/<id>`, marked `(gone)`. The label holds a `/`, and no name an identity's record holds can contain one (`isStoredName`, which every record's name is read through, refuses it), so it never reads as an identity's name and a removed identity's usage is never merged into a live identity, whatever that identity is named. */
export function goneIdentityLabel(id: string): string {
  return `identities/${id} (gone)`;
}

/** The usage snapshot of the identity named `name`, read from where usage is filed: under its id. Undefined when no identity is named so or it has none. Throws `UsageSnapshotError` for a snapshot that cannot be read. */
export function usageSnapshotOfName(paths: LayoutPaths, usageFs: UsageReadFs, name: string): UsageSnapshot | undefined {
  const id = identityIdOf(paths, name);
  return id === undefined ? undefined : readUsageSnapshot(usageFs, paths.usageSnapshotsDir, id);
}

/** The directory of the identity stored under id `id`: its farm, and the `CLAUDE_CONFIG_DIR` its sessions run with. */
export function identityDirectory(paths: LayoutPaths, id: string): string {
  return path.join(paths.identitiesDir, id);
}

/** The directory of the identity named `name`, which is the directory of its id. Throws `IdentityNotFoundError` when no identity is named so, and `DuplicateIdentityNameError` when two are. */
export function identityDirectoryOfName(paths: LayoutPaths, name: string): string {
  return identityDirectory(paths, requireIdentityId(paths, name));
}

/** The `identity.json` of id `id`. Throws `UnsafeNameError` for an id that would leave the identities directory, which an id read from a session's environment could be. */
function identityJsonPath(paths: LayoutPaths, id: string): string {
  if (!isStoredName(id)) {
    throw new UnsafeNameError(id, "identity");
  }
  return path.join(identityDirectory(paths, id), IDENTITY_FILE);
}

/** Throws `IdentityNotFoundError` for any of `names` that is a direct member but not an identity, so a pool never starts with a member nothing can load. `pool:<name>` members are the pool store's concern: `addPool` and `setPool` check them against the pool table and the nesting graph. */
export function requireIdentityNames(paths: LayoutPaths, names: readonly string[]): void {
  const existing = new Set(listIdentities(paths).map((entry) => entry.name));
  for (const name of names) {
    if (poolNameOf(name) === undefined && !existing.has(name)) {
      throw identityNotFound(paths, name);
    }
  }
}

/** Whether an identity is named `name`. Throws `DuplicateIdentityNameError` when two are. */
export function identityExists(paths: LayoutPaths, name: string): boolean {
  return identityIdOf(paths, name) !== undefined;
}

/** Whether the directory of id `id`, spelled exactly so, holds an `identity.json`, whatever name it gives. The entry is found by listing the identities directory, so on a filesystem that ignores case another identity's directory spelled differently is not taken for it. The physical rename (`identity rename --move`) reasons about directories, which this answers for. */
export function identityIdExists(paths: LayoutPaths, id: string): boolean {
  return fs.existsSync(paths.identitiesDir) && fs.readdirSync(paths.identitiesDir).includes(id) && fs.existsSync(identityJsonPath(paths, id));
}

/** Reads and validates the `identity.json` of the identity named `name`, or undefined when there is none. */
export function readIdentity(paths: LayoutPaths, name: string): Identity | undefined {
  const id = identityIdOf(paths, name);
  return id === undefined ? undefined : readIdentityById(paths, id);
}

/** Reads and validates the `identity.json` stored under id `id`, or undefined when there is none. */
export function readIdentityById(paths: LayoutPaths, id: string): Identity | undefined {
  return readJson(identityJsonPath(paths, id), IdentitySchema);
}

/** The files outside its directory that hold an identity's state under its id: its stored token, its cached credential in the file store, and its usage snapshot. `removeIdentity` deletes them, and a leftover one keeps the id from a new identity. */
function idKeyedFiles(paths: LayoutPaths, id: string): readonly string[] {
  return [identityTokenPath(paths, id), path.join(paths.root, "credential-cache", cacheFileNameFor(identityCacheKey(id))), snapshotPath(paths.usageSnapshotsDir, id)];
}

/**
 * What deciding which ids are taken reads, gathered once for one pass over the candidate ids (the check before an add, or the write under the names lock): the ids the usage log has records of, read on first need and then reused for every candidate, so a pass reads the log at most once whichever ids it tries; the ids of the identity records, displaced ones included, read on first need and reused likewise; and the Keychain, asked by attributes for each candidate's cached credential when the caller can reach one.
 */
interface IdAllocation {
  readonly loggedIds: () => ReadonlySet<string>;
  readonly keychain: KeychainProbe | undefined;
  /** The ids of every identity record, displaced ones included (`readIdentityRecords`), read on first need and then reused for every candidate. */
  readonly recordIds: () => readonly string[];
}

/** The ids the usage log has records of, read on the first call and answered from then on (see `IdAllocation`). One made outside a decision that is started again (`resolveWithAsyncRuns`) and handed to each start reads the log once for all of them. */
export function loggedIdentityIds(paths: LayoutPaths): () => ReadonlySet<string> {
  let logged: ReadonlySet<string> | undefined;
  return () => {
    logged ??= new Set(readUsageLog(realUsageReadFs, paths.usageLogDir).records.flatMap((record) => (record.identity === undefined ? [] : [record.identity])));
    return logged;
  };
}

/** A fresh allocation for one pass over the candidate ids (see `IdAllocation`), reading the usage log through `loggedIds`. */
function idAllocation(paths: LayoutPaths, keychain: KeychainProbe | undefined, loggedIds: () => ReadonlySet<string>): IdAllocation {
  let recordIds: readonly string[] | undefined;
  return {
    loggedIds,
    keychain,
    recordIds: () => {
      recordIds ??= identityRecords(paths).map((record) => record.id);
      return recordIds;
    },
  };
}

/** The name of the file the file store keeps the cached credential of the identity stored under `id` in (`cacheFileNameFor`), with case folded, since a filesystem that ignores case makes two spellings of it one file. */
function foldedCacheFile(id: string): string {
  return cacheFileNameFor(identityCacheKey(id)).toLowerCase();
}

/** The names of the entries of `directory` as they are spelled on disk, or none when it does not exist. */
function entriesOf(directory: string): readonly string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

/**
 * What is filed under id `id` or another spelling of it that differs only in case, said as the first thing found, or undefined when nothing is: an entry of the identities directory (an identity, a renamed identity's directory, a stray file), its resync lock, a scratch or superseded farm a resync left, an identity record (a displaced one included) whose cached credential the file store would file in the same file, the moving identity excepted (see `cacheFileNameFor`), an id-keyed file outside the directory (see `idKeyedFiles`), a cached credential the Keychain store holds under `identity <id>` (asked for the exact id, when `allocation` can reach the Keychain), or a record of the usage log, which is append-only and keeps an id's requests until its retention ends. Every one would be read as the state of whichever identity is given the id, so an id with any of them is given to no identity, by `identity add` or by `identity rename --move`. Every check except the Keychain's, which is asked for the exact id, compares ids with case folded, by listing the directory rather than asking for a path, so two ids that one filesystem ignoring case would make one directory are never both given out, whether or not this filesystem ignores case.
 */
function stateFiledUnder(paths: LayoutPaths, id: string, allocation: IdAllocation, moving?: { readonly lockEntry: string; readonly id: string }): string | undefined {
  const folded = id.toLowerCase();
  const entry = (fs.existsSync(paths.identitiesDir) ? fs.readdirSync(paths.identitiesDir) : []).find((candidate) => candidate !== moving?.lockEntry && belongsToIdentity(candidate.toLowerCase(), folded));
  if (entry !== undefined) {
    return `${path.join(paths.identitiesDir, entry)} exists${entry.toLowerCase() === folded && entry !== id ? `, and an id that differs from "${id}" only in case is the same directory on a filesystem that ignores case` : ""}`;
  }
  // The file store names a cached credential's file by its owner with every character outside letters, digits, `.`, `_` and `-` made `_` (`cacheFileNameFor`), so `a@b` and `a_b` share a file. Refusing the id here, rather than renaming the files, leaves every existing file where it is; a pair given out before this refusal still names one file, in which each entry records its owner, so neither reads the other's (see `createRealCredentialCache`); an entry cached before owners were recorded names no owner and is treated as its own by both. The ids compared are those of the identity records, a displaced identity's included, so the one source of which ids exist decides.
  const sharing = allocation.recordIds().find((other) => other.toLowerCase() !== folded && other !== moving?.id && foldedCacheFile(other) === foldedCacheFile(id));
  if (sharing !== undefined) {
    const file = cacheFileNameFor(identityCacheKey(id));
    const sharingFile = cacheFileNameFor(identityCacheKey(sharing));
    return `the credential cache would file it in ${file}, ${file === sharingFile ? `the file of identities/${sharing}` : `which differs only in case from the file of identities/${sharing}, ${sharingFile}`}`;
  }
  // The moving identity's own credential-cache file, under its exact name, is its credential when the store reads it for the moving identity, which its cache step moves; any other file whose name is the new id's with case folded is another's. The file is named as it is spelled on disk.
  const cacheDir = path.join(paths.root, "credential-cache");
  const ownCacheFile = moving !== undefined && createRealCredentialCache(paths.root).read("file", identityCacheKey(moving.id)) !== undefined ? cacheFileNameFor(identityCacheKey(moving.id)) : undefined;
  for (const candidate of idKeyedFiles(paths, id)) {
    const onDisk = entriesOf(path.dirname(candidate)).find((spelled) => spelled.toLowerCase() === path.basename(candidate).toLowerCase() && !(path.dirname(candidate) === cacheDir && spelled === ownCacheFile));
    if (onDisk !== undefined) {
      return `${path.join(path.dirname(candidate), onDisk)} exists${onDisk === path.basename(candidate) ? "" : `, and a file name that differs from ${path.basename(candidate)} only in case is the same file on a filesystem that ignores case`}`;
    }
  }
  if (allocation.keychain !== undefined && keychainCacheEntryExists(allocation.keychain, identityCacheKey(id))) {
    return `the Keychain caches a credential under "${identityCacheKey(id)}"`;
  }
  const logged = [...allocation.loggedIds()].find((candidate) => candidate.toLowerCase() === folded);
  if (logged !== undefined) {
    return `the usage log holds requests filed under "${logged}"`;
  }
  return undefined;
}

/** Whether anything is filed under id `id` (see `stateFiledUnder`). */
function idTaken(paths: LayoutPaths, id: string, allocation: IdAllocation): boolean {
  return stateFiledUnder(paths, id, allocation) !== undefined;
}

/** What is filed under id `id`, said as `stateFiledUnder` says it, or undefined when nothing is: the test `identity add` makes of an id, for `identity rename --move` of the identity stored under `from`, which gives it the id it moves to. Two things are left out: the resync lock under exactly `id`, which the move takes before it checks again under its locks, and which a holder still running keeps it from taking in any case; and the moving identity itself as the one whose credential-cache file `id` would share, since it leaves its old id, and its cache step moves its own entry (see `credentialCacheStep`). The Keychain is asked through `keychain`, by attributes alone, and the usage log is read once. */
export function stateFiledUnderId(paths: LayoutPaths, id: string, keychain: KeychainProbe, from: string): string | undefined {
  return stateFiledUnder(paths, id, idAllocation(paths, keychain, loggedIdentityIds(paths)), { lockEntry: path.basename(identityLockPath("", id)), id: from });
}

/** The id a new identity named `name` is given now (see `freeIdentityId`): deterministic, so a check made before the identity is created is made against the directory it will be created in. */
function newIdentityId(paths: LayoutPaths, name: string, allocation: IdAllocation): string {
  return freeIdentityId(name, (id) => idTaken(paths, id, allocation));
}

/** Throws unless `name` can be given to a new identity under the id `id` gives: no unfinished rename holds the name or the id, no identity has the name, and it has the shape a new identity is given. */
function requireIdentityCreatable(paths: LayoutPaths, name: string, id: () => string): void {
  requireNoUnfinishedRenameNaming(paths, name, "add");
  requireNoInterruptedNameRename(paths, name, `add identity "${name}"`);
  if (identityExists(paths, name)) {
    throw new IdentityAlreadyExistsError(name);
  }
  requireNewIdentityName(name);
  const chosen = id();
  if (chosen !== name) {
    requireNoUnfinishedRenameNaming(paths, chosen, "add");
  }
}

/** Raised when the id an add was checked against is taken by the time the identity is created, as another add creating one there in between leaves it: the checks made for it no longer hold. */
class CheckedIdTakenError extends CliError {
  constructor(name: string, id: string) {
    super(`Cannot add identity "${name}": identities/${id}, the directory it was checked against, was taken while it was being added. Run the command again.`);
    this.name = "CheckedIdTakenError";
  }
}

/** How `addIdentity` reaches what it needs beyond the files: the identity names lock, and, for an add whose id was checked before the lock was taken (`requireIdentityAddable`), that id. */
export interface AddIdentityOptions {
  readonly agent?: "claude" | "codex";
  readonly namesLock?: IdentityNamesLockPorts;
  readonly checkedId?: string;
}

/**
 * Creates a new identity: validates `name` against `IdentitySchema`'s own naming rule and writes a fresh `identity.json` with `allowAmbientCredential: false` and no `defaultConfigProfile`, in the directory `newIdentityId` gives (the name itself unless something is already filed under it), or in `options.checkedId` when the add was checked against that id, which is used only while it is still free.
 *
 * Every check is made, and the file written, holding the identity names lock (`options.namesLock` reaches it; see `acquireIdentityNamesLock`), so a rename or another add cannot give the name to a second identity in between. Throws `IdentityLockBusyError` when the lock stays held, a `CliError` naming the command that finishes the rename when an unfinished rename names `name` or its id (see `requireNoUnfinishedRenameNaming`), `IdentityAlreadyExistsError` if an identity is already named `name`, since `add` never silently overwrites an existing identity, and a `CliError` when the checked id was taken in between. Throws `InvalidIdentityNameError` when `name` fails `IdentitySchema`'s naming rule, rather than letting the underlying `ZodError` escape as an unhandled crash.
 *
 * It does not ask the Keychain: called alone, it neither passes over an id whose cached credential the Keychain store still holds nor refuses over a Claude Code login left for the directory. `identity add` and the door make those checks first (`requireIdentityAddable`, then this with `checkedId`, as `addNewIdentity` does).
 */
export function addIdentity(paths: LayoutPaths, name: string, options: AddIdentityOptions = {}): Identity {
  return withIdentityNamesLock(paths, options.namesLock ?? realIdentityNamesLockPorts, () => {
    // The add itself clears a record of a rename of the name alone that holds nothing; the check made before it only leaves it out.
    removeSettledNameRenames(paths);
    const allocation = idAllocation(paths, undefined, loggedIdentityIds(paths));
    const { checkedId } = options;
    let chosen: string | undefined;
    const id = (): string => {
      chosen ??= checkedId ?? newIdentityId(paths, name, allocation);
      return chosen;
    };
    requireIdentityCreatable(paths, name, id);
    if (checkedId !== undefined && idTaken(paths, checkedId, allocation)) {
      throw new CheckedIdTakenError(name, checkedId);
    }
    const identity = IdentitySchema.parse({ name, allowAmbientCredential: false, ...(options.agent === undefined ? {} : { agent: options.agent }) });
    writeJsonAtomic(identityJsonPath(paths, id()), identity);
    return identity;
  });
}

/**
 * Persists `name` as the active identity, written atomically as plain text (not JSON — this file is read by `decideIdentity` in `src/launcher/identity.ts` via a simple UTF-8 read-and-trim, matching the README's documented `~/.agent-shim/active-identity` file).
 *
 * `name` may be a `pool:<name>` selector, which makes launches pick a member of that pool. Throws `IdentityNotFoundError` when no identity with this name exists yet, and `PoolNotFoundError` for a pool that is not defined: selecting either would silently persist a name nothing else can ever load.
 */
export function useIdentity(paths: LayoutPaths, name: string, namesLock: IdentityNamesLockPorts = realIdentityNamesLockPorts): void {
  withIdentityNamesLock(paths, namesLock, () => {
  const pool = poolNameOf(name);
  if (pool !== undefined) {
    requirePool(paths, pool);
  } else if (!identityExists(paths, name)) {
    throw identityNotFound(paths, name);
  }
  writeTextAtomic(paths.activeIdentityFile, `${name}\n`);
  });
}

/** Reads the persisted active-identity file, or undefined when none is set. */
export function readActiveIdentity(paths: LayoutPaths): string | undefined {
  if (!fs.existsSync(paths.activeIdentityFile)) {
    return undefined;
  }
  const raw = fs.readFileSync(paths.activeIdentityFile, "utf8").trim();
  return raw === "" ? undefined : raw;
}

/**
 * Whether a directory name directly under `identitiesDir` names an actual identity, rather than one of agent-shim's own farm directories.
 *
 * `IdentitySchema` requires an identity name to start with a letter or digit, so a leading `.` can only be a resync's own bookkeeping: a `.<identity>.scratch.<suffix>` tree still being built, or a `.<identity>.previous.<suffix>` superseded farm retained for `agent-shim identity resolve-conflicts`. Neither is an identity, and neither should be reported as a broken one for lacking an `identity.json` a resync never put there.
 */
export function isIdentityDirectoryName(name: string): boolean {
  return !name.startsWith(".");
}

/** An entry directly under `identitiesDir` that cannot be reached, and why: `code` is the error the filesystem gave. */
export interface UnreachableIdentityEntry {
  readonly name: string;
  readonly code: string;
}

/** The identity directories under `identitiesDir`, and the entries among them that could not be reached. */
export interface IdentityDirectoryListing {
  readonly names: readonly string[];
  readonly unreachable: readonly UnreachableIdentityEntry[];
}

/** The code of the refusal when `error` is one the entry's own state gives, or undefined for a missing target; any other fault is thrown, since it is the machine's and not the entry's. */
function unreachableCodeOf(error: unknown): string | undefined {
  const code = systemErrorCode(error);
  if (code === "ENOENT") {
    return undefined;
  }
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return code;
  }
  throw error;
}

/** What following a symlink under `identitiesDir` finds: a directory, something else (a file, or nothing at all), or a refusal that names its code. */
function followedLink(link: string): "directory" | "other" | { readonly code: string } {
  try {
    return fs.statSync(link).isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = unreachableCodeOf(error);
    return code === undefined ? "other" : { code };
  }
}

/** The code of the refusal when the files in `directory` cannot be reached, which a directory nobody can enter gives although the directory itself can be seen; undefined when they can. */
function entryRefusal(directory: string): string | undefined {
  try {
    fs.accessSync(directory, fs.constants.X_OK);
    return undefined;
  } catch (error) {
    return unreachableCodeOf(error);
  }
}

/**
 * The identity directories directly under `identitiesDir`, sorted: a directory, or a symlink that resolves to one, since every command that reaches an identity follows a symlink. A symlink to a file or to nothing is not an identity, and neither is a name `isIdentityDirectoryName` rejects. An entry that cannot be reached (a symlink that cannot be followed, which a cycle, a directory that cannot be searched or a path through a file gives, or a directory nobody can enter, so that its `identity.json` cannot be read) is not an identity either, and is listed apart so that `doctor` can say so instead of the whole listing failing. `listIdentities` and `doctor` both list identities through this, so they cannot disagree about which ids exist.
 */
export function listIdentityDirectories(paths: LayoutPaths): IdentityDirectoryListing {
  const names: string[] = [];
  const unreachable: UnreachableIdentityEntry[] = [];
  if (fs.existsSync(paths.identitiesDir)) {
    for (const entry of fs.readdirSync(paths.identitiesDir, { withFileTypes: true })) {
      noteLocalWork();
      if (!isIdentityDirectoryName(entry.name)) {
        continue;
      }
      const entryPath = path.join(paths.identitiesDir, entry.name);
      const followed = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? followedLink(entryPath) : "other";
      if (followed === "other") {
        continue;
      }
      const code = followed === "directory" ? entryRefusal(entryPath) : followed.code;
      if (code === undefined) {
        names.push(entry.name);
      } else {
        unreachable.push({ name: entry.name, code });
      }
    }
  }
  return { names: names.sort(), unreachable: unreachable.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Raised when a command that has to read every identity to change what names something finds an entry it cannot reach, since that entry may hold a reference the command would leave stale. */
class UnreachableIdentitiesError extends CliError {
  constructor(cannot: string, because: string, entries: readonly UnreachableIdentityEntry[]) {
    super(`Cannot ${cannot}: ${entries.map((entry) => `identities/${entry.name} (${entry.code})`).join(", ")} cannot be reached, so ${because}. Repair or remove ${entries.length === 1 ? "it" : "them"} first; nothing was changed.`);
    this.name = "UnreachableIdentitiesError";
  }
}

/**
 * Throws when an entry under `identitiesDir` cannot be reached (see `listIdentityDirectories`): it is left out of the listing, so a command that rewrites what the identities hold would skip it, and leave it pointing at the name it changed. `cannot` completes "Cannot ...", and `because` says what could not be done for the entry. `doctor` does not use this: it reports such an entry and carries on.
 */
export function requireNoUnreachableIdentities(paths: LayoutPaths, cannot: string, because: string): void {
  const { unreachable } = listIdentityDirectories(paths);
  if (unreachable.length > 0) {
    throw new UnreachableIdentitiesError(cannot, because, unreachable);
  }
}

/** One identity as reported by `listIdentities`, whose `identity.json` parsed and validated cleanly. `name` is the name it gives; `id` is the directory it is stored under. */
export interface IdentityListEntry {
  readonly name: string;
  readonly id: string;
  readonly identity: Identity;
  readonly isActive: boolean;
  readonly problem?: never;
  readonly displaced?: never;
}

/** One identity whose `identity.json` cannot be read where it belongs: malformed, rejected by `IdentitySchema`, or (with `displaced`) left only in a superseded farm. `problem` carries the reason, already flattened onto a single line. `name` is the name the file gives when that much of it can be read, and otherwise its id (the record of such a file claims no name). */
export interface UnreadableIdentityListEntry {
  readonly name: string;
  readonly id: string;
  readonly identity?: never;
  readonly isActive: boolean;
  readonly problem: string;
  /** Set when the file is not unreadable but displaced: an interrupted resync left it only in a superseded farm, and the next launch of the identity puts it back. */
  readonly displaced?: true;
}

/** Either shape `listIdentities` can report, discriminated by which of `identity`/`problem` is present rather than by a tag field — the two are never simultaneously satisfiable. */
export type IdentityListing = IdentityListEntry | UnreadableIdentityListEntry;

/** What an identity whose `identity.json` is only in a superseded farm an interrupted resync left is listed with. */
const DISPLACED_PROBLEM = "its identity.json is in a superseded farm an interrupted resync left; the next launch of it puts it back";

/** What an `identity.json` that is not JSON is reported as, with nothing of its text. */
const NOT_JSON_PROBLEM = "is not valid JSON";

/**
 * Reads one identity for `listIdentities`, converting an unreadable `identity.json` into a reportable problem string instead of throwing.
 *
 * Only the two failure modes a *file's own content* can produce are caught: a `ConfigFileNotJsonError` for a file that is not JSON, and the `ConfigValidationError` a schema violation raises. Anything else (a permission error, a directory where a file belongs) still propagates, since those are environment faults rather than one identity's data being bad.
 *
 * A wholly absent `identity.json` is neither: it yields `undefined`, and `listIdentities` skips the entry entirely. That is what keeps `identities/` retained superseded farms (`.<id>.previous.<pid>.<uuid>/`, which are real directories with no `identity.json`) out of the listing.
 */
function readIdentityForListing(paths: LayoutPaths, id: string): Identity | { readonly problem: string } | undefined {
  try {
    return readIdentityById(paths, id);
  } catch (error) {
    // The file is said to be not JSON and nothing of its text is repeated, since the parser's message quotes the text either side of the failure, which may be a secret.
    if (error instanceof ConfigFileNotJsonError) {
      return { problem: NOT_JSON_PROBLEM };
    }
    if (error instanceof ConfigValidationError) {
      return { problem: error.message.replace(/\s*\n\s*/g, " ") };
    }
    throw error;
  }
}

/**
 * Lists every identity under `identitiesDir`, sorted by name, marking which one (if any) is currently active. Two identities that claim one name are both listed; `doctor` reports them.
 *
 * One identity whose `identity.json` cannot be read is reported as its own `UnreadableIdentityListEntry` rather than aborting the whole listing. A single bad file blocking `identity list` outright is exactly the failure mode that hides every *other* identity from view at the moment the user most needs to see them — and the file need not even be corrupt to land here, since a name written by a newer agent-shim whose naming rule has since widened is rejected outright by an older binary's own copy of `IdentitySchema`.
 */
export function listIdentities(paths: LayoutPaths): readonly IdentityListing[] {
  if (!fs.existsSync(paths.identitiesDir)) {
    return [];
  }
  const active = readActiveIdentity(paths);
  const names = new Map(identityRecords(paths).map((record) => [record.id, record.name]));
  const result: IdentityListing[] = [];
  for (const id of listIdentityDirectories(paths).names) {
    const read = readIdentityForListing(paths, id);
    if (read === undefined) {
      continue;
    }
    // An entry that is one directory with another (a symlink beside an identity's directory) has no record of its own, and is listed once, as the identity it reaches, under the entry that holds it, whether or not its identity.json can be read.
    if (!names.has(id)) {
      continue;
    }
    const name = "problem" in read ? (names.get(id) ?? id) : read.name;
    const isActive = name === active;
    result.push("problem" in read ? { name, id, isActive, problem: read.problem } : { name, id, identity: read, isActive });
  }
  // An identity whose identity.json is only in a superseded farm an interrupted resync left is still an identity, found by its name (see `readIdentityRecords`), and is listed with what puts it back.
  const unreachable = new Set(listIdentityDirectories(paths).unreachable.map((entry) => entry.name));
  for (const record of identityRecords(paths).filter((candidate) => !identityIdExists(paths, candidate.id) && !unreachable.has(candidate.id))) {
    const name = record.name ?? record.id;
    result.push({ name, id: record.id, isActive: name === active, problem: DISPLACED_PROBLEM, displaced: true });
  }
  return result.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Every identity that has anchors, with them and its id and name, read from each `identity.json` fresh. An identity whose file cannot be read is left out, as `listIdentities` reports it separately. */
export function listAnchoredIdentities(paths: LayoutPaths): readonly { readonly id: string; readonly identity: string; readonly anchors: readonly Anchor[] }[] {
  return listIdentities(paths).flatMap(({ id, name, identity }) => {
    const anchors = identity?.anchors;
    return anchors === undefined ? [] : [{ id, identity: name, anchors }];
  });
}

/**
 * Throws unless a new identity can be created as a person asks for one (`identity add`, and the offer to create one that `identity use`, `@name` and a launch make): everything `addIdentity` refuses, and additionally a directory the Keychain still holds a Claude Code login for, which a new identity there would start signed in as. The id is chosen with the Keychain asked too, so one whose cached credential the Keychain store still holds is passed over. The name is checked first, so an existing identity, which has a login of its own, is told it exists and not that a login is in the way. It changes nothing, so an offer can make it before it asks anything and a caller that must not block can run it over an asynchronous probe (`resolveWithAsyncRuns`). Returns the id it checked, which `addIdentity` is then given (`checkedId`), so the identity is created where the check was made.
 *
 * `keepKeychainLogin` says the login is wanted. `loggedIds` reads the ids the usage log has records of (see `loggedIdentityIds`); a caller that starts this again for each Keychain answer passes one reader to every start. Throws what `addIdentity` throws, and `KeychainLoginError` (see `requireNoLeftoverKeychainLogin`).
 */
export function requireIdentityAddable(paths: LayoutPaths, name: string, keychain: KeychainProbe, keepKeychainLogin: boolean, loggedIds: () => ReadonlySet<string> = loggedIdentityIds(paths)): string {
  const allocation = idAllocation(paths, keychain, loggedIds);
  let chosen: string | undefined;
  const id = (): string => {
    chosen ??= newIdentityId(paths, name, allocation);
    return chosen;
  };
  requireIdentityCreatable(paths, name, id);
  requireNoLeftoverKeychainLogin(keychain, identityDirectory(paths, id()), name, keepKeychainLogin);
  return id();
}

/** Creates a new identity as a person asks for one: `requireIdentityAddable`, then `addIdentity` under the id it checked. */
export function addNewIdentity(paths: LayoutPaths, name: string, keychain: KeychainProbe, keepKeychainLogin: boolean): Identity {
  return addIdentity(paths, name, { checkedId: requireIdentityAddable(paths, name, keychain, keepKeychainLogin) });
}

/**
 * Sets `identity`'s anchors, or clears them when `anchors` is undefined. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setIdentityAnchors(paths: LayoutPaths, identityName: string, anchors: readonly Anchor[] | undefined): Identity {
  return applyPatch(identityJsonPath(paths, requireStoredIdentityId(paths, identityName)), IdentitySchema, { anchors: anchors === undefined ? undefined : [...anchors] });
}

/**
 * Sets `identity`'s `defaultConfigProfile` field, or clears it when `profileName` is undefined. Throws `IdentityNotFoundError` when the identity does not exist. Whether the profile exists is the caller's concern: `identity set --default-profile` checks it first.
 */
export function setDefaultConfigProfile(paths: LayoutPaths, identityName: string, profileName: string | undefined): Identity {
  return applyPatch(identityJsonPath(paths, requireStoredIdentityId(paths, identityName)), IdentitySchema, {
    defaultConfigProfile: profileName,
  });
}

/**
 * Sets `identity`'s `provider` field, or clears it when `providerName` is undefined. Throws `IdentityNotFoundError` when identity does not exist. Whether the provider exists is the caller's concern: `identity set --provider` checks it first.
 */
export function setIdentityProvider(paths: LayoutPaths, identityName: string, providerName: string | undefined): Identity {
  return applyPatch(identityJsonPath(paths, requireStoredIdentityId(paths, identityName)), IdentitySchema, { provider: providerName });
}

/**
 * Sets `identity`'s display `label`, or clears it when `label` is undefined. Throws `IdentityNotFoundError` when the identity does not exist, and `ConfigValidationError` when `label` fails `IdentityLabelSchema`: `identity set --label` reports that as a usage error first. The label is display only and changes nothing the name keys.
 */
export function setIdentityLabel(paths: LayoutPaths, identityName: string, label: string | undefined): Identity {
  return applyPatch(identityJsonPath(paths, requireStoredIdentityId(paths, identityName)), IdentitySchema, { label });
}

/**
 * Patches `identity`'s `allowAmbientCredential` field. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setAllowAmbientCredential(paths: LayoutPaths, identityName: string, allow: boolean): Identity {
  return applyPatch(identityJsonPath(paths, requireStoredIdentityId(paths, identityName)), IdentitySchema, {
    allowAmbientCredential: allow,
  });
}

/** The change `setIdentityCredential` makes: new sources and/or a new target for the credential block, or `false` to remove the block and return the identity to its stored login. */
export type IdentityCredentialChange = { readonly sources?: readonly CredentialSource[]; readonly target?: CredentialTarget; readonly cache?: CredentialCache | false } | false;

/**
 * Sets, changes or removes `identityName`'s credential block. New `sources` replace the whole ordered list (the order is the meaning); a `target` alone keeps the existing sources, and so needs a credential block to exist already. Throws `IdentityNotFoundError` when the identity does not exist, and `UsageError` when only a target is given for an identity with no credential yet.
 */
export function setIdentityCredential(paths: LayoutPaths, identityName: string, change: IdentityCredentialChange): Identity {
  const id = requireStoredIdentityId(paths, identityName);
  const existing = readIdentityById(paths, id);
  if (existing === undefined) {
    throw identityNotFound(paths, identityName);
  }
  if (change === false) {
    return applyPatch(identityJsonPath(paths, id), IdentitySchema, { credential: undefined });
  }
  const sources = change.sources ?? existing.credential?.sources;
  if (sources === undefined) {
    throw new UsageError(`Identity "${identityName}" has no credential yet: pass --credential to give it one before choosing its target.`);
  }
  const target = change.target ?? existing.credential?.target;
  const cache = change.cache === undefined ? existing.credential?.cache : change.cache === false ? undefined : change.cache;
  return applyPatch(identityJsonPath(paths, id), IdentitySchema, {
    credential: { sources: [...sources], ...(target === undefined ? {} : { target }), ...(cache === undefined ? {} : { cache }) },
  });
}

/** `text` with every character a regular expression gives a meaning escaped, so a name matches only itself. */
function escapedForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Whether `entry` (a name directly under `identitiesDir`) is identity `name`'s farm, or a scratch or superseded farm a resync left behind. The resync lock is not one: it guards the farm and is never moved with it.
 *
 * The suffix is matched whole, not as a prefix, because a name may contain dots: the farms of an identity called `work.previous.old` start with `.work.previous.`, and are not the farms of `work`.
 */
function isFarmEntry(entry: string, name: string): boolean {
  return entry === name || new RegExp(`^\\.${escapedForPattern(name)}${FARM_SUFFIX_PATTERN}$`, "u").test(entry);
}

/** Whether `entry` (a name directly under `identitiesDir`) is part of identity `name`'s on-disk state: its farm, the resync lock, or a scratch or superseded farm a resync left behind. */
function belongsToIdentity(entry: string, name: string): boolean {
  return isFarmEntry(entry, name) || entry === path.basename(identityLockPath("", name));
}

/** The entries directly under `identitiesDir` that make up the farm of the identity stored under id `name`: its directory, and any scratch or superseded farm a resync left beside it. Sorted, and empty when there are none. */
export function identityFarmEntries(paths: LayoutPaths, name: string): readonly string[] {
  return fs.existsSync(paths.identitiesDir) ? fs.readdirSync(paths.identitiesDir).filter((entry) => isFarmEntry(entry, name)).sort() : [];
}

/** `entry`, one of identity `from`'s farm entries (`identityFarmEntries`), under identity `to`: the directory itself takes the new name, and a scratch or superseded farm keeps its suffix. */
export function renamedFarmEntry(entry: string, from: string, to: string): string {
  return entry === from ? to : `.${to}${entry.slice(from.length + 1)}`;
}

/** Throws `InvalidIdentityNameError` unless `name` has the shape a new identity is given: the rule `IdentitySchema` holds `name` to, which `identity add` and `identity rename` both apply. */
export function requireNewIdentityName(name: string): void {
  if (!FileNameSchema.safeParse(name).success) {
    throw new InvalidIdentityNameError(name);
  }
}

/** Whether the identity names `first` and `second` are one identity on this machine: the same directory, which a symlink gives and a filesystem that ignores case gives two spellings of one name, including a name whose directory does not exist yet. */
export function sameIdentityName(paths: LayoutPaths, first: string, second: string): boolean {
  return sameDirectory(path.join(paths.identitiesDir, first), path.join(paths.identitiesDir, second)) || (first.toLowerCase() === second.toLowerCase() && ignoresCase(paths.identitiesDir));
}

/**
 * Throws a `CliError` naming the command that finishes the rename when an unfinished rename holds `name`, as its old name or its new one or another spelling of either that reaches the same directory (see `requireNameFreeOfUnfinishedRename`), so `identity add` and `identity remove` cannot take a name the rename still needs. Without this, removing the identity a rename was moving, or adding its target by hand, would leave a journal no rename could ever finish. `action` is the verb the refusal reports.
 */
export function requireNoUnfinishedRenameNaming(paths: LayoutPaths, name: string, action: "add" | "remove"): void {
  requireNameFreeOfUnfinishedRename({ readFileUtf8: nodeStoreFs.readFileUtf8, readdir: (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory) : []) }, paths.identityRenamesDir, name, action, (first, second) => sameIdentityName(paths, first, second), (identity) => identityIdExists(paths, identity));
}

/** Raised when an identity cannot be removed because a launch of it holds its resync lock: removing it then would delete the lock from under that launch. An `IdentityLockBusyError`, so a caller that answers a busy lock answers this one. */
export class IdentityRemovalBusyError extends IdentityLockBusyError {
  constructor(name: string, lockPath: string, holderPid: number | undefined) {
    super(name, lockPath, holderPid, `Cannot remove identity "${name}": a launch of it${holderPid === undefined ? "" : ` (pid ${String(holderPid)})`} is resyncing its directory and holds its lock at ${lockPath}. Let that launch start, or stop it, then run the command again; nothing was changed.`);
    this.name = "IdentityRemovalBusyError";
  }
}

/** Takes the resync lock of the identity named `name`, stored under `id`, with the ports of the names lock already held, or throws `IdentityRemovalBusyError` when a launch holds it. */
function acquireRemovalLock(paths: LayoutPaths, name: string, id: string, ports: IdentityNamesLockPorts): IdentityLock {
  try {
    return acquireIdentityLock({ ...ports, identity: id, dir: paths.identitiesDir });
  } catch (error: unknown) {
    if (error instanceof IdentityLockBusyError) {
      throw new IdentityRemovalBusyError(name, error.lockPath, error.holderPid);
    }
    throw error;
  }
}

/**
 * Deletes the identity named `name` entirely: its directory under `identitiesDir` (the farm, its `identity.json`, and whatever that farm holds unshared, credentials included; for an entry that is a symlink, the link and not what it points to), every other entry there that is the same directory (each symlink to it), its resync lock, any scratch or superseded farm a resync left behind, the files outside the directory that hold its state under its id (`REMOVED_STATE`: its stored token, its cached credential in the file store, which the store deletes only when it is this identity's own or was cached before owners were recorded, and its usage snapshot), and the active-identity selection when it names this identity. Returns the id it was stored under, so a caller that can reach the Keychain forgets a credential cached there too. Data shared into `~/.claude` stays there, since the farm only ever symlinks to it. Throws a `CliError` naming the command that finishes the rename when an unfinished rename names `name` or the identity's id, `IdentityNotFoundError` when no identity is named `name`, and `DuplicateIdentityNameError` when two are. It holds the identity names lock throughout, so it never removes an identity a rename is applying to, and throws `IdentityLockBusyError` when that stays held; it then takes the identity's own resync lock, so it never removes an identity a launch is resyncing, and throws `IdentityRemovalBusyError` (naming the launch to let finish or stop) when that is held.
 */
export function removeIdentity(paths: LayoutPaths, name: string, namesLock: IdentityNamesLockPorts = realIdentityNamesLockPorts): string {
  return withIdentityNamesLock(paths, namesLock, () => removeIdentityWithLockHeld(paths, name, namesLock));
}

/** Removes an identity while the caller holds the identity names lock. */
export function removeIdentityWithLockHeld(paths: LayoutPaths, name: string, namesLock: IdentityNamesLockPorts): string {
  removeSettledNameRenames(paths);
  requireNoUnfinishedRenameNaming(paths, name, "remove");
  requireNoInterruptedNameRename(paths, name, `remove identity "${name}"`);
  const id = requireIdentityId(paths, name);
  const launch = liveLaunchesOn(namesLock.fs, paths.launchesDir, id, namesLock.isRunning)[0];
  if (launch !== undefined) throw new IdentityLockBusyError(name, paths.launchesDir, launch, `Cannot remove identity "${name}": a launch is using it (pid ${String(launch)}). Let the launch finish before removing the identity; nothing was changed.`);
  if (id !== name) {
    requireNoUnfinishedRenameNaming(paths, id, "remove");
  }
  // The identity's resync lock is taken after the names lock, the documented order, so a launch resyncing it is never left holding a lock this deletes, nor sharing it with a later identity given the id.
  const resync = acquireRemovalLock(paths, name, id, namesLock);
  try {
    const lockFile = path.basename(resync.path);
    // Whether each file outside the directory can be deleted where it stands is checked before anything is deleted, so a failure leaves the identity whole.
    for (const file of idKeyedFiles(paths, id).filter((candidate) => fs.existsSync(candidate))) {
      fs.accessSync(path.dirname(file), fs.constants.W_OK | fs.constants.X_OK);
    }
    // Every other entry that is the identity's directory (a symlink to it, or to where its own symlink points) is the same identity, which would otherwise be found again under that entry's id once this one is gone. Listed before anything is deleted, while each still resolves; deleting a symlink deletes the link, never what it points to.
    const links = fs.readdirSync(paths.identitiesDir).filter((entry) => !entry.startsWith(".") && entry !== id && sameDirectory(path.join(paths.identitiesDir, entry), path.join(paths.identitiesDir, id)));
    for (const entry of fs.readdirSync(paths.identitiesDir)) {
      if (links.includes(entry) || (entry !== lockFile && belongsToIdentity(entry, id))) {
        fs.rmSync(path.join(paths.identitiesDir, entry), { recursive: true, force: true });
      }
    }
    // The cached credential goes through the store, which deletes only an entry recorded for this identity or cached before owners were recorded, never one recorded for another identity whose id names the same file.
    const cacheFile = path.join(paths.root, "credential-cache", cacheFileNameFor(identityCacheKey(id)));
    for (const file of idKeyedFiles(paths, id).filter((candidate) => candidate !== cacheFile)) {
      fs.rmSync(file, { force: true });
    }
    createRealCredentialCache(paths.root).remove("file", identityCacheKey(id));
    if (readActiveIdentity(paths) === name) {
      fs.rmSync(paths.activeIdentityFile);
    }
    return id;
  } finally {
    resync.release();
  }
}

/** What `identity remove` deletes outside the identity's directory, in the words its help, its confirmation and the door's confirmation use. */
export const REMOVED_STATE = "its stored token, its cached credential (never one recorded for another identity whose id names the same file; one cached before owners were recorded names no owner and is deleted whichever identity whose id names that file cached it) and its usage snapshot";

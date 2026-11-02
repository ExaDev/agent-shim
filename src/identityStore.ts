import fs from "node:fs";
import path from "node:path";
import { ConfigFileNotJsonError, ConfigValidationError } from "./config/load";
import { FileNameSchema } from "./config/names";
import { applyPatch, nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { IdentitySchema, type Anchor, type CredentialCache, type CredentialSource, type CredentialTarget, type Identity } from "./config/schema";
import { CliError, UsageError } from "./cliError";
import { poolNameOf } from "./launcher/identity";
import { requirePool } from "./poolStore";
import type { LayoutPaths } from "./paths";
import { identityLockPath } from "./launcher/lock";
import { requireNameFreeOfUnfinishedRename } from "./identityRenameJournal";
import { requireNoLeftoverKeychainLogin, type KeychainProbe } from "./keychainLogin";
import { ignoresCase, sameDirectory } from "./sameDirectory";

/** Raised by any operation that requires an identity to already exist, when it does not. */
export class IdentityNotFoundError extends CliError {
  constructor(readonly name: string) {
    super(`No identity named "${name}". Run \`agent-shim identity add ${name}\` first.`);
    this.name = "IdentityNotFoundError";
  }
}

/** Raised by `addIdentity` when an identity with the given name already has an `identity.json`. */
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

function identityJsonPath(paths: LayoutPaths, name: string): string {
  return path.join(paths.identitiesDir, name, "identity.json");
}

/** Throws `IdentityNotFoundError` for any of `names` that is a direct member but not an identity, so a pool never starts with a member nothing can load. `pool:<name>` members are the pool store's concern: `addPool` and `setPool` check them against the pool table and the nesting graph. */
export function requireIdentityNames(paths: LayoutPaths, names: readonly string[]): void {
  const existing = new Set(listIdentities(paths).map((entry) => entry.name));
  for (const name of names) {
    if (poolNameOf(name) === undefined && !existing.has(name)) {
      throw new IdentityNotFoundError(name);
    }
  }
}

export function identityExists(paths: LayoutPaths, name: string): boolean {
  return fs.existsSync(identityJsonPath(paths, name));
}

/** Reads and validates one identity's `identity.json`, or undefined when it does not exist. */
export function readIdentity(paths: LayoutPaths, name: string): Identity | undefined {
  return readJson(identityJsonPath(paths, name), IdentitySchema);
}

/** Throws unless `name` can be given to a new identity: no unfinished rename holds it, no identity has it, and it has the shape a new identity is given. */
function requireIdentityCreatable(paths: LayoutPaths, name: string): void {
  requireNoUnfinishedRenameNaming(paths, name, "add");
  if (identityExists(paths, name)) {
    throw new IdentityAlreadyExistsError(name);
  }
  requireNewIdentityName(name);
}

/**
 * Creates a new identity: validates `name` against `IdentitySchema`'s own naming rule and writes a fresh `identity.json` with `allowAmbientCredential: false` and no `defaultConfigProfile`.
 *
 * Throws a `CliError` naming the command that finishes the rename when an unfinished rename names `name` (see `requireNoUnfinishedRenameNaming`), `IdentityAlreadyExistsError` if an identity with this name already has an `identity.json` — `add` never silently overwrites an existing identity. Throws `InvalidIdentityNameError` when `name` fails `IdentitySchema`'s naming rule, rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function addIdentity(paths: LayoutPaths, name: string): Identity {
  requireIdentityCreatable(paths, name);
  const identity = IdentitySchema.parse({ name, allowAmbientCredential: false });
  writeJsonAtomic(identityJsonPath(paths, name), identity);
  return identity;
}

/**
 * Persists `name` as the active identity, written atomically as plain text (not JSON — this file is read by `decideIdentity` in `src/launcher/identity.ts` via a simple UTF-8 read-and-trim, matching the README's documented `~/.agent-shim/active-identity` file).
 *
 * `name` may be a `pool:<name>` selector, which makes launches pick a member of that pool. Throws `IdentityNotFoundError` when no identity with this name exists yet, and `PoolNotFoundError` for a pool that is not defined: selecting either would silently persist a name nothing else can ever load.
 */
export function useIdentity(paths: LayoutPaths, name: string): void {
  const pool = poolNameOf(name);
  if (pool !== undefined) {
    requirePool(paths, pool);
  } else if (!identityExists(paths, name)) {
    throw new IdentityNotFoundError(name);
  }
  writeTextAtomic(paths.activeIdentityFile, `${name}\n`);
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

/** The errors the filesystem gives for a path that cannot be reached because of what it points through or its permissions, not because of a fault in the machine: a cycle of links, a directory that cannot be searched, a path through a file. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ELOOP", "EACCES", "ENOTDIR"]);

/** The `code` of a system error, or undefined for anything else. */
function systemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
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
 * The identity directories directly under `identitiesDir`, sorted: a directory, or a symlink that resolves to one, since `identityExists` follows a symlink and every command that reaches an identity does with it. A symlink to a file or to nothing is not an identity, and neither is a name `isIdentityDirectoryName` rejects. An entry that cannot be reached (a symlink that cannot be followed, which a cycle, a directory that cannot be searched or a path through a file gives, or a directory nobody can enter, so that its `identity.json` cannot be read) is not an identity either, and is listed apart so that `doctor` can say so instead of the whole listing failing. `listIdentities` and `doctor` both list identities through this, so they cannot disagree about which names exist.
 */
export function listIdentityDirectories(paths: LayoutPaths): IdentityDirectoryListing {
  const names: string[] = [];
  const unreachable: UnreachableIdentityEntry[] = [];
  if (fs.existsSync(paths.identitiesDir)) {
    for (const entry of fs.readdirSync(paths.identitiesDir, { withFileTypes: true })) {
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

/** One identity as reported by `listIdentities`, whose `identity.json` parsed and validated cleanly. */
export interface IdentityListEntry {
  readonly name: string;
  readonly identity: Identity;
  readonly isActive: boolean;
  readonly problem?: never;
}

/** One identity whose `identity.json` is present but unreadable — malformed JSON, or valid JSON this version's `IdentitySchema` rejects. `problem` carries the reason, already flattened onto a single line. */
export interface UnreadableIdentityListEntry {
  readonly name: string;
  readonly identity?: never;
  readonly isActive: boolean;
  readonly problem: string;
}

/** Either shape `listIdentities` can report, discriminated by which of `identity`/`problem` is present rather than by a tag field — the two are never simultaneously satisfiable. */
export type IdentityListing = IdentityListEntry | UnreadableIdentityListEntry;

/** What an `identity.json` that is not JSON is reported as, with nothing of its text. */
const NOT_JSON_PROBLEM = "is not valid JSON";

/**
 * Reads one identity for `listIdentities`, converting an unreadable `identity.json` into a reportable problem string instead of throwing.
 *
 * Only the two failure modes a *file's own content* can produce are caught: a `ConfigFileNotJsonError` for a file that is not JSON, and the `ConfigValidationError` a schema violation raises. Anything else (a permission error, a directory where a file belongs) still propagates, since those are environment faults rather than one identity's data being bad.
 *
 * A wholly absent `identity.json` is neither — it yields `undefined`, and `listIdentities` skips the entry entirely. That is what keeps `identities/` retained superseded farms (`.<name>.previous.<pid>.<uuid>/`, which are real directories with no `identity.json`) out of the listing.
 */
function readIdentityForListing(paths: LayoutPaths, name: string): Identity | { readonly problem: string } | undefined {
  try {
    return readIdentity(paths, name);
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
 * Lists every identity under `identitiesDir`, marking which one (if any) is currently active.
 *
 * One identity whose `identity.json` cannot be read is reported as its own `UnreadableIdentityListEntry` rather than aborting the whole listing. A single bad file blocking `identity list` outright is exactly the failure mode that hides every *other* identity from view at the moment the user most needs to see them — and the file need not even be corrupt to land here, since a name written by a newer agent-shim whose naming rule has since widened is rejected outright by an older binary's own copy of `IdentitySchema`.
 */
export function listIdentities(paths: LayoutPaths): readonly IdentityListing[] {
  if (!fs.existsSync(paths.identitiesDir)) {
    return [];
  }
  const active = readActiveIdentity(paths);
  const result: IdentityListing[] = [];
  for (const name of listIdentityDirectories(paths).names) {
    const read = readIdentityForListing(paths, name);
    if (read === undefined) {
      continue;
    }
    const isActive = name === active;
    result.push("problem" in read ? { name, isActive, problem: read.problem } : { name, identity: read, isActive });
  }
  return result;
}

/** Every identity that has anchors, with them, read from each `identity.json` fresh. An identity whose file cannot be read is left out, as `listIdentities` reports it separately. */
export function listAnchoredIdentities(paths: LayoutPaths): readonly { readonly identity: string; readonly anchors: readonly Anchor[] }[] {
  return listIdentities(paths).flatMap(({ name }) => {
    const anchors = readIdentity(paths, name)?.anchors;
    return anchors === undefined ? [] : [{ identity: name, anchors }];
  });
}

/**
 * Throws unless a new identity can be created as a person asks for one (`identity add`, and the offer to create one that `identity use`, `@name` and a launch make): everything `addIdentity` refuses, and additionally a name whose directory the Keychain still holds a Claude Code login for, which a new identity there would start signed in as. The name is checked first, so an existing identity, which has a login of its own, is told it exists and not that a login is in the way. It changes nothing, so an offer can make it before it asks anything and a caller that must not block can run it over an asynchronous probe (`resolveWithAsyncRuns`).
 *
 * `keepKeychainLogin` says the login is wanted. Throws what `addIdentity` throws, and `KeychainLoginError` (see `requireNoLeftoverKeychainLogin`).
 */
export function requireIdentityAddable(paths: LayoutPaths, name: string, keychain: KeychainProbe, keepKeychainLogin: boolean): void {
  requireIdentityCreatable(paths, name);
  requireNoLeftoverKeychainLogin(keychain, path.join(paths.identitiesDir, name), name, keepKeychainLogin);
}

/** Creates a new identity as a person asks for one: `requireIdentityAddable`, then `addIdentity`. */
export function addNewIdentity(paths: LayoutPaths, name: string, keychain: KeychainProbe, keepKeychainLogin: boolean): Identity {
  requireIdentityAddable(paths, name, keychain, keepKeychainLogin);
  return addIdentity(paths, name);
}

/**
 * Sets `identity`'s anchors, or clears them when `anchors` is undefined. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setIdentityAnchors(paths: LayoutPaths, identityName: string, anchors: readonly Anchor[] | undefined): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, { anchors: anchors === undefined ? undefined : [...anchors] });
}

/**
 * Sets `identity`'s `defaultConfigProfile` field, or clears it when `profileName` is undefined. Throws `IdentityNotFoundError` when the identity does not exist. Whether the profile exists is the caller's concern: `identity set --default-profile` checks it first.
 */
export function setDefaultConfigProfile(paths: LayoutPaths, identityName: string, profileName: string | undefined): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    defaultConfigProfile: profileName,
  });
}

/**
 * Sets `identity`'s `provider` field, or clears it when `providerName` is undefined. Throws `IdentityNotFoundError` when identity does not exist. Whether the provider exists is the caller's concern: `identity set --provider` checks it first.
 */
export function setIdentityProvider(paths: LayoutPaths, identityName: string, providerName: string | undefined): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, { provider: providerName });
}

/**
 * Sets `identity`'s display `label`, or clears it when `label` is undefined. Throws `IdentityNotFoundError` when the identity does not exist, and `ConfigValidationError` when `label` fails `IdentityLabelSchema`: `identity set --label` reports that as a usage error first. The label is display only and changes nothing the name keys.
 */
export function setIdentityLabel(paths: LayoutPaths, identityName: string, label: string | undefined): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, { label });
}

/**
 * Patches `identity`'s `allowAmbientCredential` field. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setAllowAmbientCredential(paths: LayoutPaths, identityName: string, allow: boolean): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    allowAmbientCredential: allow,
  });
}

/** The change `setIdentityCredential` makes: new sources and/or a new target for the credential block, or `false` to remove the block and return the identity to its stored login. */
export type IdentityCredentialChange = { readonly sources?: readonly CredentialSource[]; readonly target?: CredentialTarget; readonly cache?: CredentialCache | false } | false;

/**
 * Sets, changes or removes `identityName`'s credential block. New `sources` replace the whole ordered list (the order is the meaning); a `target` alone keeps the existing sources, and so needs a credential block to exist already. Throws `IdentityNotFoundError` when the identity does not exist, and `UsageError` when only a target is given for an identity with no credential yet.
 */
export function setIdentityCredential(paths: LayoutPaths, identityName: string, change: IdentityCredentialChange): Identity {
  const existing = readIdentity(paths, identityName);
  if (existing === undefined) {
    throw new IdentityNotFoundError(identityName);
  }
  if (change === false) {
    return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, { credential: undefined });
  }
  const sources = change.sources ?? existing.credential?.sources;
  if (sources === undefined) {
    throw new UsageError(`Identity "${identityName}" has no credential yet: pass --credential to give it one before choosing its target.`);
  }
  const target = change.target ?? existing.credential?.target;
  const cache = change.cache === undefined ? existing.credential?.cache : change.cache === false ? undefined : change.cache;
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    credential: { sources: [...sources], ...(target === undefined ? {} : { target }), ...(cache === undefined ? {} : { cache }) },
  });
}

/** A UUID in its usual text form, as `randomUUID` writes it. */
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** What follows an identity's name in the scratch and superseded farms a resync leaves beside it: `.scratch.` or `.previous.`, then the launcher's process id and a UUID, joined by a dot (`uniqueSuffix` in `launchWiring.ts`). */
const FARM_SUFFIX_PATTERN = `\\.(?:scratch|previous)\\.\\d+\\.${UUID_PATTERN}`;

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

/** The entries directly under `identitiesDir` that make up identity `name`'s farm: its directory, and any scratch or superseded farm a resync left beside it. Sorted, and empty when there are none. */
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
function sameIdentityName(paths: LayoutPaths, first: string, second: string): boolean {
  return sameDirectory(path.join(paths.identitiesDir, first), path.join(paths.identitiesDir, second)) || (first.toLowerCase() === second.toLowerCase() && ignoresCase(paths.identitiesDir));
}

/**
 * Throws a `CliError` naming the command that finishes the rename when an unfinished rename holds `name`, as its old name or its new one or another spelling of either that reaches the same directory (see `requireNameFreeOfUnfinishedRename`), so `identity add` and `identity remove` cannot take a name the rename still needs. Without this, removing the identity a rename was moving, or adding its target by hand, would leave a journal no rename could ever finish. `action` is the verb the refusal reports.
 */
export function requireNoUnfinishedRenameNaming(paths: LayoutPaths, name: string, action: "add" | "remove"): void {
  requireNameFreeOfUnfinishedRename({ readFileUtf8: nodeStoreFs.readFileUtf8, readdir: (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory) : []) }, paths.identityRenamesDir, name, action, (first, second) => sameIdentityName(paths, first, second), (identity) => identityExists(paths, identity));
}

/**
 * Deletes identity `name` entirely: its directory under `identitiesDir` (the farm, its `identity.json`, and whatever that farm holds unshared, credentials included), its resync lock, any scratch or superseded farm a resync left behind, and the active-identity selection when it names this identity. Data shared into `~/.claude` stays there, since the farm only ever symlinks to it. Throws a `CliError` naming the command that finishes the rename when an unfinished rename names `name`, and `IdentityNotFoundError` when the identity does not exist.
 */
export function removeIdentity(paths: LayoutPaths, name: string): void {
  requireNoUnfinishedRenameNaming(paths, name, "remove");
  if (!identityExists(paths, name)) {
    throw new IdentityNotFoundError(name);
  }
  for (const entry of fs.readdirSync(paths.identitiesDir)) {
    if (belongsToIdentity(entry, name)) {
      fs.rmSync(path.join(paths.identitiesDir, entry), { recursive: true, force: true });
    }
  }
  if (readActiveIdentity(paths) === name) {
    fs.rmSync(paths.activeIdentityFile);
  }
}

import fs from "node:fs";
import path from "node:path";
import { ConfigValidationError } from "./config/load";
import { applyPatch, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { IdentitySchema, type CredentialCache, type CredentialSource, type CredentialTarget, type Identity } from "./config/schema";
import { CliError, UsageError } from "./cliError";
import { poolNameOf } from "./launcher/identity";
import { requirePool } from "./poolStore";
import type { LayoutPaths } from "./paths";
import { identityLockPath } from "./launcher/lock";

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

/**
 * Creates a new identity: validates `name` against `IdentitySchema`'s own naming rule and writes a fresh `identity.json` with `allowAmbientCredential: false` and no `defaultConfigProfile`.
 *
 * Throws `IdentityAlreadyExistsError` if an identity with this name already has an `identity.json` — `add` never silently overwrites an existing identity. Throws `InvalidIdentityNameError` when `name` fails `IdentitySchema`'s naming rule, rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function addIdentity(paths: LayoutPaths, name: string): Identity {
  if (identityExists(paths, name)) {
    throw new IdentityAlreadyExistsError(name);
  }
  const parsed = IdentitySchema.safeParse({ name, allowAmbientCredential: false });
  if (!parsed.success) {
    throw new InvalidIdentityNameError(name);
  }
  writeJsonAtomic(identityJsonPath(paths, name), parsed.data);
  return parsed.data;
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

/**
 * Reads one identity for `listIdentities`, converting an unreadable `identity.json` into a reportable problem string instead of throwing.
 *
 * Only the two failure modes a *file's own content* can produce are caught: a `SyntaxError` from `JSON.parse`, and the `ConfigValidationError` a schema violation raises. Anything else (a permission error, a directory where a file belongs) still propagates, since those are environment faults rather than one identity's data being bad.
 *
 * A wholly absent `identity.json` is neither — it yields `undefined`, and `listIdentities` skips the entry entirely. That is what keeps `identities/` retained superseded farms (`.<name>.previous.<pid>.<uuid>/`, which are real directories with no `identity.json`) out of the listing.
 */
function readIdentityForListing(paths: LayoutPaths, name: string): Identity | { readonly problem: string } | undefined {
  try {
    return readIdentity(paths, name);
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof SyntaxError) {
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
  const names = fs
    .readdirSync(paths.identitiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isIdentityDirectoryName(entry.name))
    .map((entry) => entry.name)
    .sort();

  const result: IdentityListing[] = [];
  for (const name of names) {
    const read = readIdentityForListing(paths, name);
    if (read === undefined) {
      continue;
    }
    const isActive = name === active;
    result.push("problem" in read ? { name, isActive, problem: read.problem } : { name, identity: read, isActive });
  }
  return result;
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

/** Whether `entry` (a name directly under `identitiesDir`) is part of identity `name`'s on-disk state: its farm, the resync lock, or a scratch or superseded farm a resync left behind. */
function belongsToIdentity(entry: string, name: string): boolean {
  return (
    entry === name ||
    entry === path.basename(identityLockPath("", name)) ||
    entry.startsWith(`.${name}.scratch.`) ||
    entry.startsWith(`.${name}.previous.`)
  );
}

/**
 * Deletes identity `name` entirely: its directory under `identitiesDir` (the farm, its `identity.json`, and whatever that farm holds unshared, credentials included), its resync lock, any scratch or superseded farm a resync left behind, and the active-identity selection when it names this identity. Data shared into `~/.claude` stays there, since the farm only ever symlinks to it. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function removeIdentity(paths: LayoutPaths, name: string): void {
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

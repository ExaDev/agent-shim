import nodeFs from "node:fs";
import path from "node:path";

import { CliError } from "./cliError";
import { sameDirectory } from "./sameDirectory";
import { MAX_NAME_BYTES, isStoredName } from "./config/names";

/**
 * One identity as its storage knows it. `id` is the name of its directory under the identities directory: it is chosen when the identity is created and never changes, so everything filed under it (the directory, the `CLAUDE_CONFIG_DIR` every session holds, the macOS Keychain login filed under a hash of that path, the resync lock, the usage snapshot) stays valid across a rename. `name` is what `identity.json` calls the identity: every command, selector and configuration reference uses it, and `identity rename` changes it alone.
 */
export interface IdentityRecord {
  readonly id: string;
  /** Undefined when the record's `identity.json` gives no name that can be read: such a record claims no name, so it can never collide with one another identity holds. */
  readonly name: string | undefined;
}

/** What reading one `identity.json` for its name found: the name, no file there, or a file whose name cannot be read (not JSON, or no string `name`). */
export type IdentityNameRead = { readonly name: string } | "absent" | "unreadable";

/** What reading the records needs: the entries directly under the identities directory, and the name in one `identity.json`. Injected so the launcher's configuration port, the farm's filesystem port and the real filesystem all resolve through the same rule. */
export interface IdentityRecordsPort {
  readonly readdir: (directory: string) => readonly string[];
  readonly readName: (identityJson: string) => IdentityNameRead;
  /** Whether two entries are one directory on disk, which a symlink beside an identity's directory makes them. */
  readonly sameDirectory: (first: string, second: string) => boolean;
  /** Whether an entry is itself a symlink, read without following it: of two entries that are one directory, the one that is not is the identity's own. */
  readonly isSymlink: (entry: string) => boolean;
}

/** Whether `entry` is a symlink, read without following it; an entry that has gone is not one. */
export function isSymlinkEntry(entry: string): boolean {
  return nodeFs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

/** A UUID in its usual text form, as `randomUUID` writes it. */
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** What follows an identity's id in the scratch and superseded farms a resync leaves beside it: `.scratch.` or `.previous.`, then the launcher's process id and a UUID, joined by a dot (`uniqueSuffix` in `launchWiring.ts`). */
export const FARM_SUFFIX_PATTERN = `\\.(?:scratch|previous)\\.\\d+\\.${UUID_PATTERN}`;

/** Whether `entry` is a scratch (`kind` `scratch`) or superseded (`previous`) farm a resync of the identity stored under id `id` leaves: `.<id>.<kind>.<pid>.<uuid>`, matched whole, so the farms of an identity whose id itself holds `.scratch.` or `.previous.` (`a.scratch.x`) are never taken for those of `a`. */
export function isResyncFarmOf(entry: string, id: string, kind: "scratch" | "previous"): boolean {
  return new RegExp(`^\\.${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\.${kind}\\.\\d+\\.${UUID_PATTERN}$`, "u").test(entry);
}

/** A superseded farm's entry name, capturing the id of the identity it belongs to. The id is matched greedily, so an id that itself contains dots is read whole. */
const SUPERSEDED_FARM = new RegExp(`^\\.(.+)\\.previous\\.\\d+\\.${UUID_PATTERN}$`, "u");

/** The file under an identity's directory that holds its name. */
export const IDENTITY_FILE = "identity.json";

/**
 * Every identity record under `identitiesDir`, sorted by id. An entry whose name does not start with a dot is an identity when it holds an `identity.json`: the record takes the name that file gives, or no name when the file's name cannot be read (see `identityIdIn` for how such a record is still reached). An entry with no `identity.json` is not an identity unless a superseded farm of it holds one (below).
 *
 * Two entries that are one directory on disk, as a symlink beside an identity's directory makes them, are one record: the entry that is the directory itself rather than a symlink to it, or else the first by id. The choice reads the filesystem, never the name, so a rename of the name never changes which entry is the identity's id.
 *
 * A superseded farm (`.<id>.previous.<suffix>`) whose identity's entry holds no `identity.json` (no directory at all, a resync killed between the two renames of its swap; or the new farm swapped in before the file was carried over into it) is the trace the launcher's recovery repairs: until then the identity's `identity.json` is inside it, so the record is read from there (from the first such farm in name order that holds an `identity.json`, which is the farm the launcher's recovery restores; a farm retained from an earlier swap for its conflicts holds none, since a completed swap carries the file over), and the identity can still be found by name to be recovered.
 */
export function readIdentityRecords(port: IdentityRecordsPort, identitiesDir: string): readonly IdentityRecord[] {
  const entries = [...new Set(port.readdir(identitiesDir))].sort();
  const present = new Set(entries.filter((entry) => !entry.startsWith(".")));
  const records = new Map<string, string | undefined>();
  const claim = (id: string, file: string): void => {
    const read = port.readName(path.join(identitiesDir, file, IDENTITY_FILE));
    if (read !== "absent" && !records.has(id)) {
      records.set(id, read === "unreadable" ? undefined : read.name);
    }
  };
  for (const entry of present) {
    claim(entry, entry);
  }
  // An id whose entry holds no identity.json (missing, or a farm a resync swapped in before carrying the file over) takes its record from the first of its superseded farms in name order that holds an identity.json (the one the launcher's recovery restores), so the identity is still found by its name and the next launch's recovery runs.
  for (const entry of entries) {
    const id = SUPERSEDED_FARM.exec(entry)?.[1];
    if (id !== undefined && !records.has(id)) {
      claim(id, entry);
    }
  }
  const sorted = [...records].map(([id, name]) => ({ id, name })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // Two entries that are one directory (a symlink beside an identity's directory) read one identity.json, so they are one identity, whether or not its name can be read: the entry that is the directory itself is kept, else the first by id.
  return sorted.filter((record) => {
    const twins = sorted.filter((other) => other.name === record.name && port.sameDirectory(path.join(identitiesDir, other.id), path.join(identitiesDir, record.id)));
    const kept = twins.find((twin) => !port.isSymlink(path.join(identitiesDir, twin.id))) ?? twins[0];
    return kept === undefined || kept.id === record.id;
  });
}

/** Raised when two identity records claim one name: nothing can tell which of them a reference to the name means, so nothing resolves it until one is renamed. `doctor` reports the same. */
export class DuplicateIdentityNameError extends CliError {
  constructor(
    readonly identityName: string,
    readonly ids: readonly string[],
  ) {
    super(`Identity name "${identityName}" is claimed by more than one identity (the directories ${ids.map((id) => `identities/${id}`).join(", ")}), so nothing that names it can be resolved. Rename all but one by its id: agent-shim identity rename ${ids[0] ?? "<id>"} <new name> --id`);
    this.name = "DuplicateIdentityNameError";
  }
}

/** The records that claim a name more than once, grouped by the name, for `doctor`. */
export function duplicateIdentityNames(records: readonly IdentityRecord[]): readonly { readonly name: string; readonly ids: readonly string[] }[] {
  const byName = new Map<string, string[]>();
  for (const record of records) {
    if (record.name !== undefined) {
      byName.set(record.name, [...(byName.get(record.name) ?? []), record.id]);
    }
  }
  return [...byName].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids }));
}

/**
 * The id of the identity named `name`, or undefined when no record claims it. A record whose name cannot be read claims none, and is reached only by its own id, and only when no record claims that as a name: then `name` resolves to it, so that loading it reports why its `identity.json` cannot be read rather than the identity seeming not to exist, and a healthy identity that holds the name is never blocked by it. Throws `DuplicateIdentityNameError` when more than one record claims `name`.
 */
export function identityIdIn(records: readonly IdentityRecord[], name: string): string | undefined {
  const matches = records.filter((record) => record.name === name);
  if (matches.length > 1) {
    throw new DuplicateIdentityNameError(name, matches.map((record) => record.id));
  }
  return matches[0]?.id ?? records.find((record) => record.name === undefined && record.id === name)?.id;
}

/** The name of the identity whose id is `id`, or undefined when no record has that id. */
export function identityNameIn(records: readonly IdentityRecord[], id: string): string | undefined {
  return records.find((record) => record.id === id)?.name;
}

/**
 * The id a new identity named `name` is given: `name` itself when `taken` says nothing is filed under it, otherwise `<name>-<n>` for the smallest `n` from 2 up that is free. A renamed identity keeps its directory, so the old name's directory stays occupied and an identity added under that name later is given the next free id instead of colliding with it. The base is shortened when the suffix would take the id past the longest name a file may have, which keeps every id a valid file name; the names an id is built from are ASCII, so their length is their byte count.
 */
export function freeIdentityId(name: string, taken: (id: string) => boolean): string {
  if (!taken(name)) {
    return name;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${name.slice(0, MAX_NAME_BYTES - suffix.length)}${suffix}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
}

/** Reads a name from the parsed contents of an `identity.json`: the `name`, or unreadable when there is none or it could name no file (empty, a path, too long), which no identity can have been given under any rule, so that the file is reported as invalid under its directory's name. A name a newer release's rule allows and this one's rejects is still read, so its identity can be found and its file reported. */
export function nameOfParsed(value: unknown): IdentityNameRead {
  return typeof value === "object" && value !== null && "name" in value && typeof value.name === "string" && isStoredName(value.name) ? { name: value.name } : "unreadable";
}

/** Reads a name from the text of an `identity.json`, or absent when there is no text. */
function nameOfText(text: string | undefined): IdentityNameRead {
  if (text === undefined) {
    return "absent";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  return nameOfParsed(parsed);
}

/** The errors reading `<entry>/identity.json` gives when the entry is not a directory at all (a plain file under the identities directory), which makes it no identity. */
const NOT_A_DIRECTORY_CODES: ReadonlySet<string> = new Set(["ENOTDIR"]);

/** The errors reading `<entry>/identity.json` gives when the entry is a directory, or a link to one, whose file cannot be reached: the entry is an identity whose record cannot be read. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["EACCES", "ELOOP", "EISDIR"]);

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Reads one `identity.json`'s name through `read`, giving the same answer for the same entry whichever reader the caller holds: an entry that is not a directory (a plain file under the identities directory) is absent, and one whose file cannot be reached (nobody can enter it, a symlink loop, a directory where the file belongs) is unreadable, so it claims no name and blocks no identity. Any other fault is the machine's and is thrown. `read` gives the parsed name, or absent for a file that is not there.
 */
export function guardedNameRead(read: () => IdentityNameRead): IdentityNameRead {
  try {
    return read();
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined && NOT_A_DIRECTORY_CODES.has(code)) {
      return "absent";
    }
    if (code !== undefined && UNREACHABLE_CODES.has(code)) {
      return "unreadable";
    }
    throw error;
  }
}

/** The records port over a filesystem that reads files as text, such as the farm's: the name is parsed out of the text, and the entry's faults are read as `guardedNameRead` reads them. */
export function textRecordsPort(fs: { readonly readdir: (directory: string) => readonly string[]; readonly readFileUtf8: (file: string) => string | undefined }): IdentityRecordsPort {
  return {
    readdir: fs.readdir,
    sameDirectory,
    isSymlink: isSymlinkEntry,
    readName: (file) => guardedNameRead(() => nameOfText(fs.readFileUtf8(file))),
  };
}

/** The id of the identity named `name`, read over a filesystem that reads files as text (see `textRecordsPort`), or undefined when none is named so. Throws `DuplicateIdentityNameError` when two are. */
export function identityIdOver(fs: { readonly readdir: (directory: string) => readonly string[]; readonly readFileUtf8: (file: string) => string | undefined }, identitiesDir: string, name: string): string | undefined {
  return identityIdIn(readIdentityRecords(textRecordsPort(fs), identitiesDir), name);
}

/** Every identity record, read over a filesystem that reads files as text (see `textRecordsPort`). */
export function identityRecordsOver(fs: { readonly readdir: (directory: string) => readonly string[]; readonly readFileUtf8: (file: string) => string | undefined }, identitiesDir: string): readonly IdentityRecord[] {
  return readIdentityRecords(textRecordsPort(fs), identitiesDir);
}

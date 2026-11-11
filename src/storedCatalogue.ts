import path from "node:path";

import type { LayoutPaths } from "./paths";
import { catalogueBindingPath, catalogueCachePath, catalogueSettingsPath } from "./providerCatalogue";

/** A stored file the reader could not read: its message carries the fault (`catalogueReadFault`) and no path. */
export class UnreadableCatalogueError extends Error {
  readonly fault: string;
  constructor(fault: string) {
    super(`stored catalogue cannot be read (${fault})`);
    this.name = "UnreadableCatalogueError";
    this.fault = fault;
  }
}

/** Why a stored file could not be read, as the class or code of the failure and never its message, which names the path: the system error's code when it has one of that shape (`EACCES`, `EISDIR`, `ELOOP`), else the error's class name, else a fixed word. */
export function catalogueReadFault(error: unknown): string {
  if (error instanceof UnreadableCatalogueError) {
    return error.fault;
  }
  const code: unknown = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : error instanceof Error ? error.name : "an error";
}

/** The `onUnreadable` of a reader that lets the fault surface as an `UnreadableCatalogueError`, for a caller that answers for the one provider whose files they are. */
export function raiseUnreadableCatalogue(fault: string): never {
  throw new UnreadableCatalogueError(fault);
}

/** The `onUnreadable` of a reader that skips the file: it reads as absent, and the fault is recorded where the files are kept up to date (the keeper's status and log for that provider). */
export const skipUnreadableCatalogue = (): void => undefined;

/**
 * The one way to read a file of a provider's stored catalogue state (the catalogue, its settings digest, its account binding, a refresh's status and failure record) or of the login a Codex catalogue is bound to: the text of the file through the `read` it was made over, `undefined` when there is none, and, when the file exists but cannot be read (permissions, a directory in its place, a symlink loop: anything but absence), `onUnreadable` is told the fault and the file reads as absent unless it throws. The caller decides what one provider's unreadable file means for it (skip it, record it, answer for it), so no unreadable file reaches a request, a tick or a command of another provider as a raw system error naming its path.
 *
 * A class with private state, so it is nominal: a function that takes a `TolerantReader` cannot be handed a bare `readFileUtf8`, and a raw read of such a file does not type-check.
 */
export class TolerantReader {
  readonly #read: (file: string) => string | undefined;
  readonly #onUnreadable: (fault: string) => void;

  constructor(read: (file: string) => string | undefined, onUnreadable: (fault: string) => void) {
    this.#read = read;
    this.#onUnreadable = onUnreadable;
  }

  /** The text of `file`, `undefined` when it is absent or unreadable (`onUnreadable` returned). */
  read(file: string): string | undefined {
    try {
      return this.#read(file);
    } catch (error) {
      this.#onUnreadable(catalogueReadFault(error));
      return undefined;
    }
  }

  /** `take()`, `undefined` when it throws: for a stat of a stored file, which fails the way a read does. The fault is reported as a read's is. */
  attempt<T>(take: () => T): T | undefined {
    try {
      return take();
    } catch (error) {
      this.#onUnreadable(catalogueReadFault(error));
      return undefined;
    }
  }
}

/** The supervisor generation whose directory holds a Codex provider's catalogue, status and failure files. */
export interface CatalogueOwner {
  readonly pid: number;
  readonly generation: string;
}

/** The file holding one provider's refresh state within the supervisor generation that owns it. */
export function catalogueStatusFile(paths: LayoutPaths, owner: CatalogueOwner, name: string): string {
  return path.join(path.dirname(catalogueCachePath(paths, name, owner.pid, owner.generation)), `${name}.status.json`);
}

/** The file holding why a provider's last refresh failed, in a directory of its own: a name beside `<name>.json` and `<name>.status.json` can be another provider's cache (providers `foo` and `foo.failure` would share `foo.failure.json`), while no file of the generation's directory can be a file in a directory called `failures`. */
export function catalogueFailureFile(paths: LayoutPaths, owner: CatalogueOwner, name: string): string {
  return path.join(path.dirname(catalogueCachePath(paths, name, owner.pid, owner.generation)), "failures", `${name}.json`);
}

/** A provider's stored catalogue state as text, read through one `TolerantReader`. Nothing else outside the modules that write, move and remove these files names their paths (`storedCatalogueGuard.test.ts`), so this is where they are read. */
export class StoredCatalogue {
  readonly #paths: LayoutPaths;
  readonly #reader: TolerantReader;

  constructor(paths: LayoutPaths, reader: TolerantReader) {
    this.#paths = paths;
    this.#reader = reader;
  }

  /** The catalogue file of `name`: a Codex provider's is in the directory of the supervisor generation that fetched it (`owner`), an `http` provider's is shared. */
  cacheText(name: string, owner?: CatalogueOwner): string | undefined {
    return this.#reader.read(catalogueCachePath(this.#paths, name, owner?.pid, owner?.generation));
  }

  /** The file holding the digest of the settings an `http` provider's catalogue was fetched under. */
  digestText(name: string): string | undefined {
    return this.#reader.read(catalogueSettingsPath(this.#paths, name));
  }

  /** The non-secret binding between a Codex catalogue and the login that fetched it. */
  bindingText(name: string, owner?: CatalogueOwner): string | undefined {
    return this.#reader.read(catalogueBindingPath(this.#paths, name, owner?.pid, owner?.generation));
  }

  /** The refresh status the supervisor generation `owner` recorded for `name`. */
  statusText(owner: CatalogueOwner, name: string): string | undefined {
    return this.#reader.read(catalogueStatusFile(this.#paths, owner, name));
  }

  /** The record of why `name`'s last refresh failed in the supervisor generation `owner`. */
  failureText(owner: CatalogueOwner, name: string): string | undefined {
    return this.#reader.read(catalogueFailureFile(this.#paths, owner, name));
  }

  /** What identifies the stored files of an `http` provider's catalogue (the catalogue and its digest) as they are now, or `undefined` when either cannot be named (it cannot be statted, or `revisionOf` knows no revision of it): the key a parse of them is kept under. */
  revision(name: string, revisionOf: (file: string) => string | undefined): string | undefined {
    const cacheRevision = this.#reader.attempt(() => revisionOf(catalogueCachePath(this.#paths, name)));
    const digestRevision = this.#reader.attempt(() => revisionOf(catalogueSettingsPath(this.#paths, name)));
    return cacheRevision === undefined || digestRevision === undefined ? undefined : `${cacheRevision}\u0000${digestRevision}`;
  }
}

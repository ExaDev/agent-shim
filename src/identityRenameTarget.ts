import { CliError } from "./cliError";
import { displacedIdentity, identityIdExists, identityRecords, requireIdentityId } from "./identityStore";
import type { LayoutPaths } from "./paths";

/** How a rename of the name alone is told which identity to rename: by its name, or with `byId` by its id, which is how one of two identities that claim one name is renamed. */
export interface RenameOptions {
  readonly byId?: boolean;
}

/** Raised when a rename addresses an identity by an id (`--id`) under which no identity is stored. */
class UnknownIdentityIdError extends CliError {
  constructor(id: string) {
    super(`No identity is stored under identities/${id}. \`agent-shim identity list\` shows each identity's id.`);
    this.name = "UnknownIdentityIdError";
  }
}

/** Raised when an identity addressed by its id has an `identity.json` whose name cannot be read, so there is no name to change. */
class NamelessIdentityError extends CliError {
  constructor(id: string) {
    super(`The identity stored under identities/${id} has an identity.json whose name cannot be read, so it has no name to rename. Repair the file first.`);
    this.name = "NamelessIdentityError";
  }
}

/** The identity a rename of the name alone changes: its id, its name now, and whether another identity also claims that name. `from` is its name, or with `byId` its id. Throws `IdentityNotFoundError` for a name no identity has, `UnknownIdentityIdError` for an id no identity is stored under, `DuplicateIdentityNameError` for a name two identities claim when it is not addressed by id, `NamelessIdentityError`, and `DisplacedIdentityError` when the identity's `identity.json` is not in its directory (its record was read from a superseded farm). */
export function renamedIdentity(paths: LayoutPaths, from: string, options: RenameOptions): { readonly id: string; readonly name: string; readonly shared: boolean } {
  const records = identityRecords(paths);
  const record = options.byId === true ? records.find((candidate) => candidate.id === from) : records.find((candidate) => candidate.id === requireIdentityId(paths, from));
  if (record === undefined) {
    // Only an id can miss here: a name that reaches no record is refused by requireIdentityId.
    throw new UnknownIdentityIdError(from);
  }
  const { name } = record;
  if (name === undefined) {
    throw new NamelessIdentityError(record.id);
  }
  // The name is written last into the identity's own identity.json; a record read from a superseded farm has none in place to write.
  if (!identityIdExists(paths, record.id)) {
    throw displacedIdentity(paths, "renamed", name, record.id);
  }
  return { id: record.id, name, shared: records.some((other) => other.id !== record.id && other.name === name) };
}

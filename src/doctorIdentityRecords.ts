import path from "node:path";

import { duplicateIdentityNames, type IdentityRecord } from "./identityRecords";

/** A record read from a superseded farm, with whether its identity's directory is present (holding no `identity.json` yet) or missing. */
export interface DisplacedIdentityRecord extends IdentityRecord {
  readonly directoryPresent: boolean;
}

/** One finding about how identity records name identities, for `doctor`'s identity section. */
export interface IdentityRecordFinding {
  readonly severity: "fail" | "warn";
  readonly message: string;
  readonly subject: string;
}

/**
 * The findings about the identity records themselves, as the resolver reads them (a record whose name cannot be read claims none, and an entry that is one directory with another is one record): a name two records claim, which resolves to neither, so every reference to it fails until one of them is renamed, and a record read from a superseded farm because its identity's directory is missing or holds no `identity.json` yet, which the next launch puts back, and a rename of the name alone left half done, which blocks the names it holds until it is finished, and a file in `identity-name-renames/` holding a record under a name its rename does not give it, which nothing reads or removes. A name that differs from its identity's directory is not a fault: a rename changes the name alone.
 */
export function identityRecordFindings(
  records: readonly IdentityRecord[],
  displaced: readonly DisplacedIdentityRecord[],
  nameRenames: readonly { readonly from: string; readonly description: string }[],
  strayNameRenameFiles: readonly string[],
): readonly IdentityRecordFinding[] {
  return [
    ...strayNameRenameFiles.map((file): IdentityRecordFinding => ({
      severity: "warn",
      message: `${file} holds the record of a rename of an identity's name, but not under the file name that rename keeps it in, so nothing reads it or removes it. Remove it.`,
      subject: path.basename(file),
    })),
    ...nameRenames.map(({ from, description }): IdentityRecordFinding => ({ severity: "fail", message: description, subject: from })),
    ...duplicateIdentityNames(records).map(({ name, ids }): IdentityRecordFinding => ({
      severity: "fail",
      message: `Identity name "${name}" is claimed by more than one identity (${ids.map((id) => `identities/${id}`).join(", ")}), so nothing that names it can be resolved. Rename all but one by its id: agent-shim identity rename ${ids[0] ?? "<id>"} <new name> --id`,
      subject: name,
    })),
    ...displaced.map(({ id, name, directoryPresent }): IdentityRecordFinding => ({
      severity: "warn",
      message: `${name === undefined ? `The identity stored under identities/${id}` : `Identity "${name}"`} has no identity.json in identities/${id}, which ${directoryPresent ? "holds none yet" : "is missing"}: its identity.json is in a superseded farm a resync left when it was interrupted. ${name === undefined ? `Its identity.json gives no name that can be read, ${records.some((record) => record.name === id) ? `and its id is the name of another identity, so a launch by its id reaches that one: repair the file in the superseded farm and launch it by the name the file gives, or rename the identity named "${id}" first and then launch this one by its id (\`agent-shim run @${id}\`) to put it back.` : `so launch it by its id (\`agent-shim run @${id}\`) to put it back, then repair the file.`}` : `The next launch of "${name}" puts it back.`}`,
      subject: name ?? id,
    })),
  ];
}

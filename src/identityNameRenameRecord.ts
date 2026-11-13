import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { CliError } from "./cliError";
import { listProfiles, readGlobalConfig } from "./configProfilesStore";
import { listDirectoryRules } from "./directoryRulesStore";
import { renameAccountModelRefs } from "./modelRefs";
import type { LayoutPaths } from "./paths";
import { readableOr } from "./readableConfig";
import { readRouteOverrides, routeOverridesRenamed } from "./routeOverridesStore";
import { realFarmFs } from "./realPorts";
import { picksWithIdentityRenamed } from "./usage/poolPick";
import { identityRecordsOver, type IdentityRecord } from "./identityRecords";
import { renamePairFileName } from "./identityRenameJournal";

/**
 * The record a rename of the name alone keeps while it applies: which identity (by id) it is renaming from which name to which. It is written before the first reference is rewritten and removed once the rename ends or every step has been undone, and kept when the rollback itself fails, so one that is found holds the state a rename killed part way leaves: references already naming `to` while the identity is still named `from`. Nothing else could tell that state from references a person wrote, and `identity add <to>` would otherwise adopt them.
 */
const NameRenameRecordSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  startedAt: z.iso.datetime(),
});

/** One unfinished rename of the name alone. */
export type NameRenameRecord = z.infer<typeof NameRenameRecordSchema>;

const RECORD_SUFFIX = ".json";

/** The file the record of the rename of `from` to `to` is kept in, named by a hash of the pair (see `renamePairFileName`). */
function recordFile(paths: LayoutPaths, from: string, to: string): string {
  return path.join(paths.identityNameRenamesDir, renamePairFileName(from, to, RECORD_SUFFIX));
}

/** One record as it was read, with the file it was read from. */
interface RecordFile {
  readonly file: string;
  readonly record: NameRenameRecord;
}

/** Every file in the directory that holds a record, read fresh, with the file each was read from. A file that is not one is left out: it names no rename, so it holds no name. */
function readRecordFiles(paths: LayoutPaths): readonly RecordFile[] {
  if (!fs.existsSync(paths.identityNameRenamesDir)) {
    return [];
  }
  return fs.readdirSync(paths.identityNameRenamesDir).flatMap((entry) => {
    if (!entry.endsWith(RECORD_SUFFIX)) {
      return [];
    }
    const file = path.join(paths.identityNameRenamesDir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return [];
    }
    const result = NameRenameRecordSchema.safeParse(parsed);
    return result.success ? [{ file, record: result.data }] : [];
  });
}

/** Whether `entry` is in the file a rename of its own pair writes and removes (see `recordFile`). One that is not was not written by a rename and no rename would remove it, so it is not taken as one. */
function isFiledForItsPair(entry: Readonly<RecordFile>): boolean {
  return path.basename(entry.file) === renamePairFileName(entry.record.from, entry.record.to, RECORD_SUFFIX);
}

/** Every record in the directory filed where its rename keeps it, read fresh (see `readRecordFiles` and `isFiledForItsPair`). */
export function readNameRenameRecords(paths: LayoutPaths): readonly NameRenameRecord[] {
  return readRecordFiles(paths).filter(isFiledForItsPair).map((entry) => entry.record);
}

/** The files in the directory that hold a record but not under the name its rename files it under, so nothing reads or removes them; `doctor` reports them. */
export function strayNameRenameRecordFiles(paths: LayoutPaths): readonly string[] {
  return readRecordFiles(paths).filter((entry) => !isFiledForItsPair(entry)).map((entry) => entry.file);
}

/** Writes the record of a rename, flushed to disk before it returns, so it is there if the process dies during the first step. */
export function writeNameRenameRecord(paths: LayoutPaths, record: Readonly<NameRenameRecord>): void {
  realFarmFs.mkdirPrivate(paths.identityNameRenamesDir);
  realFarmFs.writeFilePrivate(recordFile(paths, record.from, record.to), `${JSON.stringify(NameRenameRecordSchema.parse(record), null, 2)}\n`, { durable: true });
}

/** Removes the record of a rename of `from` to `to`; one that is already gone is fine. */
export function removeNameRenameRecord(paths: LayoutPaths, from: string, to: string): void {
  fs.rmSync(recordFile(paths, from, to), { force: true });
}

/** The name `renameAccountModelRefs` is asked to rename to when only whether `models` holds an `acct:<name>/` ref is wanted: any other name changes it, and nothing is written. */
function probeName(name: string): string {
  return `${name}_`;
}

/**
 * Where the configuration names identity `name`: the pools listing it, the jobs running as it, the directory rules pinning it or holding an `acct:<name>/` model ref, the global configuration and the profiles holding one, the active selection, the route overrides (its scope, or a target naming it), and the directories whose last pool pick it is. The recorded picks are counted by the rewrite a rename makes, asked to rename the name to itself, which changes nothing and reports how many name it. A configuration file that cannot be read holds no reference here (see `readableOr`).
 */
function referencesToName(paths: LayoutPaths, name: string): readonly string[] {
  const config = readableOr(() => readGlobalConfig(paths), undefined);
  const pools = Object.entries(config?.pools ?? {}).flatMap(([pool, entry]) => (entry.identities.some((member) => (typeof member === "string" ? member : member.identity) === name) ? [`pool ${pool}`] : []));
  const jobs = Object.entries(config?.jobs ?? {}).flatMap(([job, entry]) => ("identity" in entry.target && entry.target.identity === name ? [`job ${job}`] : []));
  const models = config?.models !== undefined && renameAccountModelRefs(config.models, name, probeName(name)) !== undefined ? ["models"] : [];
  const profiles = readableOr(() => listProfiles(paths, () => undefined), []).flatMap(({ name: profile, profile: stored }) => (stored.models !== undefined && renameAccountModelRefs(stored.models, name, probeName(name)) !== undefined ? [`profile ${profile}`] : []));
  const rules = readableOr(() => listDirectoryRules(paths), []).flatMap((rule) => (rule.identity === name || (rule.models !== undefined && renameAccountModelRefs(rule.models, name, probeName(name)) !== undefined) ? [`rule ${rule.path}`] : []));
  const active = fs.existsSync(paths.activeIdentityFile) && fs.readFileSync(paths.activeIdentityFile, "utf8").trim() === name ? ["the active selection"] : [];
  const overrides = readableOr(() => readRouteOverrides(paths), undefined);
  const routed = overrides !== undefined && routeOverridesRenamed(overrides, "identity", name, probeName(name)) !== undefined ? ["route overrides"] : [];
  const picksText = fs.existsSync(paths.usagePicksFile) ? fs.readFileSync(paths.usagePicksFile, "utf8") : undefined;
  const picked = picksText === undefined ? undefined : picksWithIdentityRenamed(picksText, name, name)?.renamed;
  return [...pools, ...jobs, ...models, ...profiles, ...rules, ...active, ...routed, ...(picked === undefined ? [] : [`${String(picked)} recorded pool pick${picked === 1 ? "" : "s"}`])];
}

/** Raised when a command would act on a name an interrupted rename of the name alone holds: it has rewritten references to `to` and not yet the identity's own name. */
export class InterruptedNameRenameError extends CliError {
  constructor(action: string, description: string) {
    super(`Cannot ${action}: ${description.charAt(0).toLowerCase()}${description.slice(1)}`);
    this.name = "InterruptedNameRenameError";
  }
}

/**
 * Whether `record` no longer describes a rename left half done: the identity stored under its id already carries the new name, which the rename writes last, and (unless another identity also claims the old name) no reference still names the old name, so the rename finished and only the record's removal was lost; or nothing is stored under that id any more, so there is nothing left to finish. Either way the record holds nothing, and the next add, remove or rename that meets it removes it.
 */
function isSettled(paths: LayoutPaths, record: Readonly<NameRenameRecord>, records: readonly IdentityRecord[]): boolean {
  const stored = records.find((candidate) => candidate.id === record.id);
  if (stored === undefined) {
    return true;
  }
  if (stored.name !== record.to) {
    return false;
  }
  const shared = records.some((candidate) => candidate.id !== record.id && candidate.name === record.from);
  return shared || referencesToName(paths, record.from).length === 0;
}

/** Every record of a rename of the name alone still left half done, read fresh: a settled one (see `isSettled`) is left out. Reads only, so `doctor` can list them. */
export function unfinishedNameRenames(paths: LayoutPaths): readonly NameRenameRecord[] {
  const records = identityRecordsOver(realFarmFs, paths.identitiesDir);
  return readNameRenameRecords(paths).filter((record) => !isSettled(paths, record, records));
}

/** Removes every settled record (see `isSettled`): a rename killed after its last step, or one whose identity has since gone. Each is removed from the file it was read from. */
export function removeSettledNameRenames(paths: LayoutPaths): void {
  const records = identityRecordsOver(realFarmFs, paths.identitiesDir);
  for (const entry of readRecordFiles(paths).filter((candidate) => isFiledForItsPair(candidate) && isSettled(paths, candidate.record, records))) {
    fs.rmSync(entry.file, { force: true });
  }
}

/** The sentence `doctor` and a refusal give for an unfinished rename of the name alone: what it is, what it has rewritten, and the command that finishes it. */
export function describeInterruptedNameRename(paths: LayoutPaths, record: Readonly<NameRenameRecord>): string {
  const references = referencesToName(paths, record.to);
  const rewritten = references.length === 0 ? "" : ` and has already rewritten references to "${record.to}" (${references.join(", ")})`;
  // `--id` is needed when another identity also claims the old name, which then reaches neither; when the id merely differs from the name the old name would still reach the identity, and the `--id` form is given there too because it reaches it whatever the names become.
  const claimants = identityRecordsOver(realFarmFs, paths.identitiesDir).filter((candidate) => candidate.name === record.from).length;
  const finish = claimants > 1 || record.id !== record.from ? `agent-shim identity rename ${record.id} ${record.to} --id` : `agent-shim identity rename ${record.from} ${record.to}`;
  return `A rename of identity "${record.from}" to "${record.to}" was interrupted${rewritten}. Finish it with \`${finish}\`.`;
}

/** What a person told that no identity is named `name` should do: when an interrupted rename of the name alone is giving an identity that name, finish it (`identity add` of the name is refused until then, see `describeInterruptedNameRename`); otherwise add the identity. Reads only. */
export function missingIdentityRemedy(paths: LayoutPaths, name: string): string {
  const giving = unfinishedNameRenames(paths).find((record) => record.to === name);
  return giving === undefined ? `Run \`agent-shim identity add ${name}\` first.` : describeInterruptedNameRename(paths, giving);
}

/** Throws `InterruptedNameRenameError` when an unfinished rename of the name alone holds `name` as its old or new name, and is not the rename of `id` from `from` to `to` named by `except`. A settled record holds nothing and is left as it is: this reads only, so a dry run and the check before an add change nothing, and the add, remove or rename that then acts removes it (`removeSettledNameRenames`). `action` completes "Cannot ...". */
export function requireNoInterruptedNameRename(paths: LayoutPaths, name: string, action: string, except?: { readonly id: string; readonly from: string; readonly to: string }): void {
  const held = unfinishedNameRenames(paths).find((record) => (record.from === name || record.to === name) && !(record.id === except?.id && record.from === except.from && record.to === except.to));
  if (held !== undefined) {
    throw new InterruptedNameRenameError(action, describeInterruptedNameRename(paths, held));
  }
}

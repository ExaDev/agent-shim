import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { CliError } from "./cliError";
import { configFaultOf } from "./config/load";
import type { FarmFs } from "./launcher/ports";
import { isSystemReadError } from "./readableConfig";

/**
 * What a rename writes before its first step and keeps current until its last: the pair of names and each step with whether it was begun and whether it is done. A rename that is killed, or whose rollback fails, leaves its journal behind, and that is the only trace it leaves of being unfinished: a re-run of the same pair finds it and carries on, `doctor` reports it, and a rename of anything else that names either identity refuses until it is dealt with.
 *
 * The marks say how far a rename got, for a person and for `doctor`; they are not what a re-run trusts. A re-run plans from what is on disk, so a step that was applied is simply no longer in its plan, and one that was applied but not marked is not applied twice. A step is marked as begun before it runs and as done after, so a record shows every step that may have taken effect, which is what discarding a record on the strength of it needs.
 */
const RenameJournalSchema = z.strictObject({
  version: z.literal(1),
  from: z.string().min(1),
  to: z.string().min(1),
  startedAt: z.iso.datetime(),
  /** The process that began the rename, for a person reading the file. Whether it is still running is told by the locks, not by this. */
  pid: z.number().int().positive(),
  steps: z.array(
    z.strictObject({
      description: z.string().min(1),
      /** Whether the step has been applied and marked so. */
      done: z.boolean(),
      /** Whether the step was begun: written ahead of the step, before it runs, so a process that dies after the step took effect and before `done` was written still leaves a record that it may have. */
      started: z.boolean(),
    }),
  ),
});

export type RenameJournal = z.infer<typeof RenameJournalSchema>;

/** The filesystem operations the journal needs. */
export type RenameJournalFs = Pick<FarmFs, "readFileUtf8" | "readdir" | "mkdirPrivate" | "writeFilePrivate" | "removeRecursive">;

/** How many hex digits of the pair's hash name its file: enough that two pairs never share a file. */
const FILE_NAME_HASH_DIGITS = 16;

const JOURNAL_SUFFIX = ".json";

/** Raised when a journal file is there but is not a journal this release can read. */
class RenameJournalUnreadableError extends CliError {
  constructor(file: string, readonly detail: string) {
    super(`${file} is not a rename journal this agent-shim can read (${detail}). If no rename was left unfinished, remove it; otherwise look at what it names before renaming anything.`);
    this.name = "RenameJournalUnreadableError";
  }
}

/** The file in `directory` that holds the journal of renaming `from` to `to`. It is named for a hash of the pair, because names may contain any character a file name can, and so no two pairs can share one however they are spelled. */
export function renameJournalFile(directory: string, from: string, to: string): string {
  return path.join(directory, renamePairFileName(from, to, JOURNAL_SUFFIX));
}

/** The file name, ending `suffix`, that state about renaming `from` to `to` is kept under: a hash of the pair, joined by NUL, which no name contains, so two pairs never share one however their names are spelled (`a--b` to `c` and `a` to `b--c` included), and its length is fixed whatever the names' lengths, so two of the longest names still make a file name the filesystem accepts. */
export function renamePairFileName(from: string, to: string, suffix: string): string {
  return `${createHash("sha256").update(`${from}\u0000${to}`).digest("hex").slice(0, FILE_NAME_HASH_DIGITS)}${suffix}`;
}

/** The journal in `file`, or undefined when there is none. Throws `RenameJournalUnreadableError` for a file that is there but is not a journal, or that the system will not let it read (a directory in its place, no permission). */
export function readRenameJournal(fs: Pick<RenameJournalFs, "readFileUtf8">, file: string): RenameJournal | undefined {
  let raw: string | undefined;
  try {
    raw = fs.readFileUtf8(file);
  } catch (error) {
    if (!isSystemReadError(error)) {
      throw error;
    }
    throw new RenameJournalUnreadableError(file, `cannot be read: ${configFaultOf(error)}`);
  }
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RenameJournalUnreadableError(file, "not valid JSON");
  }
  const result = RenameJournalSchema.safeParse(parsed);
  if (!result.success) {
    throw new RenameJournalUnreadableError(file, result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  }
  return result.data;
}

/** A file in the journals directory that is not a journal this release can read, and why. */
interface UnreadableRenameJournal {
  readonly file: string;
  readonly detail: string;
}

/** What is in the journals directory: the unfinished renames, and the files that are not journals. */
export interface RenameJournalListing {
  readonly journals: readonly RenameJournal[];
  readonly unreadable: readonly UnreadableRenameJournal[];
}

/** Everything in `directory` that looks like a journal, sorted by file name, those that can be read and those that cannot. `doctor` reports both. */
export function listRenameJournals(fs: Pick<RenameJournalFs, "readFileUtf8" | "readdir">, directory: string): RenameJournalListing {
  const journals: RenameJournal[] = [];
  const unreadable: UnreadableRenameJournal[] = [];
  for (const name of [...fs.readdir(directory)].sort()) {
    if (!name.endsWith(JOURNAL_SUFFIX)) {
      continue;
    }
    const file = path.join(directory, name);
    try {
      const journal = readRenameJournal(fs, file);
      if (journal !== undefined) {
        journals.push(journal);
      }
    } catch (error) {
      if (!(error instanceof RenameJournalUnreadableError)) {
        throw error;
      }
      unreadable.push({ file, detail: error.detail });
    }
  }
  return { journals, unreadable };
}

/** Every journal in `directory`, the unfinished renames. Throws `RenameJournalUnreadableError` for a file in it that is not one, since a damaged journal cannot say what it was about and a rename must not go ahead beside it. */
export function readRenameJournals(fs: Pick<RenameJournalFs, "readFileUtf8" | "readdir">, directory: string): readonly RenameJournal[] {
  const { journals, unreadable } = listRenameJournals(fs, directory);
  const [first] = unreadable;
  if (first !== undefined) {
    throw new RenameJournalUnreadableError(first.file, first.detail);
  }
  return journals;
}

/** Replaces the journal in `file`, creating its directory owner-only, atomically and owner-only. */
export function writeRenameJournal(fs: Pick<RenameJournalFs, "mkdirPrivate" | "writeFilePrivate">, file: string, journal: Readonly<RenameJournal>): void {
  fs.mkdirPrivate(path.dirname(file));
  // Durable: a step is recorded as begun before it runs so that the record is there if the process dies mid-step, and a power cut loses what was not flushed.
  fs.writeFilePrivate(file, `${JSON.stringify(RenameJournalSchema.parse(journal), null, 2)}\n`, { durable: true });
}

/** Removes the journal; one that is already gone is fine. */
export function removeRenameJournal(fs: Pick<RenameJournalFs, "removeRecursive">, file: string): void {
  fs.removeRecursive(file);
}

/** What an unfinished rename means for a new rename of `from` to `to`. */
export type UnfinishedRename = { readonly kind: "resume"; readonly journal: RenameJournal } | { readonly kind: "blocked"; readonly journal: RenameJournal };

/**
 * The unfinished rename, if any, that a rename of `from` to `to` has to deal with. A journal of the same rename, named exactly, is resumed. A journal that names either identity in any other way (the reverse direction, either name paired with another, or a name `sameName` takes for one of its own, such as another spelling of it that reaches the same directory, besides the exact name, which always counts) blocks, because the identities are partly moved and anything else done to them now would be done to a state nobody chose. `sameName` defaults to never taking another name for one held.
 */
export function unfinishedRenameFor(journals: readonly RenameJournal[], from: string, to: string, sameName: (first: string, second: string) => boolean = () => false): UnfinishedRename | undefined {
  const same = journals.find((journal) => journal.from === from && journal.to === to);
  if (same !== undefined) {
    return { kind: "resume", journal: same };
  }
  const holds = (held: string, name: string): boolean => held === name || sameName(held, name);
  const involved = journals.find((journal) => [journal.from, journal.to].some((name) => holds(name, from) || holds(name, to)));
  return involved === undefined ? undefined : { kind: "blocked", journal: involved };
}

/** Whether a run of the rename can finish it, and when it cannot, why. A rename that can be finished is also `discardable` when the journal records no step as begun or done and the identity is still under the old name: that is exactly what `--discard-journal` checks, and it is a rename that was rolled back completely or ended before its first step. A step is recorded as begun before it runs, so a process that died after a step took effect and before it was marked done is never taken for one that applied nothing. */
export type RenameFinishability = { readonly finishable: true; readonly discardable?: true } | { readonly finishable: false; readonly reason: string };

/** Whether a step may have been applied according to its marks: it is done, or it was begun, which is written before the step runs so that a process that died after the step took effect and before it was marked done is still counted. */
function stepMayBeApplied(step: Readonly<RenameJournal["steps"][number]>): boolean {
  return step.done || step.started;
}

/** Whether `journal` records no step as begun or done, which a run that rolled back completely, or was ended before its first step, leaves. Only then can the record be discarded on the strength of the journal: a step begun and not done may have taken effect. */
export function recordsNothingApplied(journal: Readonly<Pick<RenameJournal, "steps">>): boolean {
  return !journal.steps.some(stepMayBeApplied);
}

/** Why no run of the rename can finish it: the identity is under neither name, or under both. */
export function describeUnfinishable(bothExist: boolean): string {
  return bothExist ? "both names are identities" : "there is no identity under either name";
}

/** Whether the rename in `journal` can be finished, given which names are identities: it can when the identity is under exactly one of them, wherever the earlier run got it to. */
export function finishabilityOf(journal: Readonly<Pick<RenameJournal, "from" | "to" | "steps">>, exists: (name: string) => boolean): RenameFinishability {
  const underFrom = exists(journal.from);
  if (underFrom === exists(journal.to)) {
    return { finishable: false, reason: describeUnfinishable(underFrom) };
  }
  return underFrom && recordsNothingApplied(journal) ? { finishable: true, discardable: true } : { finishable: true };
}

/** The command that removes the record of the unfinished rename in `journal`, and nothing else. */
export function discardJournalCommand(journal: Readonly<Pick<RenameJournal, "from" | "to">>): string {
  return `agent-shim identity rename ${journal.from} ${journal.to} --move --discard-journal`;
}

/** The journal as a sentence for a refusal or for `doctor`: the pair, how far it got, and what to do about it. A rename that can be finished is told the command that finishes it, and the command that discards its record too when that loses nothing; one that cannot is told why and the command that discards its record, never the command that would fail. */
export function describeUnfinishedRename(journal: Readonly<RenameJournal>, finishability: RenameFinishability): string {
  const applied = journal.steps.filter(stepMayBeApplied).length;
  const progress = `an unfinished rename of identity "${journal.from}" to "${journal.to}" (${String(applied)} of ${String(journal.steps.length)} steps recorded as begun or done)`;
  return finishability.finishable
    ? `${progress}. Finish it with \`agent-shim identity rename ${journal.from} ${journal.to} --move\`; to put the name back afterwards, run \`agent-shim identity rename ${journal.to} ${journal.from} --move\`.${finishability.discardable === true ? ` No step is recorded as begun or done and the identity is still under "${journal.from}", so its record can be discarded with \`${discardJournalCommand(journal)}\`; that removes only the record.` : ""}`
    : `${progress} that cannot be finished: ${finishability.reason}. If nothing is left of it to keep, discard its record with \`${discardJournalCommand(journal)}\`; that removes only the record and changes no identity.`;
}

/** Raised when an operation on an identity's name is refused because an unfinished rename names it: the identities are partly moved, and anything done to either name now would be done to a state nobody chose. */
class NameHeldByUnfinishedRenameError extends CliError {
  constructor(action: string, name: string, journal: Readonly<RenameJournal>, finishability: RenameFinishability) {
    super(`Cannot ${action} identity "${name}": there is ${describeUnfinishedRename(journal, finishability)}`);
    this.name = "NameHeldByUnfinishedRenameError";
  }
}

/**
 * Throws `NameHeldByUnfinishedRenameError` when an unfinished rename in `directory` holds `name`, as its old name or its new one, so `action` (`add`, `remove`) is refused until the rename is finished or its journal discarded. A name holds the same identity as a held one when it is equal to it or `sameName` says the two are one directory, which a symlink makes them and a filesystem that ignores case makes two spellings of one name: either would reach the identity the rename is moving or create the one it will find at its target. A file that is not a journal names no identity and is left to `doctor`, which reports it.
 */
export function requireNameFreeOfUnfinishedRename(fs: Pick<RenameJournalFs, "readFileUtf8" | "readdir">, directory: string, name: string, action: string, sameName: (first: string, second: string) => boolean, exists: (name: string) => boolean): void {
  const held = listRenameJournals(fs, directory).journals.find((journal) => [journal.from, journal.to].some((heldName) => heldName === name || sameName(name, heldName)));
  if (held !== undefined) {
    throw new NameHeldByUnfinishedRenameError(action, name, held, finishabilityOf(held, exists));
  }
}

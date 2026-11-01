import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { CliError } from "./cliError";
import type { FarmFs } from "./launcher/ports";

/**
 * What a rename writes before its first step and keeps current until its last: the pair of names and each step with whether it is done. A rename that is killed, or whose rollback fails, leaves its journal behind, and that is the only trace it leaves of being unfinished: a re-run of the same pair finds it and carries on, `doctor` reports it, and a rename of anything else that names either identity refuses until it is dealt with.
 *
 * The `done` marks say how far a rename got, for a person and for `doctor`; they are not what a re-run trusts. A re-run plans from what is on disk, so a step that was applied is simply no longer in its plan, and one that was applied but not marked is not applied twice.
 */
const RenameJournalSchema = z.strictObject({
  version: z.literal(1),
  from: z.string().min(1),
  to: z.string().min(1),
  startedAt: z.iso.datetime(),
  /** The process that began the rename, for a person reading the file. Whether it is still running is told by the locks, not by this. */
  pid: z.number().int().positive(),
  steps: z.array(z.strictObject({ description: z.string().min(1), done: z.boolean() })),
});

export type RenameJournal = z.infer<typeof RenameJournalSchema>;

/** The filesystem operations the journal needs. */
export type RenameJournalFs = Pick<FarmFs, "readFileUtf8" | "readdir" | "mkdirPrivate" | "writeFilePrivate" | "removeRecursive">;

/** How many hex digits of the pair's hash name its journal file: enough that two pairs never share a file. */
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
  return path.join(directory, `${createHash("sha256").update(`${from}\u0000${to}`).digest("hex").slice(0, FILE_NAME_HASH_DIGITS)}${JOURNAL_SUFFIX}`);
}

/** The journal in `file`, or undefined when there is none. Throws `RenameJournalUnreadableError` for a file that is there but is not a journal. */
export function readRenameJournal(fs: Pick<RenameJournalFs, "readFileUtf8">, file: string): RenameJournal | undefined {
  const raw = fs.readFileUtf8(file);
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
  fs.writeFilePrivate(file, `${JSON.stringify(RenameJournalSchema.parse(journal), null, 2)}\n`);
}

/** Removes the journal; one that is already gone is fine. */
export function removeRenameJournal(fs: Pick<RenameJournalFs, "removeRecursive">, file: string): void {
  fs.removeRecursive(file);
}

/** What an unfinished rename means for a new rename of `from` to `to`. */
export type UnfinishedRename = { readonly kind: "resume"; readonly journal: RenameJournal } | { readonly kind: "blocked"; readonly journal: RenameJournal };

/**
 * The unfinished rename, if any, that a rename of `from` to `to` has to deal with. A journal of the same rename is resumed. A journal that names either identity in any other way (the reverse direction, or either name paired with another) blocks, because the identities are partly moved and anything else done to them now would be done to a state nobody chose.
 */
export function unfinishedRenameFor(journals: readonly RenameJournal[], from: string, to: string): UnfinishedRename | undefined {
  const same = journals.find((journal) => journal.from === from && journal.to === to);
  if (same !== undefined) {
    return { kind: "resume", journal: same };
  }
  const involved = journals.find((journal) => [journal.from, journal.to].some((name) => name === from || name === to));
  return involved === undefined ? undefined : { kind: "blocked", journal: involved };
}

/** The journal as a sentence for a refusal or for `doctor`: the pair, how far it got, and the command that finishes it. */
export function describeUnfinishedRename(journal: Readonly<RenameJournal>): string {
  const done = journal.steps.filter((step) => step.done).length;
  return `an unfinished rename of identity "${journal.from}" to "${journal.to}" (${String(done)} of ${String(journal.steps.length)} steps recorded as done). Finish it with \`agent-shim identity rename ${journal.from} ${journal.to}\`; to put the name back afterwards, run \`agent-shim identity rename ${journal.to} ${journal.from}\`.`;
}

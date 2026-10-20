import type { ColourRole } from "../../palette";
import { vcsStatusOf } from "../../vcs/status";
import type { ChangedFile } from "../../vcs/types";
import type { RenderContext, RowOutput } from "../context";

/** The most changed files named: the line is one line, and the files changed last are the ones a person is working on, so the rest are counted. */
const MAX_FILES_SHOWN = 6;

/** The narrowest terminal that draws the line: below it most entries would be cut off by the client, so the row draws nothing rather than a stub. */
const MIN_COLUMNS = 60;

const KIND_MARKS: Readonly<Record<ChangedFile["kind"], { readonly mark: string; readonly role: ColourRole }>> = {
  added: { mark: "+", role: "context" },
  deleted: { mark: "-", role: "critical" },
  modified: { mark: "~", role: "warning" },
};

/** The git working tree's changed files on one line: up to six tracked files, the most recently modified first, each marked `+` added, `~` modified or `-` deleted with its own lines changed when counted, then how many more there are and how many files are untracked. Draws nothing in a Jujutsu repository, outside a repository, with no changes, or in a terminal narrower than the line is worth. */
export function gitFilesRow(context: RenderContext): RowOutput {
  const { palette, terminalWidth, t } = context;
  const none: RowOutput = { kind: "text", lines: [] };
  const files = terminalWidth < MIN_COLUMNS ? undefined : vcsStatusOf(context)?.files;
  if (files === undefined || (files.tracked.length === 0 && files.untracked === 0)) {
    return none;
  }
  const shown = files.tracked.slice(0, MAX_FILES_SHOWN);
  const entries = shown.map((file) => {
    const { mark, role } = KIND_MARKS[file.kind];
    const lines = file.lines;
    const counts = lines === undefined ? [] : [...(lines.added > 0 ? [palette.paint("context", `+${String(lines.added)}`)] : []), ...(lines.deleted > 0 ? [palette.paint("critical", `-${String(lines.deleted)}`)] : [])];
    const diff = counts.length === 0 ? "" : `${palette.paint("label", "(")}${counts.join(" ")}${palette.paint("label", ")")}`;
    return `${palette.paint(role, mark)}${palette.paint(role, file.basename)}${diff}`;
  });
  const overflow = files.tracked.length - shown.length;
  if (overflow > 0) {
    entries.push(palette.paint("label", t("more", { count: overflow })));
  }
  if (files.untracked > 0) {
    entries.push(palette.paint("label", `?${String(files.untracked)}`));
  }
  return { kind: "text", lines: [entries.join("  ")] };
}

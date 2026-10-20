import { truncateWithEllipsis } from "../../ansi";
import { packLines } from "../../headerLayout";
import { writeAround } from "../../messages/around";
import type { RenderContext, RowOutput } from "../context";

/** What a running item, a finished item and the active todo are marked with, and the ellipsis that ends a cut name. */
export const RUNNING_MARK = "\u25D0";
export const DONE_MARK = "\u2713";
export const ACTIVE_MARK = "\u25B8";
export const ELLIPSIS = "\u2026";

/** The most columns of a skill's or an MCP server's name the rows draw: a name is a short identifier, so one wider than this is a long path or a mistake, and it must not push the others off the line. */
const MAX_NAME_COLUMNS = 64;

/** The most names a list row draws before it counts the rest. */
const MAX_NAMES_SHOWN = 4;

/** What a row that draws nothing returns. */
export const NO_LINES: RowOutput = { kind: "text", lines: [] };

/** The line of a list of names: a marker, the title and how many there are (followed by a plus while the transcript has not been read to its end, since the count may then be short), then the first names and a count of the others, all as the message `id` writes them. The names are broken onto further lines where the width needs it. */
export function nameListRow(id: "skills.label" | "mcp.label", names: readonly string[], complete: boolean, { palette, width, t }: RenderContext): RowOutput {
  if (names.length === 0) {
    return NO_LINES;
  }
  const label = (text: string): string => palette.paint("label", text);
  const shown = names.slice(0, MAX_NAMES_SHOWN).map((name) => palette.paint("activity", truncateWithEllipsis(name, MAX_NAME_COLUMNS, ELLIPSIS)));
  const hidden = names.length - shown.length;
  const items = [...shown, ...(hidden > 0 ? [label(t("more", { count: hidden }))] : [])];
  const [first = "", ...rest] = items;
  const head = `${palette.paint("context", DONE_MARK)} ${writeAround(t, id, first, label, `${String(names.length)}${complete ? "" : "+"}`)}`;
  const separator = t("list.separator");
  return { kind: "text", lines: packLines([head, ...rest], width, separator).map((line) => line.join(separator)) };
}

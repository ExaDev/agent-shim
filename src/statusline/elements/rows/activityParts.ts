import { truncateWithEllipsis, visibleLength } from "../../ansi";
import { packLines } from "../../headerLayout";
import { writeAround } from "../../messages/around";
import type { Translate } from "../../messages/catalogues";
import type { NamesFact } from "../../transcript/activity";
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

/** `text` after the already painted `mark`, set apart the way the language does it. */
export function markedLine(t: Translate, mark: string, text: string): string {
  return t("mark.line", { mark, text });
}

/** The columns a mark and what sets it apart from the text after it take. */
export function markColumns(t: Translate): number {
  return visibleLength(markedLine(t, DONE_MARK, ""));
}

/** `line` cut with an ellipsis to the width when it is wider, whatever it holds: the last resort for a row whose parts each have their own limits, which only a width too small for the row's fixed words can pass. */
export function fitToWidth(line: string, width: number): string {
  return truncateWithEllipsis(line, width, ELLIPSIS);
}

/** The columns left on a line of `width` after `used`, never fewer than one. A larger least would draw the same line, since the cut to the width that follows takes the extra column off again. */
export function columnsLeft(width: number, used: number): number {
  return Math.max(1, width - used);
}

/** The line of a list of names: a marker, the title and how many there are (followed by a plus while the count may be short, because the transcript has not been read to its end or the state had no room to count them all), then the first names and a count of the others, all as the message `id` writes them. The names are broken onto further lines where the width needs it, and the first name is cut to what is left of the first line after the words around it. */
export function nameListRow(id: "skills.label" | "mcp.label", facts: NamesFact, complete: boolean, { palette, width, t }: RenderContext): RowOutput {
  if (facts.names.length === 0) {
    return NO_LINES;
  }
  const label = (text: string): string => palette.paint("label", text);
  const plain = (text: string): string => text;
  const countText = `${String(facts.total)}${complete && facts.exact ? "" : "+"}`;
  const count = label(t("list.count", { count: countText }));
  const mark = palette.paint("context", DONE_MARK);
  const headColumns = visibleLength(markedLine(t, DONE_MARK, writeAround(t, id, "", plain, t("list.count", { count: countText }))));
  const paintName = (name: string, columns: number): string => palette.paint("activity", truncateWithEllipsis(name, columns, ELLIPSIS));
  const [firstName = "", ...otherNames] = facts.names.slice(0, MAX_NAMES_SHOWN);
  const first = paintName(firstName, Math.min(MAX_NAME_COLUMNS, columnsLeft(width, headColumns)));
  const rest = otherNames.map((name) => paintName(name, Math.min(MAX_NAME_COLUMNS, width)));
  const hidden = facts.total - 1 - rest.length;
  const items = [...rest, ...(hidden > 0 ? [label(t("more", { count: hidden }))] : [])];
  const head = markedLine(t, mark, writeAround(t, id, first, plain, count));
  const separator = t("list.separator");
  return { kind: "text", lines: packLines([head, ...items], width, separator).map((line) => fitToWidth(line.join(separator), width)) };
}

import { truncateWithEllipsis, visibleLength } from "../../ansi";
import { paintCore } from "../../messages/around";
import type { RenderContext, RowOutput } from "../context";
import { ACTIVE_MARK, DONE_MARK, fitToWidth, markColumns, markedLine, NO_LINES } from "./activityParts";

/** The most columns of the active todo's words the row draws: more than this is a paragraph the line has no room for. */
const MAX_TODO_COLUMNS = 50;

/** The ellipsis that ends words cut to fit, and the fewest columns worth cutting words to: the ellipsis and one character before it. Below that the words are left out and the progress stands alone. */
const TODO_ELLIPSIS = "...";
const MIN_TODO_COLUMNS = TODO_ELLIPSIS.length + 1;

/** The todo list's progress on one line: the item in progress with how many of the items are done (`\u25B8 Write the tests (2/5)`), or that all are. A list with items still to do and none in progress, an empty list and a session with no transcript to read draw nothing. The progress is always drawn whole, and the words give way to the width. */
export function todosRow({ palette, transcript, width, t }: RenderContext): RowOutput {
  // The list is an array or nothing, and an array is true however empty, so either way of falling back reads the same.
  const todos = transcript()?.activity.todos ?? [];
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  const allDone = todos.length > 0 && done === todos.length;
  if (active === undefined && !allDone) {
    return NO_LINES;
  }
  const progressText = t("todos.progress", { done, total: todos.length });
  const mark = active === undefined ? palette.paint("context", DONE_MARK) : palette.paint("warning", ACTIVE_MARK);
  // The mark and what sets it apart from the words take columns beside them and the progress, which holds the space between them itself where the language writes one.
  const room = Math.min(MAX_TODO_COLUMNS, width - markColumns(t) - visibleLength(progressText));
  // Words that draw nothing were left out of the facts, so the content here is absent or words, and either way of falling back reads the same.
  const words = room < MIN_TODO_COLUMNS ? "" : truncateWithEllipsis(active === undefined ? t("todos.allComplete") : (active.content ?? t("todos.untitled")), room, TODO_ELLIPSIS);
  const label = (text: string): string => palette.paint("label", text);
  const progress = words === "" ? paintCore(progressText.trimStart(), label) : `${words}${paintCore(progressText, label)}`;
  return { kind: "text", lines: [fitToWidth(markedLine(t, mark, progress), width)] };
}

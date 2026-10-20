import { truncateWithEllipsis, visibleLength } from "../../ansi";
import type { RenderContext, RowOutput } from "../context";
import { ACTIVE_MARK, DONE_MARK, NO_LINES } from "./activityParts";

/** The most columns of the active todo's words the row draws: more than this is a paragraph the line has no room for. */
const MAX_TODO_COLUMNS = 50;

/** The ellipsis that ends words cut to fit, and the fewest columns worth cutting words to: the ellipsis and one character before it. Below that the words are left out and the progress stands alone. */
const TODO_ELLIPSIS = "...";
const MIN_TODO_COLUMNS = TODO_ELLIPSIS.length + 1;

/** The todo list's progress on one line: the item in progress with how many of the items are done (`\u25B8 Write the tests (2/5)`), or that all are. A list with items still to do and none in progress, an empty list and a session with no transcript to read draw nothing. The progress is always drawn whole, and the words give way to the width. */
export function todosRow({ palette, transcript, width }: RenderContext): RowOutput {
  const todos = transcript()?.activity.todos ?? [];
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  const allDone = todos.length > 0 && done === todos.length;
  if (active === undefined && !allDone) {
    return NO_LINES;
  }
  const progressText = `(${String(done)}/${String(todos.length)})`;
  const mark = active === undefined ? palette.paint("context", DONE_MARK) : palette.paint("warning", ACTIVE_MARK);
  // The mark, a space after it and a space before the progress take three columns beside the words and the progress.
  const room = Math.min(MAX_TODO_COLUMNS, width - visibleLength(DONE_MARK) - 1 - 1 - visibleLength(progressText));
  const words = room < MIN_TODO_COLUMNS ? "" : `${truncateWithEllipsis(active?.content ?? "All todos complete", room, TODO_ELLIPSIS)} `;
  return { kind: "text", lines: [`${mark} ${words}${palette.paint("label", progressText)}`] };
}

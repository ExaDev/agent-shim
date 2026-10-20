import { truncateWithEllipsis } from "../../ansi";
import type { RenderContext, RowOutput } from "../context";
import { ACTIVE_MARK, DONE_MARK, NO_LINES } from "./activityParts";

/** The most columns of the active todo's words the row draws: more than this is a paragraph the line has no room for. */
const MAX_TODO_COLUMNS = 50;

/** The todo list's progress on one line: the item in progress with how many of the items are done (`\u25B8 Write the tests (2/5)`), or that all are done. A list with items still to do and none in progress, an empty list and a session with no transcript to read draw nothing. */
export function todosRow({ palette, transcript }: RenderContext): RowOutput {
  const todos = transcript()?.activity.todos ?? [];
  const done = todos.filter((todo) => todo.status === "completed").length;
  const progress = palette.paint("label", `(${String(done)}/${String(todos.length)})`);
  const active = todos.find((todo) => todo.status === "in_progress");
  if (active !== undefined) {
    return { kind: "text", lines: [`${palette.paint("warning", ACTIVE_MARK)} ${truncateWithEllipsis(active.content, MAX_TODO_COLUMNS, "...")} ${progress}`] };
  }
  return todos.length > 0 && done === todos.length ? { kind: "text", lines: [`${palette.paint("context", DONE_MARK)} All todos complete ${progress}`] } : NO_LINES;
}

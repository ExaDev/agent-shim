import { truncateWithEllipsis, visibleLength } from "../../ansi";
import { packLines, SEPARATOR } from "../../headerLayout";
import type { ToolCallFact } from "../../transcript/activity";
import type { RenderContext, RowOutput } from "../context";
import { DONE_MARK, ELLIPSIS, NO_LINES, RUNNING_MARK } from "./activityParts";

/** The most running calls the row names: a session runs a few at once, and the newest are the ones a person is waiting on. */
const MAX_RUNNING_SHOWN = 2;

/** The columns a running call's target gets, and the tools whose target is a file, which is shortened to its name when it does not fit. */
const TARGET_COLUMNS = 20;
const FILE_TOOLS: readonly string[] = ["Read", "Write", "Edit"];

/** The tool name of an MCP server's tool: `mcp__<server>__<tool>`, whose last part is the tool's own name. */
const MCP_TOOL_NAME = /^mcp__.+__.+$/;

/** A tool's name for a limit of `maxColumns` columns (0 for none): a tool of an MCP server is shown by its own name once a limit is set, and a name wider than the limit ends in an ellipsis within it. */
function shortToolName(name: string, maxColumns: number): string {
  if (maxColumns === 0) {
    return name;
  }
  const own = MCP_TOOL_NAME.test(name) ? (name.split("__").pop() ?? name) : name;
  return truncateWithEllipsis(own, maxColumns, ELLIPSIS);
}

/** What a running call acts on, for the width the row gives it: a file by its name when its whole path does not fit, anything else cut. */
function targetText(tool: ToolCallFact): string {
  const target = tool.target ?? "";
  if (!FILE_TOOLS.includes(tool.name)) {
    return truncateWithEllipsis(target, TARGET_COLUMNS, ELLIPSIS);
  }
  const path = target.replaceAll("\\", "/");
  if (visibleLength(path) <= TARGET_COLUMNS) {
    return path;
  }
  const file = path.split("/").pop() ?? path;
  return visibleLength(file) >= TARGET_COLUMNS ? truncateWithEllipsis(file, TARGET_COLUMNS, "...") : `.../${file}`;
}

/** The kinds of finished call with how many of each there are, the most used first, ties in the order first seen. */
function finishedByKind(tools: readonly ToolCallFact[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (tool.status !== "running") {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

/**
 * What the session's tools are doing, from the latest calls in its transcript: the newest running ones with what each acts on, then the kinds of finished call with how many of each, and a count of the kinds not named, joined by a separator and broken onto further lines where the width needs it. Calls to the `Skill` tool are left out when the skills row is drawn, which names them itself. A call with no result for longer than a live one can take is neither running nor finished. Nothing is drawn without a transcript to read or any call to show.
 */
export function toolsRow(context: RenderContext): RowOutput {
  const { palette, settings, width } = context;
  const hideSkills = settings.layout.rows.includes("skills");
  const tools = (context.transcript()?.activity.tools ?? []).filter((tool) => !(hideSkills && tool.name === "Skill"));
  const { nameMaxLength, maxVisible } = settings.tools;
  const running = tools.filter((tool) => tool.status === "running").slice(-MAX_RUNNING_SHOWN);
  const parts = running.map((tool) => {
    const target = targetText(tool);
    return `${palette.paint("warning", RUNNING_MARK)} ${palette.paint("activity", shortToolName(tool.name, nameMaxLength))}${target === "" ? "" : palette.paint("label", `: ${target}`)}`;
  });
  const kinds = finishedByKind(tools);
  const named = maxVisible === 0 ? kinds : kinds.slice(0, maxVisible);
  parts.push(...named.map(([name, count]) => `${palette.paint("context", DONE_MARK)} ${shortToolName(name, nameMaxLength)} ${palette.paint("label", `\u00D7${String(count)}`)}`));
  if (named.length < kinds.length) {
    parts.push(palette.paint("label", `+${String(kinds.length - named.length)} more`));
  }
  return parts.length === 0 ? NO_LINES : { kind: "text", lines: packLines(parts, width, SEPARATOR).map((line) => line.join(SEPARATOR)) };
}

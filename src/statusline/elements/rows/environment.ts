import { countConfiguration } from "../../configCounts";
import { packLines, SEPARATOR } from "../../headerLayout";
import type { RenderContext, RowOutput } from "../context";

function counted(count: number, singular: string, plural: string): string | undefined {
  return count === 0 ? undefined : `${String(count)} ${count === 1 ? singular : plural}`;
}

/** What the session's configuration holds, as a line of counts (`2 CLAUDE.md | 14 rules | 3 MCPs | 5 hooks`, each left out at zero, broken onto further lines when the width needs it); drawn only when the total reaches `environment.threshold`, and never when there is nothing to count. */
export function environmentRow(context: RenderContext): RowOutput {
  const { payload, settings, palette, ports } = context;
  const counts = countConfiguration(ports, payload.cwd ?? payload.workspace?.current_dir);
  const total = counts.claudeMd + counts.rules + counts.mcpServers + counts.hookEvents;
  if (total === 0 || total < settings.environment.threshold) {
    return { kind: "text", lines: [] };
  }
  const parts = [counted(counts.claudeMd, "CLAUDE.md", "CLAUDE.md"), counted(counts.rules, "rule", "rules"), counted(counts.mcpServers, "MCP", "MCPs"), counted(counts.hookEvents, "hook", "hooks")].filter((part) => part !== undefined);
  return { kind: "text", lines: packLines(parts.map((part) => palette.paint("label", part)), context.width, SEPARATOR).map((line) => line.join(SEPARATOR)) };
}

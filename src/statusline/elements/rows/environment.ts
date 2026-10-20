import { countConfiguration } from "../../configCounts";
import { packLines, SEPARATOR } from "../../headerLayout";
import type { RenderContext, RowOutput } from "../context";

/** The count of one kind of configuration item in words, or undefined at zero. The language has one message for a count of one and another for any other number, which `one` and `other` write. */
function counted(count: number, one: (count: number) => string, other: (count: number) => string): string | undefined {
  if (count === 0) {
    return undefined;
  }
  return count === 1 ? one(count) : other(count);
}

/** What the session's configuration holds, as a line of counts (`2 CLAUDE.md | 14 rules | 3 MCPs | 5 hooks`, each left out at zero, broken onto further lines when the width needs it); drawn only when the total reaches `environment.threshold`, and never when there is nothing to count. */
export function environmentRow(context: RenderContext): RowOutput {
  const { payload, settings, palette, ports, t } = context;
  const counts = countConfiguration(ports, payload.cwd ?? payload.workspace?.current_dir);
  const total = counts.claudeMd + counts.rules + counts.mcpServers + counts.hookEvents;
  if (total === 0 || total < settings.environment.threshold) {
    return { kind: "text", lines: [] };
  }
  const parts = [
    counted(
      counts.claudeMd,
      (count) => t("environment.claudeMd.one", { count }),
      (count) => t("environment.claudeMd.other", { count }),
    ),
    counted(
      counts.rules,
      (count) => t("environment.rules.one", { count }),
      (count) => t("environment.rules.other", { count }),
    ),
    counted(
      counts.mcpServers,
      (count) => t("environment.mcp.one", { count }),
      (count) => t("environment.mcp.other", { count }),
    ),
    counted(
      counts.hookEvents,
      (count) => t("environment.hooks.one", { count }),
      (count) => t("environment.hooks.other", { count }),
    ),
  ].filter((part) => part !== undefined);
  return { kind: "text", lines: packLines(parts.map((part) => palette.paint("label", part)), context.width, SEPARATOR).map((line) => line.join(SEPARATOR)) };
}

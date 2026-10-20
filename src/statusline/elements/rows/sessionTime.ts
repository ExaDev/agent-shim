import type { RenderContext, RowOutput } from "../context";
import { aroundValue, VALUE_MARK } from "../../messages/around";
import { formatWallClock } from "../../wallClock";
import { formatAgo } from "../sessionFormat";

/** The session's start, as a clock time with its day first when it is not today, and the time since its last response, as the parts `sessionTime.parts` names, on one line. */
export function sessionTimeRow(context: RenderContext): RowOutput {
  const session = context.transcript()?.session;
  const { palette, nowMs, settings, t } = context;
  const label = (text: string): string => palette.paint("label", text);
  const parts = settings.sessionTime.parts.flatMap((part) => {
    if (part === "started") {
      return session?.startedAtMs === undefined ? [] : aroundValue(t("sessionTime.started", { time: VALUE_MARK }), formatWallClock(session.startedAtMs, nowMs, context.ports.clock, settings.clock), label);
    }
    return session?.lastResponseAtMs === undefined ? [] : aroundValue(t("sessionTime.lastReply", { ago: VALUE_MARK }), formatAgo(nowMs - session.lastResponseAtMs, t), label);
  });
  return { kind: "text", lines: parts.length === 0 ? [] : [parts.join(` ${palette.paint("label", "\u2502")} `)] };
}

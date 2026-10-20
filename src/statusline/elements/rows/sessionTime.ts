import type { RenderContext, RowOutput } from "../context";
import { formatWallClock } from "../../wallClock";
import { formatAgo } from "../sessionFormat";

/** The session's start, as a clock time with its day first when it is not today, and the time since its last response, as the parts `sessionTime.parts` names, on one line. */
export function sessionTimeRow(context: RenderContext): RowOutput {
  const session = context.transcript()?.session;
  const { palette, nowMs, settings, t } = context;
  const parts = settings.sessionTime.parts.flatMap((part) => {
    if (part === "started") {
      return session?.startedAtMs === undefined ? [] : `${palette.paint("label", t("sessionTime.started"))} ${formatWallClock(session.startedAtMs, nowMs, context.ports.clock, settings.clock)}`;
    }
    return session?.lastResponseAtMs === undefined ? [] : `${palette.paint("label", t("sessionTime.lastReply"))} ${formatAgo(nowMs - session.lastResponseAtMs, t)}`;
  });
  return { kind: "text", lines: parts.length === 0 ? [] : [parts.join(` ${palette.paint("label", "\u2502")} `)] };
}

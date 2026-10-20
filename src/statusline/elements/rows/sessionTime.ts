import type { RenderContext, RowOutput } from "../context";
import { formatAgo, formatStartDate } from "../sessionFormat";

/** The session's start and the time since its last response, as the parts `sessionTime.parts` names, on one line. */
export function sessionTimeRow(context: RenderContext): RowOutput {
  const session = context.transcript()?.session;
  const { palette, nowMs, settings } = context;
  const parts = settings.sessionTime.parts.flatMap((part) => {
    if (part === "started") {
      return session?.startedAtMs === undefined ? [] : `${palette.paint("label", "Started:")} ${formatStartDate(session.startedAtMs, context.ports.clock.timeZone)}`;
    }
    return session?.lastResponseAtMs === undefined ? [] : `${palette.paint("label", "Last reply:")} ${formatAgo(nowMs - session.lastResponseAtMs)}`;
  });
  return { kind: "text", lines: parts.length === 0 ? [] : [parts.join(` ${palette.paint("label", "│")} `)] };
}

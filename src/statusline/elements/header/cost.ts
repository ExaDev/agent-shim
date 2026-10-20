import { formatUsd, resolveSessionCost } from "../../cost";
import { recordDailySpend } from "../../dailyLedger";
import type { RenderContext } from "../context";

/** The session's cost, as `Cost $1.23` for the client's own figure or `Est. $1.23` for one priced from the door's usage log; undefined when the session has none to state (see `resolveSessionCost`). */
export function costSegment(context: RenderContext): string | undefined {
  const cost = resolveSessionCost(context);
  if (cost === undefined) {
    return undefined;
  }
  return context.t(cost.source === "native" ? "cost.session" : "cost.estimated", { amount: formatUsd(cost.usd) });
}

/** Today's spend across the sessions seen on this machine, as `Today $12.34`; undefined until a session has been seen. Drawing it records this session's cost in the day's ledger through the state port, which is how the sessions' spends reach one another. */
export function dailyCostSegment(context: RenderContext): string | undefined {
  const spend = recordDailySpend(context.ports, context.nowMs, context.payload.session_id, resolveSessionCost(context));
  return spend === undefined ? undefined : context.t("cost.today", { amount: formatUsd(spend) });
}

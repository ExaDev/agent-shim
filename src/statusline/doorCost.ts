import { segmentDay, readUsageLog, type UsageReadFs } from "../usage/read";
import { doorCostUsdOf, type ModelPrices } from "./cost";

/** What reading a session's cost from the door's usage log takes. */
export interface DoorCostParams {
  readonly fs: UsageReadFs;
  readonly logDir: string;
  readonly prices: ModelPrices;
  /** The client's own id for the conversation (the payload's `session_id`), as the door records it from the request's header. It is not the launch's session id: a conversation cleared inside one launch starts a new id and a new client cost, and its estimate must start again with it. */
  readonly conversationId: string;
  readonly nowMs: number;
  /** How long the session has run, from the client's own total, when it reports one. */
  readonly sessionDurationMs: number | undefined;
}

/**
 * What the requests the door served for one conversation cost, priced by the configured model prices (see `doorCostUsdOf`). The log is read from the UTC day the conversation began on, since it is kept in whole-day segments and the conversation's records are in none before it; a client that reports no duration has the whole retained log read. A request whose client sent no conversation id (an older client) belongs to no conversation, so a session on such a client has no estimate.
 */
export function readDoorCostUsd(params: DoorCostParams): number | undefined {
  const { nowMs, sessionDurationMs } = params;
  const sinceMs = sessionDurationMs === undefined ? undefined : Date.parse(`${segmentDay(nowMs - sessionDurationMs)}T00:00:00.000Z`);
  const { records } = readUsageLog(params.fs, params.logDir, sinceMs === undefined ? {} : { sinceMs });
  return doorCostUsdOf(
    records.filter((record) => record.clientSessionId === params.conversationId),
    params.prices,
  );
}

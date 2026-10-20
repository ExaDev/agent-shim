import type { RenderContext, RowOutput } from "../context";
import { nameListRow, NO_LINES } from "./activityParts";

/** The MCP servers the session has used a tool of, once each in the order first used: `MCPs (2): github, playwright`. Nothing is drawn before a server's tool has been called, or without a transcript to read; the count ends in a plus while the reader is still catching up with a transcript too big to read at once. */
export function mcpRow(context: RenderContext): RowOutput {
  const facts = context.transcript();
  return facts === undefined ? NO_LINES : nameListRow("MCPs", facts.activity.mcpServers, facts.complete, context);
}

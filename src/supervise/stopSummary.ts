import { z } from "zod";

const FinishedStopSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("stop_hook_summary"),
  sessionId: z.string(),
  timestamp: z.iso.datetime(),
  preventedContinuation: z.literal(false),
  stopReason: z.literal(""),
  hookErrors: z.array(z.unknown()).length(0),
});

/** Whether the transcript proves all Stop hooks for this turn finished successfully and no later conversation activity was written. An incomplete or unknown record cannot establish that the terminal is idle. */
export function stopHooksFinished(text: string, conversationId: string, markedAt: string): boolean {
  if (!text.endsWith("\n")) {
    return false;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line === "") {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof record !== "object" || record === null || !("type" in record)) {
      return false;
    }
    if (record.type === "user" || record.type === "assistant" || record.type === "attachment") {
      return false;
    }
    if (record.type === "system" && "subtype" in record && record.subtype === "stop_hook_summary") {
      const parsed = FinishedStopSchema.safeParse(record);
      return parsed.success && parsed.data.sessionId === conversationId && Date.parse(parsed.data.timestamp) >= Date.parse(markedAt);
    }
  }
  return false;
}

import { trackSpeed } from "../../speed";
import type { RenderContext } from "../context";

/**
 * How fast the model is writing, in output tokens a second, measured between this refresh and the previous one of the session (the previous sample is kept through the ports), so it shows only while a response is streaming. The client's count of the latest request's output tokens is the measure; when the client reports none, the transcript's growth stands in for it.
 */
export function speedSegment(context: RenderContext): string | undefined {
  const transcriptPath = context.payload.transcript_path;
  if (transcriptPath === undefined || transcriptPath === "") {
    return undefined;
  }
  const outputTokens = context.payload.context_window?.current_usage?.output_tokens;
  const tokensPerSecond = trackSpeed(context.ports, transcriptPath, { at: context.nowMs, outputTokens, transcriptBytes: outputTokens === undefined ? context.transcript()?.bytes : undefined });
  return tokensPerSecond === undefined ? undefined : `out: ${tokensPerSecond.toFixed(1)} tok/s`;
}

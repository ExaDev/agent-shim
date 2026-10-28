import { transcriptKeyOf } from "../../cacheFile";
import { trackSpeed } from "../../speed";
import type { RenderContext } from "../context";

/**
 * How fast the model is writing, in output tokens a second, measured between this refresh and the previous one of the session (the previous sample is kept through the ports), so it shows only while a response is streaming. The client's count of the latest request's output tokens, in the context window frame drawn (`RenderContext.contextFrame`, so a restored last good frame gives its own count, as claude-hud's rewritten payload does), is the measure; when the frame drawn reports none, the growth of the transcript's size stands in for it: the size `StatuslinePorts.fileSize` reports for the transcript path with the white space around it removed, which the file system looks up as it is sent, as claude-hud stats it. The sample is kept by the path `transcriptKeyOf` gives; with no path, or one of white space alone, nothing is drawn and no sample is kept, as claude-hud draws none.
 */
export function speedSegment(context: RenderContext): string | undefined {
  const transcriptPath = context.payload.transcript_path;
  if (transcriptPath === undefined) {
    return undefined;
  }
  const key = transcriptKeyOf(context.ports, transcriptPath);
  if (key === undefined) {
    return undefined;
  }
  const outputTokens = context.contextFrame()?.current_usage?.output_tokens;
  // The size is read at the trimmed path as sent and not at `key`, which is cleaned as text: the file system refuses a trailing separator after a file and a `..` after a missing directory, and takes a `..` after a link to a directory from the link's target, where `key` names the file the text leaves.
  const tokensPerSecond = trackSpeed(context.ports, key, { at: context.nowMs, outputTokens, transcriptBytes: outputTokens === undefined ? context.ports.fileSize(transcriptPath.trim()) : undefined });
  return tokensPerSecond === undefined ? undefined : context.t("speed.rate", { rate: tokensPerSecond.toFixed(1) });
}

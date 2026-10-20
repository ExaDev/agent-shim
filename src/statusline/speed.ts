import { z } from "zod";

import { cacheFileFor, loadCache, saveCache } from "./cacheFile";
import type { StatuslinePorts } from "./ports";

/**
 * The longest a gap between two refreshes may be for the output between them to say how fast the model is writing now. A statusline refreshes while a response streams and not between turns, so a longer gap spans a pause, and dividing by it would report the pause.
 */
export const SPEED_WINDOW_MS = 2_000;

/** The shortest gap a speed is measured over. Refreshes can arrive several to the second while tokens stream, and a rate over so short a gap multiplies noise into a reading of thousands of tokens a second. */
export const MIN_SPEED_GAP_MS = 500;

/** How many bytes of transcript a token is taken to be when the client reports no output token count: the transcript is mostly ASCII JSON with some overhead, and an estimate in this range avoids readings far over or under the truth. */
export const TRANSCRIPT_BYTES_PER_TOKEN = 4;

/** What a refresh observed of the output: the time, the output tokens of the latest request when the client reports them, and the transcript's size, which grows with the output and stands in for tokens when the client reports none (a provider that does not fill in usage). */
export interface SpeedSample {
  readonly at: number;
  readonly outputTokens?: number | undefined;
  readonly transcriptBytes?: number | undefined;
}

/** The sample kept between refreshes, so a statusline that is a new process each time can measure against the one before. */
const SpeedSampleSchema = z.strictObject({ at: z.number(), outputTokens: z.number().optional(), transcriptBytes: z.number().optional() });

const CACHE_KIND = "speed";

const MS_PER_SECOND = 1_000;

type Basis = "outputTokens" | "transcriptBytes";

/** A sample in tokens on `basis`: counted when the client reports them, else estimated from the transcript's size. */
function tokensOf(sample: SpeedSample, basis: Basis): number | undefined {
  const value = sample[basis];
  return basis === "transcriptBytes" && value !== undefined ? value / TRANSCRIPT_BYTES_PER_TOKEN : value;
}

/**
 * The output speed in tokens a second between the previous sample and this one, and whether this sample should replace the previous. The basis is the current sample's: counted tokens when it has them, else the transcript's growth, and the previous sample must have the same one. There is no speed without an earlier sample on the same basis, when the count went backwards (a new request), when the gap spans a pause, or when nothing was written; a gap too short to measure keeps the earlier sample, so the next refresh measures over the longer gap.
 */
export function speedBetween(previous: SpeedSample | undefined, current: SpeedSample): { readonly tokensPerSecond: number | undefined; readonly remember: boolean } {
  const basis: Basis = current.outputTokens === undefined ? "transcriptBytes" : "outputTokens";
  const now = tokensOf(current, basis);
  if (now === undefined) {
    return { tokensPerSecond: undefined, remember: false };
  }
  const before = previous === undefined ? undefined : tokensOf(previous, basis);
  if (previous === undefined || before === undefined || now < before) {
    return { tokensPerSecond: undefined, remember: true };
  }
  const gapMs = current.at - previous.at;
  if (gapMs > SPEED_WINDOW_MS || now === before) {
    return { tokensPerSecond: undefined, remember: true };
  }
  if (gapMs < MIN_SPEED_GAP_MS) {
    return { tokensPerSecond: undefined, remember: false };
  }
  return { tokensPerSecond: (now - before) / (gapMs / MS_PER_SECOND), remember: true };
}

/** The output speed now, measured against the sample the previous refresh of this transcript's session kept, which this refresh replaces when the measure says to. */
export function trackSpeed(ports: StatuslinePorts, transcriptPath: string, current: SpeedSample): number | undefined {
  const file = cacheFileFor(ports, CACHE_KIND, transcriptPath);
  const { tokensPerSecond, remember } = speedBetween(loadCache(ports, file, SpeedSampleSchema), current);
  if (remember) {
    saveCache(ports, file, current, current.at);
  }
  return tokensPerSecond;
}

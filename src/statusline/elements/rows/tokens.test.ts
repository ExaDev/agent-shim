import { describe, expect, it } from "vitest";

import { resolveStatusline } from "../../../config/statusline";
import { ESCAPE } from "../../ansi";
import { createPalette } from "../../palette";
import { fakeRenderContext } from "../../testing";
import type { TranscriptFacts } from "../../transcript/reader";
import { EMPTY_ACTIVITY_FACTS } from "../../transcript/activity";
import type { SessionTokens } from "../../transcript/tokens";
import { tokensRow } from "./tokens";

const USED: SessionTokens = { inputTokens: 5000, outputTokens: 7200, cacheCreationTokens: 40_000, cacheReadTokens: 50_000 };
const NOTHING: SessionTokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
const TRANSCRIPT_BYTES = 1_000;

function facts(tokens: Readonly<SessionTokens>, complete = true): TranscriptFacts {
  return { bytes: TRANSCRIPT_BYTES, complete, session: { title: undefined, startedAtMs: undefined, lastResponseAtMs: undefined, compactions: 0, promptCache: undefined }, tokens, activity: EMPTY_ACTIVITY_FACTS };
}

/** The row drawn from the transcript facts given (none when the transcript cannot be read), with the label colour set when `label` is. */
function draw(transcript: TranscriptFacts | undefined, label?: string): readonly string[] {
  const settings = resolveStatusline(label === undefined ? {} : { colours: { label: "cyan" } });
  const output = tokensRow(fakeRenderContext({ settings, palette: createPalette(settings.colours, true), transcript: () => transcript }));
  expect(output.kind).toBe("text");
  return output.kind === "text" ? output.lines : [];
}

describe("the session tokens row", () => {
  it("draws the total with the input, output and cache shares", () => {
    expect(draw(facts(USED))).toEqual(["Tokens 102k (in: 5.0k, out: 7.2k, cache: 90k)"]);
  });

  it("leaves the cache share out when nothing was cached", () => {
    expect(draw(facts({ ...USED, cacheCreationTokens: 0, cacheReadTokens: 0 }))).toEqual(["Tokens 12k (in: 5.0k, out: 7.2k)"]);
  });

  it("ends the total in a plus when the transcript was too big to read whole, as the compaction count does", () => {
    expect(draw(facts(USED, false))).toEqual(["Tokens 102k+ (in: 5.0k, out: 7.2k, cache: 90k)"]);
  });

  it("draws nothing without a transcript to read, or with nothing used", () => {
    expect(draw(undefined)).toEqual([]);
    expect(draw(facts(NOTHING))).toEqual([]);
  });

  it("paints the row in the label colour", () => {
    expect(draw(facts(USED), "cyan")[0]?.startsWith(`${ESCAPE}[36mTokens`)).toBe(true);
  });
});

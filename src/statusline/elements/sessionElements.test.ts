import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../../config/statusline";
import type { StatuslineSummary } from "../enrich";
import { ESCAPE } from "../ansi";
import { parseClientPayload } from "../payload";
import { renderStatuslineBlock } from "../render";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, type FakeStatuslineFilesystem } from "../testing";
import { MAX_TRANSCRIPT_READ_BYTES } from "../transcript/reader";

const TRANSCRIPT = "/sessions/one.jsonl";
const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Offsets from `T0`, named for what they are. */
const AT = {
  thirtySeconds: 30_000,
  fortySeconds: 40_000,
  twoMinutes: 120_000,
  threeMinutes: 180_000,
  fourMinutes: 240_000,
  fiveMinutes: 300_000,
  sixMinutes: 360_000,
  tenMinutes: 600_000,
  elevenMinutes: 660_000,
  fifteenMinutes: 900_000,
  fortySevenMinutes: 2_820_000,
  fortyNineMinutes: 2_940_000,
  fourHours: 14_400_000,
  /** Three days and four hours after the reply at thirty seconds. */
  threeDaysFourHoursAfterReply: 273_630_000,
};
const WIDE_TERMINAL = 170;
/** The midnight that starts 20 October 2026 in the time zone of the fake ports, which is UTC. */
/** Where `HH:MM` sits in an ISO timestamp. */
const CLOCK_FROM = 11;
const CLOCK_TO = 16;
const MIDNIGHT = "2026-10-20T00:00:00Z";
/** The bytes of a line of transcript filler, and how many times the filler repeats so the transcript outgrows a read. */
const FILLER_BYTES = 1_000;
const FILLER_READS = 3;
/** A message long enough to count as transcript growth, and the bytes of transcript a token is estimated from. */
const GROWTH_CHARACTERS = 300;
const BYTES_PER_TOKEN = 4;

const SUMMARY: StatuslineSummary = {
  identity: undefined,
  provider: undefined,
  providerAccountEmail: undefined,
  providerAccountSub: undefined,
  providerPlan: undefined,
  loginAccountEmail: undefined,
  loginRateLimitTier: undefined,
  loginOrganizationName: undefined,
  loginOrganizationType: undefined,
  loginSeatTier: undefined,
  loginPlan: undefined,
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
  fiveHourUsed: undefined,
  fiveHourResetAt: undefined,
  sevenDayUsed: undefined,
  sevenDayResetAt: undefined,
};

const at = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*[a-zA-Z]`, "g");
const plain = (text: string): string => text.replace(ANSI, "");

/** A session that started at `T0`, was renamed, was answered 30 seconds after its first prompt on the five-minute tier, and was compacted once. */
const SESSION =
  line({ type: "user", timestamp: at(0), slug: "generated-name", message: { content: "hello" } }) +
  line({ type: "assistant", timestamp: at(AT.thirtySeconds), requestId: "r1", message: { model: "m", usage: { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } } } }) +
  line({ type: "system", subtype: "compact_boundary", timestamp: at(AT.fortySeconds) }) +
  line({ type: "custom-title", customTitle: "renamed" });

interface Rendered {
  readonly text: string;
  readonly lines: readonly string[];
}

/** One render at `nowMs` of a session whose transcript is `transcript`, under `settings`. */
function render(nowMs: number, settings: StatuslineSettings, options: { readonly transcript?: string; readonly outputTokens?: number; readonly files?: Record<string, string>; readonly disk?: FakeStatuslineFilesystem; readonly env?: Record<string, string>; readonly timeZone?: string } = {}): Rendered {
  const disk = options.disk ?? fakeStatuslineFilesystem(options.files ?? { [TRANSCRIPT]: options.transcript ?? SESSION });
  const text = renderStatuslineBlock({
    summary: SUMMARY,
    view: { modelDisplayName: "Sonnet 5.5", contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
    payload: parseClientPayload({ transcript_path: TRANSCRIPT, ...(options.outputTokens === undefined ? {} : { context_window: { current_usage: { output_tokens: options.outputTokens } } }) }),
    terminalWidth: WIDE_TERMINAL,
    nowMs,
    settings: resolveStatusline(settings),
    ports: fakeStatuslinePorts({ ...disk.ports, env: options.env ?? {}, ...(options.timeZone === undefined ? {} : { clock: { locale: "en-GB", timeZone: options.timeZone } }) }),
  });
  return { text, lines: plain(text).split("\n") };
}

/** The wall-clock time of `ms` past `T0` as `HH:MM` in UTC, the time zone of the fake ports, written out by hand so the test does not share the code's formatter. */
function clock(ms: number): string {
  return new Date(T0 + ms).toISOString().slice(CLOCK_FROM, CLOCK_TO);
}

const header = (...names: readonly ("sessionName" | "duration" | "speed" | "model")[]): StatuslineSettings => ({ layout: { header: [...names], rows: [] } });
const rows = (...names: readonly ("sessionTime" | "promptCache" | "compactions")[]): StatuslineSettings => ({ layout: { header: [], rows: [...names] } });

describe("the session elements", () => {
  it("draw nothing and read no transcript by default, so a default statusline is what it was", () => {
    const unreadable = fakeStatuslinePorts({
      readRange: () => {
        throw new Error("the transcript was read");
      },
      writeText: () => {
        throw new Error("a cache file was written");
      },
    });
    const input = { summary: SUMMARY, view: { modelDisplayName: "Sonnet 5.5", contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined }, payload: parseClientPayload({ transcript_path: TRANSCRIPT }), terminalWidth: WIDE_TERMINAL, nowMs: T0, ports: unreadable };
    expect(plain(renderStatuslineBlock(input))).toBe("Sonnet 5.5");
  });

  describe("the session name", () => {
    it("is the title `/rename` gave the session, else the generated one", () => {
      expect(render(T0, header("sessionName")).lines).toEqual(["renamed"]);
      expect(render(T0, header("sessionName"), { transcript: line({ type: "user", timestamp: at(0), slug: "generated-name" }) }).lines).toEqual(["generated-name"]);
    });

    it("is left out when the transcript names no session, or cannot be read", () => {
      expect(render(T0, header("model", "sessionName"), { transcript: line({ type: "user", timestamp: at(0) }) }).lines).toEqual(["Sonnet 5.5"]);
      expect(render(T0, header("model", "sessionName"), { files: {} }).lines).toEqual(["Sonnet 5.5"]);
    });

    it("removes the escape sequences and control characters a name carries, so it cannot reach the terminal", () => {
      const hostile = line({ type: "custom-title", customTitle: "\u001b[2J\u001b]0;pwned\u0007x\u0000y" });
      expect(render(T0, header("sessionName"), { transcript: line({ type: "user", timestamp: at(0) }) + hostile }).text).toBe("xy");
      expect(render(T0, header("model", "sessionName"), { transcript: line({ type: "custom-title", customTitle: "\u001b[2J" }) }).lines).toEqual(["Sonnet 5.5"]);
    });

    it("takes the label colour", () => {
      expect(render(T0, { ...header("sessionName"), colours: { label: "red" } }).text).toBe(`${ESCAPE}[31mrenamed${ESCAPE}[0m`);
    });
  });

  describe("the duration", () => {
    it("is the time since the transcript's first timestamp", () => {
      expect(render(T0 + AT.thirtySeconds, header("duration")).lines[0]).toContain("<1m");
      expect(render(T0 + AT.fiveMinutes, header("duration")).lines[0]).toContain("5m");
      expect(render(T0 + HOUR + AT.fiveMinutes, header("duration")).lines[0]).toContain("1h 5m");
    });

    it("is left out when the transcript has no timestamp", () => {
      expect(render(T0, header("model", "duration"), { transcript: line({ type: "permission-mode" }) }).lines).toEqual(["Sonnet 5.5"]);
    });
  });

  describe("the session time row", () => {
    it("shows the start in local time and how long ago the last reply was, on one line", () => {
      const [only] = render(T0 + AT.fiveMinutes, rows("sessionTime")).lines;
      expect(only).toMatch(/^Started: \d{4}-\d{2}-\d{2} \d{2}:\d{2} │ Last reply: 4m ago$/);
      expect(only).toContain(clock(0));
    });

    it("writes the start in the machine's time zone", () => {
      expect(render(T0, rows("sessionTime"), { timeZone: "Asia/Tokyo" }).lines[0]).toMatch(/^Started: 2026-10-19 19:00 │/);
      expect(render(T0, rows("sessionTime")).lines[0]).toMatch(/^Started: 2026-10-19 10:00 │/);
    });

    it("shows only the parts `sessionTime.parts` names, and nothing for an empty list", () => {
      expect(render(T0 + AT.fiveMinutes, { ...rows("sessionTime"), sessionTime: { parts: ["lastReply"] } }).lines).toEqual(["Last reply: 4m ago"]);
      expect(render(T0 + AT.fiveMinutes, { ...rows("sessionTime"), sessionTime: { parts: ["started"] } }).lines[0]).toMatch(/^Started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(render(T0 + AT.fiveMinutes, { ...rows("sessionTime"), sessionTime: { parts: [] } }).text).toBe("");
    });

    it("leaves out a part the transcript has nothing for", () => {
      expect(render(T0, rows("sessionTime"), { transcript: line({ type: "user", timestamp: at(0), message: { content: "hi" } }) }).lines[0]).toMatch(/^Started: /);
      expect(render(T0, rows("sessionTime"), { transcript: line({ type: "user", timestamp: at(0), message: { content: "hi" } }) }).lines[0]).not.toContain("Last reply");
    });

    it("says `just now` for a reply stamped after the clock, and counts days and hours for an old one", () => {
      expect(render(T0, { ...rows("sessionTime"), sessionTime: { parts: ["lastReply"] } }).lines).toEqual(["Last reply: just now"]);
      expect(render(T0 + AT.threeDaysFourHoursAfterReply, { ...rows("sessionTime"), sessionTime: { parts: ["lastReply"] } }).lines).toEqual(["Last reply: 3d 4h ago"]);
    });

    it("takes the label colour for its labels and separator", () => {
      const { text } = render(T0 + AT.fiveMinutes, { ...rows("sessionTime"), colours: { label: "red" } });
      expect(text).toContain(`${ESCAPE}[31mStarted:${ESCAPE}[0m`);
      expect(text).toContain(`${ESCAPE}[31m│${ESCAPE}[0m`);
    });
  });

  describe("the prompt cache row", () => {
    it("shows the clock time the cache expires, counted from the request that last refreshed it", () => {
      // The reply is anchored to the prompt at T0, and the five-minute tier shown by the cache writes puts the expiry five minutes on.
      expect(render(T0 + MINUTE, rows("promptCache")).lines).toEqual([`Cache ⏱ until ${clock(AT.fiveMinutes)}`]);
    });

    it("counts a request still waiting for its answer, which has already refreshed the cache", () => {
      const waiting = SESSION + line({ type: "user", timestamp: at(AT.tenMinutes), message: { content: "again" } });
      expect(render(T0 + AT.elevenMinutes, rows("promptCache"), { transcript: waiting }).lines).toEqual([`Cache ⏱ until ${clock(AT.fifteenMinutes)}`]);
    });

    it("takes the one-hour tier when the transcript's writes used it", () => {
      const hour = SESSION.replace('"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":0', '"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":10');
      expect(render(T0 + MINUTE, rows("promptCache"), { transcript: hour }).lines).toEqual([`Cache ⏱ until ${clock(HOUR)}`]);
    });

    it("uses `promptCache.ttlSeconds` until the transcript shows a tier, and the tier once it does", () => {
      const noWrite = line({ type: "user", timestamp: at(0), message: { content: "hi" } }) + line({ type: "assistant", timestamp: at(SECOND), requestId: "r1", message: { model: "m" } });
      expect(render(T0 + MINUTE, { ...rows("promptCache"), promptCache: { ttlSeconds: 3_600 } }, { transcript: noWrite }).lines).toEqual([`Cache ⏱ until ${clock(HOUR)}`]);
      expect(render(T0 + MINUTE, rows("promptCache"), { transcript: noWrite }).lines).toEqual([`Cache ⏱ until ${clock(AT.fiveMinutes)}`]);
      expect(render(T0 + MINUTE, { ...rows("promptCache"), promptCache: { ttlSeconds: 3_600 } }).lines).toEqual([`Cache ⏱ until ${clock(AT.fiveMinutes)}`]);
    });

    it("writes the time under the clock settings and in the machine's time zone", () => {
      expect(render(T0 + MINUTE, { ...rows("promptCache"), clock: { hourCycle: "h12" } }).lines[0]).toMatch(/^Cache ⏱ until 10:05 (am|pm)$/i);
      expect(render(T0 + MINUTE, { ...rows("promptCache"), clock: { seconds: true } }).lines).toEqual([`Cache ⏱ until ${clock(AT.fiveMinutes)}:00`]);
      expect(render(T0 + MINUTE, rows("promptCache"), { timeZone: "Asia/Tokyo" }).lines).toEqual(["Cache ⏱ until 19:05"]);
    });

    it("says it has expired once the time has passed", () => {
      expect(render(T0 + AT.fiveMinutes, rows("promptCache")).lines).toEqual(["Cache ⏱ expired"]);
      expect(render(T0 + AT.fiveMinutes - SECOND, rows("promptCache")).lines).not.toEqual(["Cache ⏱ expired"]);
    });

    it("puts the day before the time when the cache expires on another day", () => {
      // Ten minutes before the machine's own midnight, so the hour's expiry falls on the next day in whatever time zone this runs.
      const lateNight = new Date(MIDNIGHT).getTime() - AT.tenMinutes - T0;
      const transcript = line({ type: "user", timestamp: at(lateNight), message: { content: "hi" } }) + line({ type: "assistant", timestamp: at(lateNight + SECOND), requestId: "r1", message: { model: "m", usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } } } });
      const [shown] = render(T0 + lateNight + MINUTE, rows("promptCache"), { transcript }).lines;
      const expires = new Date(T0 + lateNight + HOUR);
      expect(shown).toBe(`Cache ⏱ until ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(expires)} ${clock(lateNight + HOUR)}`);
    });

    it("is green while the cache lasts, yellow in its last fifth, and the label colour once expired", () => {
      const painted = (nowMs: number): string => render(nowMs, rows("promptCache")).text;
      expect(painted(T0 + MINUTE)).toContain(`${ESCAPE}[32m⏱ until`);
      expect(painted(T0 + AT.fourMinutes + AT.thirtySeconds)).toContain(`${ESCAPE}[33m⏱ until`);
      expect(render(T0 + AT.sixMinutes, { ...rows("promptCache"), colours: { label: "cyan" } }).text).toContain(`${ESCAPE}[36m⏱ expired${ESCAPE}[0m`);
    });

    it("warns for the last minute of a five-minute cache but the last fifth of a one-hour cache", () => {
      const hour = SESSION.replace('"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":0', '"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":10');
      const painted = (nowMs: number, transcript: string): string => render(nowMs, rows("promptCache"), { transcript }).text;
      expect(painted(T0 + AT.threeMinutes, SESSION)).toContain(`${ESCAPE}[32m`);
      expect(painted(T0 + AT.fourMinutes + SECOND, SESSION)).toContain(`${ESCAPE}[33m`);
      expect(painted(T0 + AT.fortySevenMinutes, hour)).toContain(`${ESCAPE}[32m`);
      expect(painted(T0 + AT.fortyNineMinutes, hour)).toContain(`${ESCAPE}[33m`);
    });

    it("draws nothing before the main conversation has sent a request", () => {
      expect(render(T0, rows("promptCache"), { transcript: line({ type: "permission-mode" }) }).text).toBe("");
    });
  });

  describe("a transcript whose start could not be read", () => {
    const unstarted = (): string => line({ type: "mode" }).repeat((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / line({ type: "mode" }).length) + line({ type: "assistant", timestamp: at(MINUTE), requestId: "r1", message: {} });

    it("shows no duration and no start, rather than a wrong one, and still shows the last reply", () => {
      expect(render(T0 + AT.twoMinutes, header("model", "duration"), { transcript: unstarted() }).lines).toEqual(["Sonnet 5.5"]);
      expect(render(T0 + AT.twoMinutes, rows("sessionTime"), { transcript: unstarted() }).lines).toEqual(["Last reply: 1m ago"]);
    });
  });

  describe("the compactions row", () => {
    it("counts the compactions, and is hidden before the first", () => {
      expect(render(T0, rows("compactions")).lines).toEqual(["Compactions: 1"]);
      const twice = SESSION + line({ type: "system", subtype: "compact_boundary", timestamp: at(AT.twoMinutes) });
      expect(render(T0, rows("compactions"), { transcript: twice }).lines).toEqual(["Compactions: 2"]);
      expect(render(T0, rows("compactions"), { transcript: line({ type: "user", timestamp: at(0) }) }).text).toBe("");
    });

    it("ends the count in a plus when the transcript was too big to count in full", () => {
      const filler = line({ type: "user", timestamp: at(MINUTE), message: { content: "x".repeat(FILLER_BYTES) } }).repeat((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / FILLER_BYTES);
      const big = line({ type: "user", timestamp: at(0) }) + filler + line({ type: "system", subtype: "compact_boundary", timestamp: at(AT.twoMinutes) });
      expect(render(T0, rows("compactions"), { transcript: big }).lines).toEqual(["Compactions: 1+"]);
    });
  });

  describe("the speed", () => {
    it("is the output tokens written between two refreshes over the time between them", () => {
      const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: SESSION });
      expect(render(T0, header("model", "speed"), { disk, outputTokens: 100 }).lines).toEqual(["Sonnet 5.5"]);
      expect(render(T0 + SECOND, header("speed"), { disk, outputTokens: 142 }).lines).toEqual(["out: 42.0 tok/s"]);
    });

    it("is not shown across a pause, and not when the same count is seen twice", () => {
      const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: SESSION });
      render(T0, header("speed"), { disk, outputTokens: 100 });
      expect(render(T0 + MINUTE, header("speed"), { disk, outputTokens: 200 }).text).toBe("");
      expect(render(T0 + MINUTE + SECOND, header("speed"), { disk, outputTokens: 200 }).text).toBe("");
    });

    it("estimates from the transcript's growth when the client reports no output tokens", () => {
      const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: SESSION });
      render(T0, header("speed"), { disk });
      disk.files.set(TRANSCRIPT, SESSION + line({ type: "user", timestamp: at(SECOND), message: { content: "x".repeat(GROWTH_CHARACTERS) } }));
      const grown = (disk.files.get(TRANSCRIPT) ?? "").length - SESSION.length;
      expect(render(T0 + SECOND, header("speed"), { disk }).lines).toEqual([`out: ${(grown / BYTES_PER_TOKEN).toFixed(1)} tok/s`]);
    });

    it("is left out when the client names no transcript", () => {
      const text = renderStatuslineBlock({ summary: SUMMARY, view: { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined }, payload: parseClientPayload({ context_window: { current_usage: { output_tokens: 5 } } }), terminalWidth: WIDE_TERMINAL, nowMs: T0, settings: resolveStatusline(header("speed")), ports: fakeStatuslinePorts() });
      expect(text).toBe("");
    });
  });

  it("read the transcript once however many of them are drawn", () => {
    let reads = 0;
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: SESSION });
    renderStatuslineBlock({
      summary: SUMMARY,
      view: { modelDisplayName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
      payload: parseClientPayload({ transcript_path: TRANSCRIPT }),
      terminalWidth: WIDE_TERMINAL,
      nowMs: T0 + MINUTE,
      settings: resolveStatusline({ layout: { header: ["sessionName", "duration"], rows: ["sessionTime", "promptCache", "compactions"] } }),
      ports: fakeStatuslinePorts({
        ...disk.ports,
        readRange: (path, start, length) => {
          reads += 1;
          return disk.ports.readRange(path, start, length);
        },
      }),
    });
    expect(reads).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import { parseClientPayload, viewOf } from "./payload";

const COST_USD = 1.5;
const WINDOW_TOKENS = 200_000;

/** A percentage a client reports for the window, to check it passes through. */
const PERCENT_REPORTED = 45;
/** The whole window as a percentage, and a figure past it that a client could send. */
const FULL_WINDOW_PERCENT = 100;
const OVER_FULL_PERCENT = 150;
/** The size of a negative token count a client could send. */
const NEGATIVE_COUNT_MAGNITUDE = 3;
/** A list entry that is neither text nor an object. */
const NOT_TEXT = 5;

describe("parseClientPayload", () => {
  it("reads the fields the statusline uses and passes the rest through unread", () => {
    const payload = parseClientPayload({
      session_id: "s1",
      transcript_path: "/t.jsonl",
      workspace: { current_dir: "/work", added_dirs: ["/a", "/b"] },
      model: { id: "m", display_name: "Sonnet" },
      cost: { total_cost_usd: COST_USD },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: 100 }, model_scoped: [{ display_name: "Fable", utilization: 40, resets_at: "2026-10-20T00:00:00Z" }] },
      context_window: { context_window_size: WINDOW_TOKENS, exceeds_200k_tokens: false },
      somethingElse: 1,
    });
    expect(payload.session_id).toBe("s1");
    expect(payload.context_window?.context_window_size).toBe(WINDOW_TOKENS);
    expect(payload.context_window).toHaveProperty("exceeds_200k_tokens", false);
    expect(payload.workspace?.added_dirs).toEqual(["/a", "/b"]);
    expect(payload.cost?.total_cost_usd).toBe(COST_USD);
    expect(payload.rate_limits?.model_scoped?.[0]?.display_name).toBe("Fable");
    expect(payload).toHaveProperty("somethingElse", 1);
  });

  it("reads the version and the effort, whether the effort is a level name or an object carrying one", () => {
    expect(parseClientPayload({ version: "2.1.81", effort: "high" })).toMatchObject({ version: "2.1.81", effort: "high" });
    expect(parseClientPayload({ effort: { level: "max", budget: 1 } }).effort).toEqual({ level: "max", budget: 1 });
    expect(parseClientPayload({ version: 2, effort: 3 })).toEqual({ version: undefined, effort: undefined });
  });

  it("reads a field of the wrong type, or null, as absent without discarding its neighbours", () => {
    const payload = parseClientPayload({ session_id: 7, model: { id: "m", display_name: null }, context_window: { used_percentage: "10", context_window_size: WINDOW_TOKENS, total_input_tokens: null, current_usage: "x" } });
    expect(payload.session_id).toBeUndefined();
    expect(payload.model).toEqual({ id: "m", display_name: undefined });
    expect(payload.context_window?.context_window_size).toBe(WINDOW_TOKENS);
    expect(payload.context_window?.used_percentage).toBeUndefined();
    expect(payload.context_window?.total_input_tokens).toBeUndefined();
    expect(payload.context_window?.current_usage).toBeUndefined();
  });

  it("reads anything that is not a JSON object as an empty payload", () => {
    for (const raw of [undefined, null, true, "text", [1, 2]]) {
      expect(parseClientPayload(raw), String(raw)).toEqual({});
    }
  });
});

describe("viewOf", () => {
  it("takes the model name, the context window's use and the cache figures", () => {
    const view = viewOf(
      parseClientPayload({
        model: { display_name: "Sonnet 5.5" },
        context_window: { used_percentage: 63.4, total_input_tokens: 634_000, context_window_size: 1_000_000, current_usage: { cache_read_input_tokens: 600_000, input_tokens: 34_000 } },
        prompt_cache: { hit_ratio: 0.986 },
      }),
    );
    expect(view).toEqual({
      clientModelName: "Sonnet 5.5",
      contextUsedPercentage: 63.4,
      contextTotalTokens: 634_000,
      contextWindowTokens: 1_000_000,
      cacheHitRatio: 0.986,
      cacheReadTokens: 600_000,
      freshInputTokens: 34_000,
    });
  });

  it("reads a negative token total as absent, so it cannot draw as a negative share of the window", () => {
    const totalOf = (total: number): number | undefined => viewOf(parseClientPayload({ context_window: { total_input_tokens: total, context_window_size: WINDOW_TOKENS } })).contextTotalTokens;
    expect(totalOf(-1)).toBeUndefined();
    expect(totalOf(0)).toBe(0);
    expect(totalOf(WINDOW_TOKENS)).toBe(WINDOW_TOKENS);
  });

  it("reads a negative reported percentage as absent and holds one above 100 at the whole window, as claude-hud draws neither", () => {
    const percentOf = (used: number): number | undefined => viewOf(parseClientPayload({ context_window: { used_percentage: used, context_window_size: WINDOW_TOKENS } })).contextUsedPercentage;
    expect(percentOf(-1)).toBeUndefined();
    expect(percentOf(0)).toBe(0);
    expect(percentOf(PERCENT_REPORTED)).toBe(PERCENT_REPORTED);
    expect(percentOf(FULL_WINDOW_PERCENT)).toBe(FULL_WINDOW_PERCENT);
    expect(percentOf(OVER_FULL_PERCENT)).toBe(FULL_WINDOW_PERCENT);
  });

  it("reads the last request's fresh input and cache reads as the client reports them, a negative one included", () => {
    const viewOfUsage = (input: number, read: number): { readonly fresh: number | undefined; readonly read: number | undefined } => {
      const view = viewOf(parseClientPayload({ context_window: { context_window_size: WINDOW_TOKENS, current_usage: { input_tokens: input, cache_read_input_tokens: read } } }));
      return { fresh: view.freshInputTokens, read: view.cacheReadTokens };
    };
    expect(viewOfUsage(-NEGATIVE_COUNT_MAGNITUDE, -NEGATIVE_COUNT_MAGNITUDE)).toEqual({ fresh: -NEGATIVE_COUNT_MAGNITUDE, read: -NEGATIVE_COUNT_MAGNITUDE });
    expect(viewOfUsage(0, 0)).toEqual({ fresh: 0, read: 0 });
  });

  it("reads the window as the client reports it, one of 0 or below included, as claude-hud keeps the frame's own window", () => {
    const windowOf = (windowTokens: number): number | undefined => viewOf(parseClientPayload({ context_window: { context_window_size: windowTokens } })).contextWindowTokens;
    expect(windowOf(-WINDOW_TOKENS)).toBe(-WINDOW_TOKENS);
    expect(windowOf(0)).toBe(0);
    expect(windowOf(WINDOW_TOKENS)).toBe(WINDOW_TOKENS);
  });

  it("skips a list entry that cannot be used on its own, keeping the others", () => {
    const payload = parseClientPayload({
      workspace: { added_dirs: ["/work/extra-one", NOT_TEXT, null, "/work/extra-two"] },
      rate_limits: { model_scoped: [{ display_name: "Opus", utilization: PERCENT_REPORTED }, NOT_TEXT, null, { display_name: "Sonnet", utilization: PERCENT_REPORTED }] },
    });
    expect(payload.workspace?.added_dirs).toEqual(["/work/extra-one", "/work/extra-two"]);
    expect(payload.rate_limits?.model_scoped?.map((window) => window.display_name)).toEqual(["Opus", "Sonnet"]);
    expect(parseClientPayload({ workspace: { added_dirs: "/work/extra" } }).workspace?.added_dirs).toBeUndefined();
    expect(parseClientPayload({ rate_limits: { model_scoped: "Opus" } }).rate_limits?.model_scoped).toBeUndefined();
  });

  it("names the model by its display name, else by its model id, each trimmed and absent when blank", () => {
    const nameOf = (model: Readonly<Record<string, string>>): string | undefined => viewOf(parseClientPayload({ model })).clientModelName;
    expect(nameOf({ id: "claude-opus-4-5", display_name: " Opus 4.5 " })).toBe("Opus 4.5");
    expect(nameOf({ id: " claude-opus-4-5 " })).toBe("claude-opus-4-5");
    expect(nameOf({ id: "claude-opus-4-5", display_name: " " })).toBe("claude-opus-4-5");
    expect(nameOf({ id: " ", display_name: "" })).toBeUndefined();
    // Trimming strips every kind of white space, not only the space: a tab, a line break, a no-break space, an em space and an ideographic space.
    expect(nameOf({ display_name: "\t\u00a0Opus 4.5\u2003\u3000\n" })).toBe("Opus 4.5");
    expect(nameOf({ id: "\tclaude-opus-4-5\n", display_name: "\u00a0\u2003\u3000" })).toBe("claude-opus-4-5");
  });

  it("leaves every figure absent for an empty payload", () => {
    expect(Object.values(viewOf(parseClientPayload({}))).every((value) => value === undefined)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { parseClientPayload, viewOf } from "./payload";

const COST_USD = 1.5;
const WINDOW_TOKENS = 200_000;

describe("parseClientPayload", () => {
  it("reads the fields the statusline uses and passes the rest through unread", () => {
    const payload = parseClientPayload({
      session_id: "s1",
      transcript_path: "/t.jsonl",
      workspace: { current_dir: "/work", added_dirs: ["/a", "/b"] },
      model: { id: "m", display_name: "Sonnet" },
      cost: { total_cost_usd: COST_USD },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: 100 }, model_scoped: [{ display_name: "Fable", utilization: 40, resets_at: "2026-10-20T00:00:00Z" }] },
      somethingElse: 1,
    });
    expect(payload.session_id).toBe("s1");
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
    const payload = parseClientPayload({ session_id: 7, model: { id: "m", display_name: null }, context_window: { used_percentage: "10", context_window_size: WINDOW_TOKENS, total_input_tokens: null } });
    expect(payload.session_id).toBeUndefined();
    expect(payload.model).toEqual({ id: "m", display_name: undefined });
    expect(payload.context_window?.context_window_size).toBe(WINDOW_TOKENS);
    expect(payload.context_window?.used_percentage).toBeUndefined();
    expect(payload.context_window?.total_input_tokens).toBeUndefined();
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

  it("names the model by its display name, else by its model id, each trimmed and absent when blank", () => {
    const nameOf = (model: Readonly<Record<string, string>>): string | undefined => viewOf(parseClientPayload({ model })).clientModelName;
    expect(nameOf({ id: "claude-opus-4-5", display_name: " Opus 4.5 " })).toBe("Opus 4.5");
    expect(nameOf({ id: " claude-opus-4-5 " })).toBe("claude-opus-4-5");
    expect(nameOf({ id: "claude-opus-4-5", display_name: " " })).toBe("claude-opus-4-5");
    expect(nameOf({ id: " ", display_name: "" })).toBeUndefined();
  });

  it("leaves every figure absent for an empty payload", () => {
    expect(Object.values(viewOf(parseClientPayload({}))).every((value) => value === undefined)).toBe(true);
  });
});

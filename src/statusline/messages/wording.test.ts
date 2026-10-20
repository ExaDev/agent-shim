import { describe, expect, it } from "vitest";

import { CATALOGUES, fillPlaceholders, type MessageId } from "./catalogues";

/** Every message written out for sample values in each language, so that a change of wording, word order or punctuation in any of them has to be made here as well: id, the values its placeholders take, and the text in English, simplified Chinese and traditional Chinese. */
const WORDING: readonly (readonly [MessageId, Readonly<Record<string, string | number>>, string, string, string])[] = [
  ["context.label", {}, "Ctx", "\u4E0A\u4E0B\u6587", "\u4E0A\u4E0B\u6587"],
  ["context.cacheShare", { percent: "42%" }, "Cache: 42%", "\u7F13\u5B58\uFF1A42%", "\u5FEB\u53D6\uFF1A42%"],
  ["context.breakdown", { input: "12k", cached: "40k" }, "in: 12k, cache: 40k", "\u8F93\u5165\uFF1A12k\uFF0C\u7F13\u5B58\uFF1A40k", "\u8F38\u5165\uFF1A12k\uFF0C\u5FEB\u53D6\uFF1A40k"],
  ["quota.fiveHour", {}, "5h", "5\u5C0F\u65F6", "5\u5C0F\u6642"],
  ["quota.sevenDay", {}, "Wk", "\u672C\u5468", "\u672C\u9031"],
  ["quota.resetsIn", { time: "11:30" }, "resets in 11:30", "\u8DDD\u91CD\u7F6E 11:30", "\u8DDD\u91CD\u8A2D 11:30"],
  ["quota.resetsAt", { time: "11:30" }, "resets at 11:30", "\u91CD\u7F6E\u4E8E 11:30", "\u91CD\u8A2D\u65BC 11:30"],
  ["quota.resetsInAt", { relative: "1h 30m", time: "11:30" }, "resets in 1h 30m, at 11:30", "\u8DDD\u91CD\u7F6E 1h 30m\uFF0C\u4E8E 11:30", "\u8DDD\u91CD\u8A2D 1h 30m\uFF0C\u65BC 11:30"],
  ["quota.at", { time: "11:30" }, "at 11:30", "11:30 \u91CD\u7F6E", "11:30 \u91CD\u8A2D"],
  ["quota.relativeAt", { relative: "1h 30m", time: "11:30" }, "1h 30m, at 11:30", "1h 30m\uFF0C11:30 \u91CD\u7F6E", "1h 30m\uFF0C11:30 \u91CD\u8A2D"],
  ["quota.compactLabel", { label: "5h" }, "5h: ", "5h\uFF1A", "5h\uFF1A"],
  ["quota.available", {}, "available", "\u53EF\u7528", "\u53EF\u7528"],
  ["quota.elapsed", { percent: "42" }, "42% elapsed", "\u5DF2\u8FC7 42%", "\u5DF2\u904E 42%"],
  ["quota.elapsedAt", { elapsed: "71% elapsed", time: "11:30" }, "71% elapsed, at 11:30", "71% elapsed\uFF0C11:30 \u91CD\u7F6E", "71% elapsed\uFF0C11:30 \u91CD\u8A2D"],
  ["memory.label", {}, "RAM", "\u5185\u5B58", "\u8A18\u61B6\u9AD4"],
  ["cost.session", { amount: "$1.25" }, "Cost $1.25", "\u8D39\u7528 $1.25", "\u8CBB\u7528 $1.25"],
  ["cost.estimated", { amount: "$1.25" }, "Est. $1.25", "\u4F30\u7B97 $1.25", "\u4F30\u7B97 $1.25"],
  ["cost.today", { amount: "$1.25" }, "Today $1.25", "\u4ECA\u65E5 $1.25", "\u4ECA\u65E5 $1.25"],
  ["advisor.name", { name: "Opus" }, "Advisor: Opus", "\u987E\u95EE\uFF1AOpus", "\u9867\u554F\uFF1AOpus"],
  ["outputStyle.name", { name: "Opus" }, "style: Opus", "\u8F93\u51FA\u98CE\u683C\uFF1AOpus", "\u8F38\u51FA\u98A8\u683C\uFF1AOpus"],
  ["route.via", { target: "zeta/glm" }, "via zeta/glm", "\u7ECF\u7531 zeta/glm", "\u7D93\u7531 zeta/glm"],
  ["speed.rate", { rate: "42.0" }, "out: 42.0 tok/s", "\u8F93\u51FA\uFF1A42.0 tok/s", "\u8F38\u51FA\uFF1A42.0 tok/s"],
  ["headroom.label", { parts: "A, B" }, "headroom A, B", "headroom A, B", "headroom A, B"],
  ["headroom.saved", { tokens: "42k" }, "42k saved", "\u5DF2\u8282\u7701 42k", "\u5DF2\u7BC0\u7701 42k"],
  ["headroom.overall", { percent: "42" }, "42% overall", "\u603B\u8BA1 42%", "\u7E3D\u8A08 42%"],
  ["version.label", { version: "2.1.0" }, "CC v2.1.0", "CC v2.1.0", "CC v2.1.0"],
  ["vcs.conflict", {}, "!conflict", "!\u51B2\u7A81", "!\u885D\u7A81"],
  ["vcs.detached", { commit: "abc1234" }, "detached:abc1234", "\u5206\u79BB\u4E8E abc1234", "\u5206\u96E2\u65BC abc1234"],
  ["effort.low", {}, "low", "\u4F4E", "\u4F4E"],
  ["effort.medium", {}, "medium", "\u4E2D", "\u4E2D"],
  ["effort.high", {}, "high", "\u9AD8", "\u9AD8"],
  ["effort.xhigh", {}, "xhigh", "\u8D85\u9AD8", "\u8D85\u9AD8"],
  ["effort.max", {}, "max", "\u6700\u9AD8", "\u6700\u9AD8"],
  ["more", { count: "3" }, "+3 more", "\u53E6\u6709 3 \u4E2A", "\u53E6\u6709 3 \u500B"],
  ["addedDirs.label", { dirs: "d0, d1" }, "Added dirs: d0, d1", "\u9644\u52A0\u76EE\u5F55\uFF1Ad0, d1", "\u9644\u52A0\u76EE\u9304\uFF1Ad0, d1"],
  ["sessionTime.started", { time: "11:30" }, "Started: 11:30", "\u5F00\u59CB\uFF1A11:30", "\u958B\u59CB\uFF1A11:30"],
  ["sessionTime.lastReply", { ago: "3m" }, "Last reply: 3m", "\u4E0A\u6B21\u56DE\u590D\uFF1A3m", "\u4E0A\u6B21\u56DE\u8986\uFF1A3m"],
  ["time.justNow", {}, "just now", "\u521A\u521A", "\u525B\u525B"],
  ["time.ago", { value: "3m" }, "3m ago", "3m\u524D", "3m\u524D"],
  ["promptCache.label", {}, "Cache", "\u7F13\u5B58", "\u5FEB\u53D6"],
  ["promptCache.expired", {}, "expired", "\u5DF2\u8FC7\u671F", "\u5DF2\u904E\u671F"],
  ["promptCache.until", { time: "11:30" }, "until 11:30", "\u81F3 11:30", "\u81F3 11:30"],
  ["tokens.summary", { total: "65", parts: "A, B" }, "Tokens 65 (A, B)", "\u8BCD\u5143 65\uFF08A, B\uFF09", "\u8A5E\u5143 65\uFF08A, B\uFF09"],
  ["tokens.input", { count: "3" }, "in: 3", "\u8F93\u5165 3", "\u8F38\u5165 3"],
  ["tokens.output", { count: "3" }, "out: 3", "\u8F93\u51FA 3", "\u8F38\u51FA 3"],
  ["tokens.cache", { count: "3" }, "cache: 3", "\u7F13\u5B58 3", "\u5FEB\u53D6 3"],
  ["list.separator", {}, ", ", "\uFF0C", "\uFF0C"],
  ["compactions.label", { count: "3" }, "Compactions: 3", "\u538B\u7F29\u6B21\u6570\uFF1A3", "\u58D3\u7E2E\u6B21\u6578\uFF1A3"],
  ["skills.label", { count: "3", names: "A, B" }, "Skills (3): A, B", "\u6280\u80FD\uFF083\uFF09\uFF1AA, B", "\u6280\u80FD\uFF083\uFF09\uFF1AA, B"],
  ["mcp.label", { count: "3", names: "A, B" }, "MCPs (3): A, B", "MCP\uFF083\uFF09\uFF1AA, B", "MCP\uFF083\uFF09\uFF1AA, B"],
  ["tools.target", { target: "a.ts" }, ": a.ts", "\uFF1Aa.ts", "\uFF1Aa.ts"],
  ["tools.count", { count: "3" }, " \u00D73", " 3 \u6B21", " 3 \u6B21"],
  ["agents.model", { model: "opus-4.8" }, " [opus-4.8]", " \u3010opus-4.8\u3011", " \u3010opus-4.8\u3011"],
  ["agents.description", { description: "Map" }, ": Map", "\uFF1AMap", "\uFF1AMap"],
  ["agents.elapsed", { time: "3m 21s" }, " (3m 21s)", "\uFF083m 21s\uFF09", "\uFF083m 21s\uFF09"],
  ["todos.progress", { done: "1", total: "3" }, " (1/3)", "\uFF081/3\uFF09", "\uFF081/3\uFF09"],
  ["todos.allComplete", {}, "All todos complete", "\u5168\u90E8\u5B8C\u6210", "\u5168\u90E8\u5B8C\u6210"],
  ["environment.claudeMd.one", { count: "3" }, "3 CLAUDE.md", "3 \u4E2A CLAUDE.md", "3 \u500B CLAUDE.md"],
  ["environment.claudeMd.other", { count: "3" }, "3 CLAUDE.md", "3 \u4E2A CLAUDE.md", "3 \u500B CLAUDE.md"],
  ["environment.rules.one", { count: "3" }, "3 rule", "3 \u6761\u89C4\u5219", "3 \u689D\u898F\u5247"],
  ["environment.rules.other", { count: "3" }, "3 rules", "3 \u6761\u89C4\u5219", "3 \u689D\u898F\u5247"],
  ["environment.mcp.one", { count: "3" }, "3 MCP", "3 \u4E2A MCP", "3 \u500B MCP"],
  ["environment.mcp.other", { count: "3" }, "3 MCPs", "3 \u4E2A MCP", "3 \u500B MCP"],
  ["environment.hooks.one", { count: "3" }, "3 hook", "3 \u4E2A\u94A9\u5B50", "3 \u500B\u9264\u5B50"],
  ["environment.hooks.other", { count: "3" }, "3 hooks", "3 \u4E2A\u94A9\u5B50", "3 \u500B\u9264\u5B50"],
];

describe("the wording of every message", () => {
  it("is pinned in each language, placeholders filled, word order and punctuation included", () => {
    for (const [id, values, english, simplified, traditional] of WORDING) {
      expect(fillPlaceholders(CATALOGUES.en[id], values), `en ${id}`).toBe(english);
      expect(fillPlaceholders(CATALOGUES["zh-Hans"][id], values), `zh-Hans ${id}`).toBe(simplified);
      expect(fillPlaceholders(CATALOGUES["zh-Hant"][id], values), `zh-Hant ${id}`).toBe(traditional);
    }
  });

  it("covers every message in the catalogue, once", () => {
    const pinned = WORDING.map(([id]) => id);
    expect([...pinned].sort()).toEqual(Object.keys(CATALOGUES.en).sort());
  });
});

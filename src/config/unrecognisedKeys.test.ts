import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { describeIgnoredKeys, noteIgnoredKeys, parseIgnoringUnrecognisedKeys, restoreIgnoredKeys } from "./unrecognisedKeys";

const Schema = z.strictObject({
  name: z.string(),
  nested: z.strictObject({ count: z.number() }).optional(),
  list: z.array(z.strictObject({ id: z.number() })).optional(),
});

describe("parseIgnoringUnrecognisedKeys", () => {
  it("passes a file with no unknown key through with nothing ignored", () => {
    const result = parseIgnoringUnrecognisedKeys(Schema, { name: "a" });
    expect(result).toEqual({ success: true, data: { name: "a" }, ignored: [] });
  });

  it("drops unknown keys at every depth and says where each sat", () => {
    const result = parseIgnoringUnrecognisedKeys(Schema, { name: "a", extra: 1, nested: { count: 2, more: 3 }, list: [{ id: 1, other: 4 }] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "a", nested: { count: 2 }, list: [{ id: 1 }] });
      expect(result.ignored).toEqual([
        { path: ["nested"], keys: ["more"], values: { more: 3 } },
        { path: ["list", 0], keys: ["other"], values: { other: 4 } },
        { path: [], keys: ["extra"], values: { extra: 1 } },
      ]);
    }
  });

  it("does not mutate the value it was given", () => {
    const raw = { name: "a", extra: 1 };
    parseIgnoringUnrecognisedKeys(Schema, raw);
    expect(raw).toEqual({ name: "a", extra: 1 });
  });

  it("still fails on a real violation, reporting only that violation", () => {
    const result = parseIgnoringUnrecognisedKeys(Schema, { name: 1, extra: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["invalid_type"]);
    }
  });

  it("still fails when removing the unknown keys exposes a violation", () => {
    const result = parseIgnoringUnrecognisedKeys(Schema, { extra: 1 });
    expect(result.success).toBe(false);
  });
});

describe("describeIgnoredKeys", () => {
  it("names the file, the places and the keys", () => {
    expect(describeIgnoredKeys("/p/a.json", [{ path: ["antigravity"], keys: ["degradeDownTiers"], values: {} }, { path: [], keys: ["x", "y"], values: {} }])).toBe(
      "/p/a.json has settings this version of agent-shim does not know and ignores: antigravity.degradeDownTiers; x, y. A newer release may read them.",
    );
  });
});

describe("noteIgnoredKeys", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one warning to standard error and repeats nothing for the same file and keys", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ignored = [{ path: [], keys: ["warn-once-test-key"], values: {} }];
    noteIgnoredKeys("/p/once.json", ignored);
    noteIgnoredKeys("/p/once.json", ignored);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toMatch(/^agent-shim: warning: \/p\/once\.json has settings/);
  });

  it("writes nothing when nothing was ignored", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    noteIgnoredKeys("/p/none.json", []);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("restoreIgnoredKeys", () => {
  afterEach(() => vi.restoreAllMocks());

  it("puts back what reading the file ignored, at the place it sat, and nothing else", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const parsed = parseIgnoringUnrecognisedKeys(Schema, { name: "a", extra: 1, nested: { count: 2, more: { deep: true } } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      noteIgnoredKeys("/p/restore.json", parsed.ignored);
      expect(restoreIgnoredKeys("/p/restore.json", { name: "b", nested: { count: 9 } })).toEqual({ name: "b", extra: 1, nested: { count: 9, more: { deep: true } } });
    }
  });

  it("leaves a value alone when its file ignored nothing, or the object that held the keys is gone", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(restoreIgnoredKeys("/p/never-read.json", { name: "a" })).toEqual({ name: "a" });
    noteIgnoredKeys("/p/gone.json", [{ path: ["nested"], keys: ["more"], values: { more: 1 } }]);
    expect(restoreIgnoredKeys("/p/gone.json", { name: "a" })).toEqual({ name: "a" });
    noteIgnoredKeys("/p/gone.json", []);
    expect(restoreIgnoredKeys("/p/gone.json", { name: "a", nested: { count: 1 } })).toEqual({ name: "a", nested: { count: 1 } });
  });
});

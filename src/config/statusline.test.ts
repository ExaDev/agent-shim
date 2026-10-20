import { describe, expect, it } from "vitest";
import { z } from "zod";

import { statuslineKeys } from "../statusline/keys";
import { contextBands, MAX_ACCOUNT_USER_CHARS, MAX_DISPLAY_TEXT_CHARS, MAX_STATUSLINE_COLUMNS, MAX_STATUSLINE_LABEL_COLUMNS, MAX_STATUSLINE_PALETTE_INDEX, mergeStatuslineSettings, resolveStatusline, STATUSLINE_DEFAULTS, StatuslineSchema } from "./statusline";

const A_CONFIGURED_WIDTH = 100;
const OVER_LONG_LABEL = "x".repeat(MAX_STATUSLINE_LABEL_COLUMNS + 1);
const WARN_ABOVE_DEFAULT_CRITICAL = 95;
const CRITICAL_ABOVE_WARN = 99;
const OWN_WINDOW = 100_000;
const OWN_PAIR = { warnAt: 40, criticalAt: 50 };

describe("StatuslineSchema", () => {
  it("accepts every group and none", () => {
    expect(StatuslineSchema.parse({})).toEqual({});
    const full = {
      layout: { header: ["account", "model"], rows: ["quota"] },
      bands: { warnAt: 50, criticalAt: 80 },
      labels: { fiveHour: "Session", sevenDay: "Week" },
      bar: { width: 6 },
    };
    expect(StatuslineSchema.parse(full)).toEqual(full);
  });

  it("accepts a group that names only some of its keys", () => {
    expect(StatuslineSchema.parse({ labels: { sevenDay: "Week" } })).toEqual({ labels: { sevenDay: "Week" } });
  });

  it("accepts an empty list, which hides the whole group", () => {
    expect(StatuslineSchema.parse({ layout: { header: [], rows: [] } })).toEqual({ layout: { header: [], rows: [] } });
  });

  it("refuses an unknown segment, a repeated segment, an unknown key and an unknown group", () => {
    expect(StatuslineSchema.safeParse({ layout: { header: ["colour"] } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ layout: { header: ["model", "model"] } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ layout: { rows: ["context", "context"] } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ layout: { theme: "dark" } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ theme: {} }).success).toBe(false);
  });

  it("refuses thresholds and a width outside their ranges", () => {
    for (const bad of [{ bands: { warnAt: 0 } }, { bands: { criticalAt: 101 } }, { bands: { warnAt: 50.5 } }, { bar: { width: 0 } }, { bar: { width: 41 } }, { bar: { width: 2.5 } }]) {
      expect(StatuslineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a label that is empty, too long, or carries control characters or edge whitespace", () => {
    for (const bad of ["", OVER_LONG_LABEL, "5\u001b[31mh", "line\nbreak", " 5h", "5h ", "a\tb"]) {
      expect(StatuslineSchema.safeParse({ labels: { fiveHour: bad } }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(StatuslineSchema.safeParse({ labels: { fiveHour: "5 hour" } }).success).toBe(true);
  });

  it("refuses a label that draws nothing, whatever its length", () => {
    for (const bad of ["\u0301", "\u0301\u0302", "\u2800", "\u3164", "\u034F", "\u115F\u1160"]) {
      const result = StatuslineSchema.safeParse({ labels: { fiveHour: bad } });
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
    expect(StatuslineSchema.safeParse({ labels: { fiveHour: "e\u0301" } }).success).toBe(true);
  });

  it("measures a label in terminal columns, so a wide character counts for two", () => {
    const widestWide = "\u65E5".repeat(MAX_STATUSLINE_LABEL_COLUMNS / 2);
    expect(StatuslineSchema.safeParse({ labels: { fiveHour: widestWide } }).success).toBe(true);
    expect(StatuslineSchema.safeParse({ labels: { fiveHour: `${widestWide}\u65E5` } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ labels: { fiveHour: "x".repeat(MAX_STATUSLINE_LABEL_COLUMNS) } }).success).toBe(true);
  });
});

describe("StatuslineSchema model and identity settings", () => {
  const accepts = (settings: unknown): boolean => StatuslineSchema.safeParse(settings).success;

  it("accepts each format and source, and refuses one that is not offered", () => {
    for (const format of ["full", "compact", "short"]) {
      expect(accepts({ model: { format } }), format).toBe(true);
    }
    for (const source of ["client", "transcript", "auto"]) {
      expect(accepts({ model: { source } }), source).toBe(true);
    }
    for (const format of ["symbol", "text"]) {
      expect(accepts({ effort: { format } }), format).toBe(true);
    }
    expect(accepts({ model: { format: "long" } })).toBe(false);
    expect(accepts({ model: { source: "stdin" } })).toBe(false);
    expect(accepts({ effort: { format: "short" } })).toBe(false);
  });

  it("accepts an override that is empty, or visible text up to the limit, and refuses control characters, edge whitespace and an over-long one", () => {
    for (const group of ["model", "provider", "advisor"] as const) {
      const key = group === "provider" ? "name" : "override";
      expect(accepts({ [group]: { [key]: "" } }), `${group} empty`).toBe(true);
      expect(accepts({ [group]: { [key]: "My model 2" } }), `${group} text`).toBe(true);
      expect(accepts({ [group]: { [key]: "x".repeat(MAX_DISPLAY_TEXT_CHARS) } }), `${group} at the limit`).toBe(true);
      expect(accepts({ [group]: { [key]: "x".repeat(MAX_DISPLAY_TEXT_CHARS + 1) } }), `${group} over the limit`).toBe(false);
      expect(accepts({ [group]: { [key]: "bad\u001B[31m" } }), `${group} escape`).toBe(false);
      expect(accepts({ [group]: { [key]: " padded" } }), `${group} edge whitespace`).toBe(false);
    }
  });

  it("accepts the account's parts in any order, none of them, and refuses a repeat or an unknown part", () => {
    expect(accepts({ account: { parts: ["plan", "user", "organisation"] } })).toBe(true);
    expect(accepts({ account: { parts: [] } })).toBe(true);
    expect(accepts({ account: { parts: ["user", "user"] } })).toBe(false);
    expect(accepts({ account: { parts: ["email"] } })).toBe(false);
  });

  it("accepts an account length from none to the longest email address, and refuses one outside that", () => {
    expect(accepts({ account: { userLength: 0 } })).toBe(true);
    expect(accepts({ account: { userLength: MAX_ACCOUNT_USER_CHARS } })).toBe(true);
    expect(accepts({ account: { userLength: MAX_ACCOUNT_USER_CHARS + 1 } })).toBe(false);
    expect(accepts({ account: { userLength: -1 } })).toBe(false);
    expect(accepts({ account: { userLength: 1.5 } })).toBe(false);
  });

  it("accepts the added header segments, which nothing draws until a layer lists them", () => {
    expect(accepts({ layout: { header: ["effort", "advisor", "version", "outputStyle"] } })).toBe(true);
    expect(STATUSLINE_DEFAULTS.layout.header).not.toContain("effort");
  });
});

describe("StatuslineSchema cost and environment", () => {
  it("accepts the cost segments and the machine rows in a layout, and the keys of their groups", () => {
    const settings = { layout: { header: ["cost", "dailyCost"], rows: ["memory", "environment"] }, cost: { routed: true }, environment: { threshold: 3 } };
    expect(StatuslineSchema.parse(settings)).toEqual(settings);
  });

  it("refuses a routed setting that is not a boolean, and a threshold that is negative or fractional", () => {
    for (const bad of [{ cost: { routed: "yes" } }, { environment: { threshold: -1 } }, { environment: { threshold: 1.5 } }, { environment: { count: 1 } }]) {
      expect(StatuslineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("leaves the segments and rows that were drawn before them as the default layout", () => {
    expect(STATUSLINE_DEFAULTS.layout).toMatchObject({ header: ["model", "provider", "route", "account", "identity", "headroom"], rows: ["context", "quota"] });
    expect(STATUSLINE_DEFAULTS.cost).toEqual({ routed: false });
    expect(STATUSLINE_DEFAULTS.environment).toEqual({ threshold: 0 });
  });
});

describe("StatuslineSchema colours and bar characters", () => {
  it("accepts a colour as a name, a palette index or a hex value", () => {
    for (const value of ["cyan", "default", 0, MAX_STATUSLINE_PALETTE_INDEX, "#00ff7f", "#00FF7F"]) {
      expect(StatuslineSchema.safeParse({ colours: { model: value } }).success, String(value)).toBe(true);
    }
  });

  it("refuses a colour outside those forms", () => {
    for (const value of ["purple", MAX_STATUSLINE_PALETTE_INDEX + 1, -1, MAX_STATUSLINE_PALETTE_INDEX / 2, "#fff", "#gg0000", "00ff7f"]) {
      expect(StatuslineSchema.safeParse({ colours: { model: value } }).success, String(value)).toBe(false);
    }
  });

  it("refuses a bar character that is wider or narrower than one terminal column", () => {
    for (const value of ["\u65E5", "\u{1F7E9}", "\u0301"]) {
      for (const key of ["filled", "empty"]) {
        const result = StatuslineSchema.safeParse({ bar: { [key]: value } });
        expect(result.success, `${key} ${JSON.stringify(value)}`).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain("one terminal column");
      }
    }
  });

  it("refuses a bar character that draws nothing", () => {
    for (const value of ["\u2800", "\uFFA0", "\u3164", "\u0301", "\u034F"]) {
      expect(StatuslineSchema.safeParse({ bar: { filled: value } }).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("accepts one visible character for a bar, and refuses none, several and invisible ones", () => {
    for (const value of ["#", "=", "\u2588", "\u25b0"]) {
      expect(StatuslineSchema.safeParse({ bar: { filled: value } }).success, value).toBe(true);
    }
    for (const value of ["", "ab", " ", "\n", "\u200b", "\u001b", "\u2028"]) {
      expect(StatuslineSchema.safeParse({ bar: { empty: value } }).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe("StatuslineSchema project and version control settings", () => {
  it("accepts each project, git and jj key with a value of its kind", () => {
    const settings = {
      project: { pathLevels: "full", addedDirsLayout: "row" },
      git: { enabled: false, showDirty: false, showAheadBehind: true, showLineDiff: true, branchOverflow: "wrap", pushWarnAt: 2, pushCriticalAt: 5 },
      jj: { enabled: true, showDirty: false, showConflicts: false },
      colours: { project: "cyan", git: 5, gitBranch: "#00ff7f" },
      layout: { header: ["project", "vcs"], rows: ["addedDirs", "gitFiles"] },
    };
    expect(StatuslineSchema.parse(settings)).toEqual(settings);
  });

  it("refuses a path depth, a layout and an overflow mode outside their choices", () => {
    for (const bad of [{ project: { pathLevels: "4" } }, { project: { pathLevels: 2 } }, { project: { addedDirsLayout: "line" } }, { git: { branchOverflow: "clip" } }]) {
      expect(StatuslineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a flag that is not a boolean and a push threshold that is negative or fractional", () => {
    for (const bad of [{ git: { enabled: "yes" } }, { jj: { showDirty: 1 } }, { git: { pushWarnAt: -1 } }, { git: { pushCriticalAt: 1.5 } }]) {
      expect(StatuslineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps the segments and rows drawn by default to the ones drawn before the project and version control elements existed", () => {
    expect(STATUSLINE_DEFAULTS.layout).toMatchObject({ header: ["model", "provider", "route", "account", "identity", "headroom"], rows: ["context", "quota"] });
  });

  it("defaults git on and jj off, as claude-hud does", () => {
    expect(STATUSLINE_DEFAULTS.git.enabled).toBe(true);
    expect(STATUSLINE_DEFAULTS.jj.enabled).toBe(false);
  });
});

describe("mergeStatuslineSettings", () => {
  it("merges groups key by key and lets a list replace the list beneath it", () => {
    const merged = mergeStatuslineSettings({ bands: { warnAt: 60, criticalAt: 85 }, layout: { header: ["model", "provider"] } }, { bands: { criticalAt: 95 }, layout: { header: ["identity"] } });
    expect(merged).toEqual({ bands: { warnAt: 60, criticalAt: 95 }, layout: { header: ["identity"] } });
  });

  it("changes neither argument", () => {
    const base = { bands: { warnAt: 60 } };
    mergeStatuslineSettings(base, { bands: { warnAt: 10 } });
    expect(base).toEqual({ bands: { warnAt: 60 } });
  });

  it("keeps the base when the layer above sets nothing", () => {
    expect(mergeStatuslineSettings({ bar: { width: 6 } }, undefined)).toEqual({ bar: { width: 6 } });
  });
});

describe("resolveStatusline", () => {
  it("fills every absent key from the defaults", () => {
    expect(resolveStatusline(undefined)).toEqual(STATUSLINE_DEFAULTS);
    expect(resolveStatusline({ bar: { width: 6 } })).toEqual({ ...STATUSLINE_DEFAULTS, bar: { ...STATUSLINE_DEFAULTS.bar, width: 6 } });
  });

  it("refuses a warning threshold at or above the critical one, whichever side the setting came from", () => {
    expect(() => resolveStatusline({ bands: { warnAt: WARN_ABOVE_DEFAULT_CRITICAL } })).toThrow(/bands\.warnAt \(95\) must be below bands\.criticalAt \(90\)/);
    expect(() => resolveStatusline({ bands: { criticalAt: 60 } })).toThrow(/bands\.warnAt \(70\) must be below bands\.criticalAt \(60\)/);
    expect(() => resolveStatusline({ bands: { warnAt: 80, criticalAt: 80 } })).toThrow(RangeError);
    expect(resolveStatusline({ bands: { warnAt: WARN_ABOVE_DEFAULT_CRITICAL, criticalAt: CRITICAL_ABOVE_WARN } }).bands.warnAt).toBe(WARN_ABOVE_DEFAULT_CRITICAL);
  });
});

describe("the width settings", () => {
  const accepts = (layout: unknown): boolean => StatuslineSchema.safeParse({ layout }).success;

  it("accept a width from none to the widest a terminal is taken to be, and refuse any other", () => {
    expect(accepts({ maxWidth: 0 })).toBe(true);
    expect(accepts({ maxWidth: MAX_STATUSLINE_COLUMNS })).toBe(true);
    expect(accepts({ maxWidth: MAX_STATUSLINE_COLUMNS + 1 })).toBe(false);
    expect(accepts({ maxWidth: -1 })).toBe(false);
    expect(accepts({ maxWidth: 80.5 })).toBe(false);
    expect(accepts({ forceMaxWidth: "yes" })).toBe(false);
  });

  it("refuse a forced width when no width is set, whichever layer set which", () => {
    expect(() => resolveStatusline({ layout: { forceMaxWidth: true } })).toThrow(/layout\.forceMaxWidth needs layout\.maxWidth/);
    expect(resolveStatusline({ layout: { forceMaxWidth: true, maxWidth: A_CONFIGURED_WIDTH } }).layout.maxWidth).toBe(A_CONFIGURED_WIDTH);
    expect(resolveStatusline({ layout: { maxWidth: A_CONFIGURED_WIDTH } }).layout.forceMaxWidth).toBe(false);
  });
});

describe("the layout mode and rule settings", () => {
  const accepts = (layout: unknown): boolean => StatuslineSchema.safeParse({ layout }).success;

  it("accept each documented choice and refuse any other", () => {
    for (const mode of ["expanded", "compact"]) {
      expect(accepts({ mode }), mode).toBe(true);
    }
    for (const rule of ["none", "belowHeader"]) {
      expect(accepts({ rule }), rule).toBe(true);
    }
    expect(accepts({ mode: "wide" })).toBe(false);
    expect(accepts({ rule: "aboveActivity" })).toBe(false);
    expect(accepts({ rule: true })).toBe(false);
  });

  it("default to the expanded layout with no rule", () => {
    expect(STATUSLINE_DEFAULTS.layout).toMatchObject({ mode: "expanded", rule: "none" });
  });
});

describe("the merge and right-align settings", () => {
  const accepts = (layout: unknown): boolean => StatuslineSchema.safeParse({ layout }).success;

  it("accept groups of two or more distinct rows, none at all, and refuse a group of one, a repeated row or an unknown row", () => {
    expect(accepts({ merge: [["context", "quota"], ["memory", "environment", "promptCache"]] })).toBe(true);
    expect(accepts({ merge: [] })).toBe(true);
    expect(accepts({ merge: [["context"]] })).toBe(false);
    expect(accepts({ merge: [[]] })).toBe(false);
    expect(accepts({ merge: [["context", "context"]] })).toBe(false);
    expect(accepts({ merge: [["context", "project"]] })).toBe(false);
  });

  it("refuse a row in two groups, since it cannot join two lines", () => {
    expect(accepts({ merge: [["context", "quota"], ["quota", "memory"]] })).toBe(false);
  });

  it("share bar rows by default, with no groups and nothing right-aligned", () => {
    expect(STATUSLINE_DEFAULTS.layout.mergeBars).toBe(true);
    expect(STATUSLINE_DEFAULTS.layout.merge).toEqual([]);
    expect(STATUSLINE_DEFAULTS.layout.rightAlign).toEqual([]);
    expect(accepts({ mergeBars: false })).toBe(true);
    expect(accepts({ mergeBars: "no" })).toBe(false);
  });

  it("refuse a right-aligned row that no merge group contains, whichever layer set which", () => {
    expect(() => resolveStatusline({ layout: { rightAlign: ["memory"] } })).toThrow(/layout\.rightAlign names memory, which no group in layout\.merge contains/);
    expect(() => resolveStatusline({ layout: { merge: [], rightAlign: ["quota"] } })).toThrow(RangeError);
    expect(resolveStatusline({ layout: { merge: [["context", "quota"]], rightAlign: ["quota"] } }).layout.rightAlign).toEqual(["quota"]);
    expect(resolveStatusline({ layout: { merge: [["memory", "environment"]], rightAlign: ["environment"] } }).layout.merge).toEqual([["memory", "environment"]]);
  });
});

describe("the usage and clock settings", () => {
  it("accept every documented choice and refuse any other", () => {
    for (const timeFormat of ["relative", "absolute", "both", "elapsed", "elapsedAndAbsolute"]) {
      expect(StatuslineSchema.safeParse({ usage: { timeFormat } }).success, timeFormat).toBe(true);
    }
    for (const hourCycle of ["auto", "h11", "h12", "h23", "h24"]) {
      expect(StatuslineSchema.safeParse({ clock: { hourCycle } }).success, hourCycle).toBe(true);
    }
    expect(StatuslineSchema.safeParse({ usage: { timeFormat: "elapsedAndRelative" } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ usage: { value: "percent" } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ clock: { hourCycle: "h13" } }).success).toBe(false);
  });

  it("take thresholds from nothing to a whole hundred percent, and booleans only as booleans", () => {
    expect(StatuslineSchema.safeParse({ usage: { threshold: 0, sevenDayThreshold: 100 } }).success).toBe(true);
    expect(StatuslineSchema.safeParse({ usage: { threshold: -1 } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ usage: { sevenDayThreshold: 101 } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ usage: { sevenDayThreshold: 80.5 } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ usage: { bar: "false" } }).success).toBe(false);
    expect(StatuslineSchema.safeParse({ clock: { seconds: 1 } }).success).toBe(false);
  });

  it("merge key by key with the other groups", () => {
    expect(mergeStatuslineSettings({ usage: { compact: true, threshold: 50 } }, { usage: { threshold: 10 } })).toEqual({ usage: { compact: true, threshold: 10 } });
  });
});

describe("the context group", () => {
  it("accepts each key with its values and refuses a value outside them", () => {
    const good = { context: { bar: "hidden", value: "remaining", warnAt: 60, criticalAt: 85, autoCompactWindow: 160_000, estimate: "buffered", breakdown: "critical" } };
    expect(StatuslineSchema.parse(good)).toEqual(good);
    const bad = [{ bar: "off" }, { value: "ratio" }, { warnAt: 0 }, { warnAt: -1 }, { criticalAt: 101 }, { warnAt: 50.5 }, { autoCompactWindow: 0 }, { autoCompactWindow: -1 }, { autoCompactWindow: 1.5 }, { estimate: "always" }, { breakdown: "always" }];
    for (const context of bad) {
      expect(StatuslineSchema.safeParse({ context }).success, JSON.stringify(context)).toBe(false);
    }
  });

  it("follows the bands for a threshold left unset, and uses its own where one is set", () => {
    expect(contextBands(resolveStatusline({ bands: { warnAt: 60, criticalAt: 80 } }))).toEqual({ warnAt: 60, criticalAt: 80 });
    expect(contextBands(resolveStatusline({ context: { warnAt: 50 } }))).toEqual({ warnAt: 50, criticalAt: STATUSLINE_DEFAULTS.bands.criticalAt });
    expect(contextBands(resolveStatusline({ bands: { warnAt: 60, criticalAt: 80 }, context: { warnAt: 70, criticalAt: 85 } }))).toEqual({ warnAt: 70, criticalAt: 85 });
  });

  it("refuses a context warning threshold at or above the critical one, whichever of the two comes from the bands", () => {
    expect(() => resolveStatusline({ context: { warnAt: 95 } })).toThrow(/context\.warnAt \(95\) must be below context\.criticalAt \(90\)/);
    expect(() => resolveStatusline({ context: { criticalAt: 60 } })).toThrow(/context\.warnAt \(70\) must be below context\.criticalAt \(60\)/);
    expect(resolveStatusline({ context: OWN_PAIR }).context.criticalAt).toBe(OWN_PAIR.criticalAt);
  });

  it("has no default for the keys that stay unset", () => {
    expect(STATUSLINE_DEFAULTS.context.warnAt).toBeUndefined();
    expect(STATUSLINE_DEFAULTS.context.criticalAt).toBeUndefined();
    expect(STATUSLINE_DEFAULTS.context.autoCompactWindow).toBeUndefined();
    expect(resolveStatusline({ context: { autoCompactWindow: OWN_WINDOW } }).context.autoCompactWindow).toBe(OWN_WINDOW);
  });

  it("leaves the token totals out of the rows drawn by default", () => {
    expect(STATUSLINE_DEFAULTS.layout.rows).toEqual(["context", "quota"]);
    expect(StatuslineSchema.parse({ layout: { rows: ["context", "tokens"] } })).toEqual({ layout: { rows: ["context", "tokens"] } });
  });
});

describe("unsetting an optional setting from a layer", () => {
  const OPTIONAL = [
    ["context", "warnAt", OWN_PAIR.warnAt],
    ["context", "criticalAt", OWN_PAIR.criticalAt],
    ["context", "autoCompactWindow", OWN_WINDOW],
  ] as const;

  it("accepts null for exactly the optional settings in a layer", () => {
    for (const [group, name, value] of OPTIONAL) {
      expect(StatuslineSchema.safeParse({ [group]: { [name]: null } }).success, `${name} null`).toBe(true);
      expect(StatuslineSchema.safeParse({ [group]: { [name]: value } }).success, `${name} value`).toBe(true);
    }
    for (const bad of [{ bands: { warnAt: null } }, { context: { value: null } }, { layout: { header: null } }, { colours: { model: null } }]) {
      expect(StatuslineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("lists exactly those settings as optional, with no default", () => {
    const keys = statuslineKeys().filter((key) => key.optional);
    expect(keys.map((key) => key.path)).toEqual(OPTIONAL.map(([group, name]) => `${group}.${name}`));
    expect(JSON.stringify(z.toJSONSchema(StatuslineSchema))).toContain("A layer may write null to return it to unset");
  });

  it("removes the key when merged over a layer that set it, or over nothing, and leaves no null behind", () => {
    expect(mergeStatuslineSettings({ context: { warnAt: OWN_PAIR.warnAt, bar: "hidden" } }, { context: { warnAt: null } })).toEqual({ context: { bar: "hidden" } });
    expect(mergeStatuslineSettings(undefined, { context: { warnAt: null, value: "percent" } })).toEqual({ context: { value: "percent" } });
    expect(mergeStatuslineSettings({ bar: { width: 6 } }, { context: { warnAt: null } })).toEqual({ bar: { width: 6 }, context: {} });
  });

  it("resolves a null to the setting unset, following the bands again", () => {
    const resolved = resolveStatusline({ bands: { warnAt: 55, criticalAt: 80 }, context: { warnAt: null, autoCompactWindow: null } });
    expect(resolved.context).not.toHaveProperty("warnAt");
    expect(resolved.context).not.toHaveProperty("autoCompactWindow");
    expect(contextBands(resolved)).toEqual({ warnAt: 55, criticalAt: 80 });
  });
});

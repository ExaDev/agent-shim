import { describe, expect, it } from "vitest";

import { MAX_ACCOUNT_USER_CHARS, MAX_DISPLAY_TEXT_CHARS, MAX_STATUSLINE_LABEL_CHARS, MAX_STATUSLINE_PALETTE_INDEX, mergeStatuslineSettings, resolveStatusline, STATUSLINE_DEFAULTS, StatuslineSchema } from "./statusline";

const OVER_LONG_LABEL = "x".repeat(MAX_STATUSLINE_LABEL_CHARS + 1);
const WARN_ABOVE_DEFAULT_CRITICAL = 95;
const CRITICAL_ABOVE_WARN = 99;

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

  it("accepts one visible character for a bar, and refuses none, several and invisible ones", () => {
    for (const value of ["#", "=", "█", "▰"]) {
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
    expect(STATUSLINE_DEFAULTS.layout).toEqual({ header: ["model", "provider", "route", "account", "identity", "headroom"], rows: ["context", "quota"] });
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

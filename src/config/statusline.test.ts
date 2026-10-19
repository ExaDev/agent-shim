import { describe, expect, it } from "vitest";

import { MAX_STATUSLINE_LABEL_CHARS, MAX_STATUSLINE_PALETTE_INDEX, mergeStatuslineSettings, resolveStatusline, STATUSLINE_DEFAULTS, StatuslineSchema } from "./statusline";

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

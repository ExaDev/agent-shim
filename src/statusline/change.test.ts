import { describe, expect, it } from "vitest";

import { UsageError } from "../cliError";
import { applyStatuslineChange, parseStatuslineAssignment } from "./change";

describe("parseStatuslineAssignment", () => {
  it("writes each value the way its setting's kind is written", () => {
    expect(parseStatuslineAssignment("bar.width=6")).toEqual({ path: "bar.width", value: 6 });
    expect(parseStatuslineAssignment("labels.fiveHour=Session")).toEqual({ path: "labels.fiveHour", value: "Session" });
    expect(parseStatuslineAssignment("layout.header=model,account")).toEqual({ path: "layout.header", value: ["model", "account"] });
    expect(parseStatuslineAssignment("layout.rows=")).toEqual({ path: "layout.rows", value: [] });
    expect(parseStatuslineAssignment("git.showDirty=false")).toEqual({ path: "git.showDirty", value: false });
    expect(parseStatuslineAssignment("jj.enabled=true")).toEqual({ path: "jj.enabled", value: true });
    expect(parseStatuslineAssignment("language=zh-Hans")).toEqual({ path: "language", value: "zh-Hans" });
    expect(parseStatuslineAssignment("project.pathLevels=2")).toEqual({ path: "project.pathLevels", value: "2" });
    expect(parseStatuslineAssignment("usage.bar=false")).toEqual({ path: "usage.bar", value: false });
    expect(parseStatuslineAssignment("usage.compact=true")).toEqual({ path: "usage.compact", value: true });
    expect(parseStatuslineAssignment("usage.timeFormat=elapsedAndAbsolute")).toEqual({ path: "usage.timeFormat", value: "elapsedAndAbsolute" });
    expect(parseStatuslineAssignment("layout.maxWidth=120")).toEqual({ path: "layout.maxWidth", value: 120 });
    expect(parseStatuslineAssignment("layout.forceMaxWidth=true")).toEqual({ path: "layout.forceMaxWidth", value: true });
  });

  it("writes groups of choices with commas inside a group and semicolons between groups", () => {
    expect(parseStatuslineAssignment("layout.merge=context,quota;memory,environment")).toEqual({ path: "layout.merge", value: [["context", "quota"], ["memory", "environment"]] });
    expect(parseStatuslineAssignment("layout.merge=context,quota")).toEqual({ path: "layout.merge", value: [["context", "quota"]] });
    expect(parseStatuslineAssignment("layout.merge=")).toEqual({ path: "layout.merge", value: [] });
  });

  it("keeps a value that itself contains an equals sign", () => {
    expect(parseStatuslineAssignment("labels.fiveHour=a=b")).toEqual({ path: "labels.fiveHour", value: "a=b" });
  });

  it("refuses text with no value, an unknown setting and a non-number for a number", () => {
    expect(() => parseStatuslineAssignment("bar.width")).toThrow(UsageError);
    expect(() => parseStatuslineAssignment("bar.colour=1")).toThrow(/is not a statusline setting/);
    expect(() => parseStatuslineAssignment("bar.width=wide")).toThrow(/is not a number/);
    expect(() => parseStatuslineAssignment("bar.width=")).toThrow(/is not a number/);
    expect(() => parseStatuslineAssignment("git.enabled=yes")).toThrow(/is not true or false/);
    expect(() => parseStatuslineAssignment("git.enabled=")).toThrow(/is not true or false/);
    expect(() => parseStatuslineAssignment("usage.bar=yes")).toThrow(/is not true or false/);
    expect(() => parseStatuslineAssignment("usage.bar=")).toThrow(/is not true or false/);
  });
});

describe("applyStatuslineChange", () => {
  it("sets and removes settings key by key, leaving the others alone", () => {
    const first = applyStatuslineChange(undefined, { set: { "bar.width": 6, "bands.warnAt": 50 } });
    expect(first).toEqual({ bar: { width: 6 }, bands: { warnAt: 50 } });
    expect(applyStatuslineChange(first, { set: { "labels.sevenDay": "Week" }, unset: ["bar.width"] })).toEqual({ bands: { warnAt: 50 }, labels: { sevenDay: "Week" } });
  });

  it("applies groups of rows, and refuses a group of one or a row in two groups", () => {
    expect(applyStatuslineChange(undefined, { set: { "layout.merge": [["context", "quota"]] } })).toEqual({ layout: { merge: [["context", "quota"]] } });
    expect(() => applyStatuslineChange(undefined, { set: { "layout.merge": [["context"]] } })).toThrow(/layout\.merge/);
    expect(() => applyStatuslineChange(undefined, { set: { "layout.merge": [["context", "quota"], ["quota", "memory"]] } })).toThrow(/more than one group/);
  });

  it("changes nothing it was given", () => {
    const existing = { bar: { width: 6 } };
    applyStatuslineChange(existing, { set: { "bar.width": 8 } });
    expect(existing).toEqual({ bar: { width: 6 } });
  });

  it("returns undefined once no setting is left, and prunes a group it emptied", () => {
    expect(applyStatuslineChange({ bar: { width: 6 }, bands: { warnAt: 50 } }, { unset: ["bar.width"] })).toEqual({ bands: { warnAt: 50 } });
    expect(applyStatuslineChange({ bar: { width: 6 } }, { unset: ["bar.width"] })).toBeUndefined();
  });

  it("sets an optional setting from text and unsets it again, so it follows what it falls back on", () => {
    const { path, value } = parseStatuslineAssignment("context.warnAt=60");
    expect(applyStatuslineChange(undefined, { set: { [path]: value } })).toEqual({ context: { warnAt: 60 } });
    expect(applyStatuslineChange({ context: { warnAt: 60 } }, { unset: ["context.warnAt"] })).toBeUndefined();
    expect(() => applyStatuslineChange(undefined, { set: { "context.warnAt": 0 } })).toThrow(/statusline: context\.warnAt:/);
  });

  it("writes none for an optional setting as null, which unsets it for the layers it is merged over, and takes none as an ordinary value for any other", () => {
    expect(parseStatuslineAssignment("context.warnAt=none")).toEqual({ path: "context.warnAt", value: null });
    expect(applyStatuslineChange(undefined, { set: { "context.warnAt": null } })).toEqual({ context: { warnAt: null } });
    expect(() => parseStatuslineAssignment("bar.width=none")).toThrow(/not a number/);
  });

  it("removing a setting that is not set is not an error", () => {
    expect(applyStatuslineChange({ bar: { width: 6 } }, { unset: ["bands.warnAt"] })).toEqual({ bar: { width: 6 } });
  });

  it("refuses a setting that does not exist and a value the schema refuses, naming the setting", () => {
    expect(() => applyStatuslineChange(undefined, { set: { "bar.colour": 1 } })).toThrow(/is not a statusline setting/);
    expect(() => applyStatuslineChange(undefined, { unset: ["bar.colour"] })).toThrow(/is not a statusline setting/);
    expect(() => applyStatuslineChange(undefined, { set: { "bar.width": 0 } })).toThrow(/statusline: bar\.width:/);
  });
});

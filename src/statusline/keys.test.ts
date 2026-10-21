import { describe, expect, it } from "vitest";

import { StatuslineSchema } from "../config/statusline";
import { formatStatuslineKeys, statuslineKeys } from "./keys";

describe("statuslineKeys", () => {
  it("describes every setting, with a default that the schema accepts", () => {
    for (const key of statuslineKeys()) {
      expect(key.description, `${key.path} has a description`).not.toBe("");
      if (key.optional) {
        expect(key.defaultValue, `${key.path} is optional, so it has no default`).toBeUndefined();
        continue;
      }
      expect(key.defaultValue, `${key.path} has a default`).not.toBeUndefined();
      const [group, name] = key.path.split(".");
      // A setting outside any group is its own path; the others sit one level down.
      const layer = name === undefined ? { [group ?? ""]: key.defaultValue } : { [group ?? ""]: { [name]: key.defaultValue } };
      expect(StatuslineSchema.safeParse(layer).success, `${key.path} default is valid`).toBe(true);
    }
  });

  it("lists each setting once, by dotted path, in declaration order", () => {
    const paths = statuslineKeys().map((key) => key.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.slice(0, 2)).toEqual(["language", "preset"]);
    expect(paths[2]).toBe("layout.header");
  });

  it("describes groups of rows as such, with the rows they may name and no group by default", () => {
    const merge = statuslineKeys().find((key) => key.path === "layout.merge");
    expect(merge).toMatchObject({ kind: "groups", defaultValue: [] });
    expect(merge?.choices).toContain("quota");
    expect(formatStatuslineKeys(statuslineKeys())).toContain("layout.merge  (groups of ");
  });

  it("names the kind and the choices of a setting", () => {
    const header = statuslineKeys().find((key) => key.path === "layout.header");
    expect(header).toMatchObject({ kind: "list" });
    expect(header?.choices).toContain("account");
    expect(statuslineKeys().find((key) => key.path === "bar.width")).toMatchObject({ kind: "integer", choices: [], defaultValue: 10 });
    expect(statuslineKeys().find((key) => key.path === "labels.fiveHour")).toMatchObject({ kind: "text", defaultValue: "" });
    expect(statuslineKeys().find((key) => key.path === "language")).toMatchObject({ kind: "choice", choices: ["en", "zh-Hans", "zh-Hant"], defaultValue: "en" });
    expect(statuslineKeys().find((key) => key.path === "preset")).toMatchObject({ kind: "choice", choices: ["standard", "full", "essential", "minimal"], defaultValue: "standard" });
    expect(statuslineKeys().find((key) => key.path === "tools.maxVisible")).toMatchObject({ kind: "integer", choices: [], defaultValue: 4 });
    expect(statuslineKeys().find((key) => key.path === "colours.agent")).toMatchObject({ kind: "colour", defaultValue: "magenta" });
    expect(statuslineKeys().find((key) => key.path === "git.showDirty")).toMatchObject({ kind: "boolean", choices: [], defaultValue: true });
    expect(statuslineKeys().find((key) => key.path === "project.pathLevels")).toMatchObject({ kind: "choice", choices: ["1", "2", "3", "full"], defaultValue: "1" });
    expect(statuslineKeys().find((key) => key.path === "usage.bar")).toMatchObject({ kind: "boolean", choices: [], defaultValue: true });
    expect(statuslineKeys().find((key) => key.path === "usage.timeFormat")).toMatchObject({ kind: "choice", choices: ["relative", "absolute", "both", "elapsed", "elapsedAndAbsolute"], defaultValue: "relative" });
    expect(statuslineKeys().find((key) => key.path === "clock.hourCycle")).toMatchObject({ kind: "choice", choices: ["auto", "h11", "h12", "h23", "h24"], defaultValue: "auto" });
    expect(statuslineKeys().find((key) => key.path === "extra.command")).toMatchObject({ kind: "textList", choices: [], defaultValue: [] });
    expect(statuslineKeys().find((key) => key.path === "customLine.position")).toMatchObject({ kind: "choice", choices: ["first", "last"], defaultValue: "last" });
    expect(statuslineKeys().find((key) => key.path === "cost.routed")).toMatchObject({ kind: "boolean", choices: [], defaultValue: false });
    expect(statuslineKeys().find((key) => key.path === "environment.threshold")).toMatchObject({ kind: "integer", defaultValue: 0 });
  });

  it("lists the session elements as names a layout can use, none of them drawn by default", () => {
    const header = statuslineKeys().find((key) => key.path === "layout.header");
    const rows = statuslineKeys().find((key) => key.path === "layout.rows");
    expect(header?.choices).toEqual(expect.arrayContaining(["sessionName", "duration", "speed"]));
    expect(rows?.choices).toEqual(expect.arrayContaining(["sessionTime", "promptCache", "compactions"]));
    expect(header?.defaultValue).toEqual(["model", "project", "vcs", "provider", "route", "account", "identity", "headroom", "extra"]);
    expect(rows?.defaultValue).toEqual(["context", "quota", "addedDirs"]);
  });

  it("describes the session settings", () => {
    expect(statuslineKeys().find((key) => key.path === "sessionTime.parts")).toMatchObject({ kind: "list", choices: ["started", "lastReply"], defaultValue: ["started", "lastReply"] });
    expect(statuslineKeys().find((key) => key.path === "promptCache.ttlSeconds")).toMatchObject({ kind: "integer", choices: [], defaultValue: 300 });
  });
});

describe("an optional setting", () => {
  it("is listed with its kind, no default and its own description", () => {
    const warnAt = statuslineKeys().find((key) => key.path === "context.warnAt");
    expect(warnAt).toMatchObject({ kind: "integer", optional: true, defaultValue: undefined });
    expect(warnAt?.description).toContain("bands.warnAt");
    expect(statuslineKeys().find((key) => key.path === "bands.warnAt")).toMatchObject({ optional: false });
    expect(formatStatuslineKeys(statuslineKeys())).toContain("context.warnAt  (integer; no default; none unsets it over shallower layers)");
  });
});

describe("formatStatuslineKeys", () => {
  it("prints each setting's path, kind and default, with its description beneath", () => {
    const text = formatStatuslineKeys(statuslineKeys());
    expect(text).toContain("bar.width  (integer; default 10)\n    A bar's width in cells");
    expect(text).toContain("usage.compact  (boolean; default false)\n");
  });
});

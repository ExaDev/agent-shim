import { describe, expect, it } from "vitest";

import { StatuslineSchema } from "../config/statusline";
import { formatStatuslineKeys, statuslineKeys } from "./keys";

describe("statuslineKeys", () => {
  it("describes every setting, with a default that the schema accepts", () => {
    for (const key of statuslineKeys()) {
      expect(key.description, `${key.path} has a description`).not.toBe("");
      expect(key.defaultValue, `${key.path} has a default`).not.toBeUndefined();
      const [group, name] = key.path.split(".");
      expect(StatuslineSchema.safeParse({ [group ?? ""]: { [name ?? ""]: key.defaultValue } }).success, `${key.path} default is valid`).toBe(true);
    }
  });

  it("lists each setting once, by dotted path, in declaration order", () => {
    const paths = statuslineKeys().map((key) => key.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe("layout.header");
  });

  it("names the kind and the choices of a setting", () => {
    const header = statuslineKeys().find((key) => key.path === "layout.header");
    expect(header).toMatchObject({ kind: "list" });
    expect(header?.choices).toContain("account");
    expect(statuslineKeys().find((key) => key.path === "bar.width")).toMatchObject({ kind: "integer", choices: [], defaultValue: 10 });
    expect(statuslineKeys().find((key) => key.path === "labels.fiveHour")).toMatchObject({ kind: "text", defaultValue: "5h" });
    expect(statuslineKeys().find((key) => key.path === "git.showDirty")).toMatchObject({ kind: "boolean", choices: [], defaultValue: true });
    expect(statuslineKeys().find((key) => key.path === "project.pathLevels")).toMatchObject({ kind: "choice", choices: ["1", "2", "3", "full"], defaultValue: "1" });
  });
});

describe("formatStatuslineKeys", () => {
  it("prints each setting's path, kind and default, with its description beneath", () => {
    const text = formatStatuslineKeys(statuslineKeys());
    expect(text).toContain("bar.width  (integer; default 10)\n    A bar's width in cells");
  });
});

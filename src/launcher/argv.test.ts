import { describe, expect, it } from "vitest";

import { parseLauncherArgv } from "./argv";

describe("parseLauncherArgv", () => {
  it("consumes a leading @name and strips it from rest", () => {
    const result = parseLauncherArgv(["@work", "--print", "hello"]);
    expect(result.identity).toBe("work");
    expect(result.rest).toEqual(["--print", "hello"]);
  });

  it("never treats an @-prefixed token as an identity anywhere other than index 0", () => {
    const result = parseLauncherArgv(["--print", "@notidentity", "hello"]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual(["--print", "@notidentity", "hello"]);
  });

  it("returns no identity and the argv unchanged when nothing is present", () => {
    const result = parseLauncherArgv([]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual([]);
  });

  it("does not treat a bare @ with nothing after it as an identity token", () => {
    const result = parseLauncherArgv(["@", "--print"]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual(["@", "--print"]);
  });

  it("passes through a normal first positional untouched", () => {
    const result = parseLauncherArgv(["/loop continue"]);
    expect(result.identity).toBeUndefined();
    expect(result.rest).toEqual(["/loop continue"]);
  });

  it("strips only the single leading @name token, not any later one even if also @-prefixed", () => {
    const result = parseLauncherArgv(["@personal", "@work", "--print"]);
    expect(result.identity).toBe("personal");
    expect(result.rest).toEqual(["@work", "--print"]);
  });

  it("returns empty flag arrays and no config profile when none are given", () => {
    const result = parseLauncherArgv(["--print", "hello"]);
    expect(result.configProfile).toBeUndefined();
    expect(result.categoryFlags).toEqual([]);
    expect(result.shareFlags).toEqual([]);
    expect(result.hideFlags).toEqual([]);
    expect(result.rest).toEqual(["--print", "hello"]);
  });

  it("consumes --config-profile <name> and strips it from rest", () => {
    const result = parseLauncherArgv(["--config-profile", "work", "--print"]);
    expect(result.configProfile).toBe("work");
    expect(result.rest).toEqual(["--print"]);
  });

  it("consumes --provider <name> in both spaced and inline forms, before passthrough args", () => {
    const spaced = parseLauncherArgv(["--provider", "z", "--print"]);
    expect(spaced.provider).toBe("z");
    expect(spaced.rest).toEqual(["--print"]);
    const inline = parseLauncherArgv(["--provider=o", "--print"]);
    expect(inline.provider).toBe("o");
    expect(inline.rest).toEqual(["--print"]);
  });

  it("keeps the last --provider value when the flag repeats", () => {
    const result = parseLauncherArgv(["--provider", "z", "--provider", "m"]);
    expect(result.provider).toBe("m");
    expect(result.rest).toEqual([]);
  });

  it("accepts --config-profile=<name> inline form", () => {
    const result = parseLauncherArgv(["--config-profile=work", "--print"]);
    expect(result.configProfile).toBe("work");
    expect(result.rest).toEqual(["--print"]);
  });

  it("accumulates repeated --category flags in order", () => {
    const result = parseLauncherArgv(["--category", "history=true", "--print", "--category", "knowledge=false"]);
    expect(result.categoryFlags).toEqual(["history=true", "knowledge=false"]);
    expect(result.rest).toEqual(["--print"]);
  });

  it("accumulates repeated --share and --hide flags, each keeping comma-separated values as one raw entry", () => {
    const result = parseLauncherArgv(["--share", "knowledge/skills/a,knowledge/skills/b", "--hide", "history/projects/x"]);
    expect(result.shareFlags).toEqual(["knowledge/skills/a,knowledge/skills/b"]);
    expect(result.hideFlags).toEqual(["history/projects/x"]);
    expect(result.rest).toEqual([]);
  });

  it("leaves a valued flag untouched when it is the very last token with no value to pair", () => {
    const result = parseLauncherArgv(["--print", "--category"]);
    expect(result.categoryFlags).toEqual([]);
    expect(result.rest).toEqual(["--print", "--category"]);
  });

  it("consumes claude-use flags positioned after a leading @name", () => {
    const result = parseLauncherArgv(["@work", "--category", "history=true", "--print"]);
    expect(result.identity).toBe("work");
    expect(result.categoryFlags).toEqual(["history=true"]);
    expect(result.rest).toEqual(["--print"]);
  });
});

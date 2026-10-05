import { describe, expect, it } from "vitest";

import { ConflictingIdentityError, parseLauncherArgv } from "./argv";

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

  it("parses --headroom and --no-headroom as consumed boolean flags, later occurrence winning", () => {
    expect(parseLauncherArgv(["--headroom", "-p"]).headroom).toBe(true);
    expect(parseLauncherArgv(["--no-headroom", "-p"]).headroom).toBe(false);
    expect(parseLauncherArgv(["--no-headroom", "--headroom", "-p"]).headroom).toBe(true);
    expect(parseLauncherArgv(["--headroom", "--no-headroom", "-p"]).headroom).toBe(false);
    const parsed = parseLauncherArgv(["--headroom", "fix", "the", "bug"]);
    expect(parsed.headroom).toBe(true);
    expect(parsed.rest).toEqual(["fix", "the", "bug"]);
  });

  it("parses --track-usage and --no-track-usage as consumed boolean flags, later occurrence winning", () => {
    expect(parseLauncherArgv(["--track-usage", "-p"]).trackUsage).toBe(true);
    expect(parseLauncherArgv(["--no-track-usage", "-p"]).trackUsage).toBe(false);
    expect(parseLauncherArgv(["--no-track-usage", "--track-usage"]).trackUsage).toBe(true);
    expect(parseLauncherArgv(["--track-usage", "--no-track-usage"]).trackUsage).toBe(false);
    expect(parseLauncherArgv(["--track-usage", "fix", "it"]).rest).toEqual(["fix", "it"]);
    expect(parseLauncherArgv(["-p", "hi"]).trackUsage).toBeUndefined();
  });

  it("leaves headroom undefined when neither flag is given", () => {
    expect(parseLauncherArgv(["-p", "hi"]).headroom).toBeUndefined();
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

  it("accumulates repeated --share and --hide flags, one raw value per occurrence", () => {
    const result = parseLauncherArgv(["--share", "knowledge/skills/a", "--share", "knowledge/skills/b", "--hide", "history/projects/x"]);
    expect(result.shareFlags).toEqual(["knowledge/skills/a", "knowledge/skills/b"]);
    expect(result.hideFlags).toEqual(["history/projects/x"]);
    expect(result.rest).toEqual([]);
  });

  it("leaves a valued flag untouched when it is the very last token with no value to pair", () => {
    const result = parseLauncherArgv(["--print", "--category"]);
    expect(result.categoryFlags).toEqual([]);
    expect(result.rest).toEqual(["--print", "--category"]);
  });

  it("consumes agent-shim flags positioned after a leading @name", () => {
    const result = parseLauncherArgv(["@work", "--category", "history=true", "--print"]);
    expect(result.identity).toBe("work");
    expect(result.categoryFlags).toEqual(["history=true"]);
    expect(result.rest).toEqual(["--print"]);
  });

  it("takes --identity <name> and --identity=<name> as the explicit form of @name", () => {
    expect(parseLauncherArgv(["--identity", "work", "--print"])).toMatchObject({ identity: "work", rest: ["--print"] });
    expect(parseLauncherArgv(["--print", "--identity=work"])).toMatchObject({ identity: "work", rest: ["--print"] });
  });

  it("accepts @name and --identity together when they agree, and refuses them when they differ", () => {
    expect(parseLauncherArgv(["@work", "--identity", "work"]).identity).toBe("work");
    expect(() => parseLauncherArgv(["@work", "--identity", "personal"])).toThrow(ConflictingIdentityError);
  });

  it("parses --no-provider as an explicit opt-out, the later of it and --provider winning", () => {
    expect(parseLauncherArgv(["--no-provider"]).provider).toBe(false);
    expect(parseLauncherArgv(["--provider", "z", "--no-provider"]).provider).toBe(false);
    expect(parseLauncherArgv(["--no-provider", "--provider", "z"]).provider).toBe("z");
    expect(parseLauncherArgv(["--print"]).provider).toBeUndefined();
  });

  it.each([
    ["--skip-permissions", "skipPermissions"],
    ["--remote-control", "remoteControl"],
  ] as const)("parses %s and its --no- form as consumed booleans, later occurrence winning", (flag, key) => {
    const negated = `--no-${flag.slice(2)}`;
    expect(parseLauncherArgv([flag, "--print"])).toMatchObject({ [key]: true, rest: ["--print"] });
    expect(parseLauncherArgv([flag, negated])[key]).toBe(false);
    expect(parseLauncherArgv(["--print"])[key]).toBeUndefined();
  });

  it("stops recognising its own flags at a double-dash terminator, forwarding everything from it verbatim", () => {
    const result = parseLauncherArgv(["@work", "mcp", "add", "n", "--provider", "z", "--", "cmd", "--provider", "x", "--identity", "y", "--no-headroom"]);
    expect(result.identity).toBe("work");
    expect(result.provider).toBe("z");
    expect(result.headroom).toBeUndefined();
    expect(result.rest).toEqual(["mcp", "add", "n", "--", "cmd", "--provider", "x", "--identity", "y", "--no-headroom"]);
  });

  it("leaves a valued flag directly before the double-dash terminator unconsumed rather than taking it as its value", () => {
    expect(parseLauncherArgv(["--provider", "--", "x"])).toMatchObject({ rest: ["--provider", "--", "x"] });
    expect(parseLauncherArgv(["--provider", "--", "x"]).provider).toBeUndefined();
  });

  it("consumes --native before a terminator and strips it from rest, leaving Claude Code's own --bare to be forwarded", () => {
    const result = parseLauncherArgv(["--native", "--bare", "--print", "hi"]);
    expect(result.native).toBe(true);
    expect(result.rest).toEqual(["--bare", "--print", "hi"]);
    expect(parseLauncherArgv(["--bare"]).native).toBeUndefined();
  });

  it("leaves --native after a -- terminator for the command claude runs", () => {
    const result = parseLauncherArgv(["mcp", "add", "n", "--", "cmd", "--native"]);
    expect(result.native).toBeUndefined();
    expect(result.rest).toEqual(["mcp", "add", "n", "--", "cmd", "--native"]);
  });
});

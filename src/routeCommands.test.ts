import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { EXIT_USAGE } from "./cliError";
import { cli, expectOk, keychain, parseJson, paths } from "./programTestWorld";
import { realFsPort } from "./realPorts";
import { createRouteOverridesReader, readRouteOverrides, writeRouteOverrides } from "./routeOverridesStore";

describe("route commands", () => {
  const addZ = ["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic", "--credential", "env:Z_API_TOKEN"];

  it("sets, lists and removes an override per scope, with one report object under --json", async () => {
    expectOk(await cli(addZ));
    expectOk(await cli(["identity", "add", "work"]));
    const set = await cli(["route", "set", "opus", "z/glm-5.3", "--json"]);
    expectOk(set);
    expect(parseJson(set.stdout)).toEqual({ action: "updated", kind: "route", name: "opus", value: { scope: "global", model: "opus", target: "z/glm-5.3" } });
    expectOk(await cli(["route", "set", "claude-sonnet-5-5", "auto/z/sonnet", "--identity", "work"]));
    expectOk(await cli(["route", "set", "haiku", "z/air", "--session", "abc"]));
    const list = await cli(["route", "list", "--json"]);
    expect(parseJson(list.stdout)).toEqual([
      { scope: "session:abc", model: "haiku", target: "z/air" },
      { scope: "identity:work", model: "claude-sonnet-5-5", target: "auto/z/sonnet" },
      { scope: "global", model: "opus", target: "z/glm-5.3" },
    ]);
    expect((await cli(["route", "remove", "opus"])).code).toBe(EXIT_USAGE);
    expect(parseJson((await cli(["route", "remove", "opus", "--yes", "--json"])).stdout)).toEqual({ action: "removed", kind: "route", name: "opus" });
    expect((await cli(["route", "list"])).stdout).toContain("identity:work  claude-sonnet-5-5 -> auto/z/sonnet");
    expect(readRouteOverrides(paths)).toEqual({ schemaVersion: 1, identities: { work: { "claude-sonnet-5-5": "auto/z/sonnet" } }, sessions: { abc: { haiku: "z/air" } } });
  });

  it.each<[readonly string[]]>([[["--session", ""]], [["--identity", ""]], [["--provider", ""]]])("refuses an empty scope name, %j, and leaves no file a reader cannot use", async (scope) => {
    const result = await cli(["route", "set", "opus", "claude-sonnet-5-5", ...scope]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("empty");
    expect(fs.existsSync(paths.routeOverridesFile)).toBe(false);
  });

  it("repairs a file an entry it cannot read made unusable, by removing that entry", async () => {
    fs.writeFileSync(paths.routeOverridesFile, JSON.stringify({ schemaVersion: 1, global: { haiku: "claude-haiku-5-1" }, sessions: { "": { opus: "claude-sonnet-5-5" } } }));
    expect(createRouteOverridesReader(realFsPort, paths.routeOverridesFile, () => undefined)()).toHaveProperty("fault");
    expectOk(await cli(["route", "remove", "opus", "--session", "", "--yes"]));
    expect(createRouteOverridesReader(realFsPort, paths.routeOverridesFile, () => undefined)()).toEqual({ table: { schemaVersion: 1, global: { haiku: "claude-haiku-5-1" } } });
  });

  it.each<[readonly string[], boolean]>([
    [["route", "set", "sonnet", "auto/sonnet"], true],
    [["route", "set", "opus", "auto/family:glm/sonnet"], false],
    [["route", "set", "opus", "z/"], false],
    [["route", "set", "opus", "anthropic/"], false],
    [["route", "set", "opus", "auto/z/opus"], true],
    [["route", "set", "opus", "auto/sonnet", "--provider", "z"], true],
  ])("decides %j as the door would route it: accepted %j", async (argv, accepted) => {
    expectOk(await cli(addZ));
    const result = await cli(argv);
    expect(result.code === 0).toBe(accepted);
  });

  it("reports the key as stored, in lower case, whatever case it was typed in", async () => {
    expectOk(await cli(addZ));
    expectOk(await cli(["route", "set", "haiku", "z/air"]));
    expect(parseJson((await cli(["route", "remove", "HAIKU", "--yes", "--json"])).stdout)).toEqual({ action: "removed", kind: "route", name: "haiku" });
    expect(parseJson((await cli(["route", "set", "OPUS", "z/glm-5.3", "--json"])).stdout)).toEqual({ action: "updated", kind: "route", name: "opus", value: { scope: "global", model: "opus", target: "z/glm-5.3" } });
    expect((await cli(["route", "set", "Claude-Sonnet-5-5", "z/glm-5.3"])).stdout).toContain("Routing claude-sonnet-5-5 to z/glm-5.3");
  });

  it("reports a removal by the key as stored, as text and as JSON, and a key a hand edit stored in another case by that spelling", async () => {
    expectOk(await cli(addZ));
    expectOk(await cli(["route", "set", "haiku", "z/air"]));
    expect((await cli(["route", "remove", "HAIKU", "--yes"])).stdout).toContain("Removed the override of haiku ");
    writeRouteOverrides(paths, { schemaVersion: 1, global: { Opus: "z/glm-5.3" } });
    expect((await cli(["route", "remove", "opus", "--yes"])).stdout).toContain("Removed the override of Opus ");
    writeRouteOverrides(paths, { schemaVersion: 1, global: { Opus: "z/glm-5.3" } });
    expect(parseJson((await cli(["route", "remove", "OPUS", "--yes", "--json"])).stdout)).toEqual({ action: "removed", kind: "route", name: "Opus" });
  });

  it("has doctor report an overrides file it cannot read as a failure, print the whole report, and exit 1", async () => {
    fs.mkdirSync(paths.routeOverridesFile, { recursive: true });
    const result = await cli(["doctor"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/\[FAIL\][^\n]*route-overrides\.json cannot be read \(EISDIR\)/u);
    // The rest of the audit is there too, not one line and an exit.
    expect(result.stdout).toContain("Route overrides");
    expect(result.stdout).toContain("Virtual models");
    const json = parseJson((await cli(["doctor", "--json"])).stdout);
    expect(JSON.stringify(json)).toContain('"section":"route-overrides","severity":"fail"');
  });

  it("says when no override is set", async () => {
    expect((await cli(["route", "list"])).stdout).toBe("No route overrides are set.\n");
  });

  it.each<[readonly string[], string]>([
    [["route", "set", "z/opus", "z/glm"], "bare Claude name"],
    [["route", "set", "opus", "nowhere/glm"], 'no provider "nowhere"'],
    [["route", "set", "opus", "auto"], "<provider>/auto"],
    [["route", "set", "opus", "auto/nothing"], "names nothing"],
    [["route", "set", "opus", "acct:ghost/opus"], 'no identity "ghost"'],
    [["route", "set", "opus", "z/glm", "--identity", "ghost"], 'no identity "ghost"'],
    [["route", "set", "opus", "z/glm", "--provider", "ghost"], 'no provider "ghost"'],
    [["route", "set", "opus", "z/glm", "--identity", "a", "--session", "b"], "at most one"],
    [["route", "remove", "opus", "--yes"], "No override"],
  ])("refuses %j, naming why, and writes nothing", async (argv, fragment) => {
    expectOk(await cli(addZ));
    const result = await cli(argv);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(fragment);
    expect(fs.existsSync(paths.routeOverridesFile)).toBe(false);
  });
});

describe("model explain for a selector and a Claude name", () => {
  const addZ = ["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic", "--credential", "env:Z_API_TOKEN", "--env", "ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7"];

  it("says what a selector is routed as, or why it is refused", async () => {
    expectOk(await cli(addZ));
    expect(parseJson((await cli(["model", "explain", "auto/z/sonnet", "--json"])).stdout)).toEqual({ name: "auto/z/sonnet", kind: "provider", routedAs: "z/glm-4.7" });
    expect((await cli(["model", "explain", "auto/z/sonnet"])).stdout).toContain("auto/z/sonnet selects the provider and is routed as z/glm-4.7");
    const refused = parseJson((await cli(["model", "explain", "auto/nothing", "--json"])).stdout);
    expect(refused).toMatchObject({ name: "auto/nothing" });
    expect(JSON.stringify(refused)).toContain("names nothing");
  });

  it("names the route override that applies to a Claude name in the given scopes, what its target is routed as, and what it outranks", async () => {
    expectOk(await cli(addZ));
    expectOk(await cli(["identity", "add", "work"]));
    expectOk(await cli(["route", "set", "opus", "z/glm-5.3"]));
    expectOk(await cli(["route", "set", "claude-opus-5-5", "auto/z/sonnet", "--identity", "work"]));
    expect(parseJson((await cli(["model", "explain", "claude-opus-5-5", "--identity", "work", "--json"])).stdout)).toEqual({
      name: "claude-opus-5-5",
      override: { scope: "identity:work", target: "auto/z/sonnet", match: "exact", routedAs: "z/glm-4.7" },
      outranks: [{ scope: "global", target: "z/glm-5.3" }],
    });
    const text = (await cli(["model", "explain", "claude-opus-5-1"])).stdout;
    expect(text).toContain("claude-opus-5-1 is routed to z/glm-5.3 by the global override of its class");
    expect((await cli(["model", "explain", "claude-haiku-5-5"])).stdout).toContain("No route override applies to claude-haiku-5-5");
    expectOk(await cli(["route", "set", "haiku", "auto/z", "--session", "s1"]));
    expect(parseJson((await cli(["model", "explain", "claude-haiku-5-5", "--session", "s1", "--json"])).stdout)).toMatchObject({ override: { scope: "session:s1", target: "auto/z" } });
    expectOk(await cli(["route", "set", "sonnet", "auto/work/sonnet"]));
    expect((await cli(["model", "explain", "claude-sonnet-5-5", "--identity", "work"])).stdout).toContain("which is refused:");
    expect(parseJson((await cli(["model", "explain", "claude-sonnet-5-5", "--json"])).stdout)).toMatchObject({ override: { routedAs: "acct:work/sonnet" } });
  });

  it("expands a class-alone target on the provider --provider names, as the door does for a session there", async () => {
    expectOk(await cli(addZ));
    expectOk(await cli(["route", "set", "opus", "auto/sonnet"]));
    expect(parseJson((await cli(["model", "explain", "claude-opus-5-5", "--provider", "z", "--json"])).stdout)).toMatchObject({ override: { target: "auto/sonnet", routedAs: "z/glm-4.7" } });
    expect(parseJson((await cli(["model", "explain", "claude-opus-5-5", "--json"])).stdout)).toMatchObject({ override: { target: "auto/sonnet", refusal: expect.stringContaining("Anthropic route") as unknown } });
  });

  it("compares an account selector with the identity --identity names", async () => {
    expectOk(await cli(["identity", "add", "work"]));
    // The Keychain lookup `identity add` makes went to the fake, never `security` on this machine.
    expect(keychain.calls.length).toBeGreaterThan(0);
    expect(parseJson((await cli(["model", "explain", "auto/work/claude-opus-5-5", "--json"])).stdout)).toMatchObject({ routedAs: "acct:work/claude-opus-5-5" });
    expect(parseJson((await cli(["model", "explain", "auto/work/claude-opus-5-5", "--identity", "work", "--json"])).stdout)).toEqual({ name: "auto/work/claude-opus-5-5", kind: "identity", routedAs: "anthropic/claude-opus-5-5", ownLogin: true });
    expect(parseJson((await cli(["model", "explain", "auto/work/claude-opus-5-5", "--json"])).stdout)).not.toHaveProperty("ownLogin");
    // Beside a provider file called anthropic, the session's own login is still named as such: the door serves it on the Anthropic route.
    expectOk(await cli(["provider", "add", "anthropic", "--display-name", "Anthropic-named", "--base-url", "https://anthropic.invalid", "--credential", "env:NAMED_TOKEN"]));
    expect((await cli(["model", "explain", "auto/work/claude-opus-5-5", "--identity", "work"])).stdout).toContain("routed as anthropic/claude-opus-5-5 on the Anthropic route of the session's own login");
  });

  it("still explains a virtual model, as text and as JSON", async () => {
    expectOk(await cli(addZ));
    expectOk(await cli(["model", "add", "fast", "--mode", "ordered", "--member", "z/glm-5.3"]));
    expect((await cli(["model", "explain", "fast"])).stdout).toContain("fast (ordered) chooses z/glm-5.3:");
    expect(parseJson((await cli(["model", "explain", "fast", "--json"])).stdout)).toMatchObject({ name: "fast", mode: "ordered", chooses: "z/glm-5.3", candidates: ["z/glm-5.3"] });
    expectOk(await cli(["identity", "add", "work"]));
    expectOk(await cli(["model", "add", "mine", "--mode", "ordered", "--member", "acct:work/opus"]));
    const accountOnly = (await cli(["model", "explain", "mine"])).stdout;
    expect(accountOnly).toContain("mine (ordered) chooses nothing by quota:");
    expect(accountOnly).toContain("served by relaunching the session");
  });
});


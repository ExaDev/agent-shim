import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addIdentity, setIdentityProvider } from "../identityStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { cliSelectorPorts, poolRefusal, realSelectorStatePorts } from "./selectorPorts";
import { expandSelectorName } from "./selectors";

/** Writes one JSON file of the layout, making its directory. */
function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

describe("the selector state read from the person's files", () => {
  let root: string;
  let paths: LayoutPaths;
  const now = (): number => Date.parse("2026-11-13T12:00:00Z");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "selector-ports-test-"));
    paths = buildLayoutPaths(root);
    write(path.join(paths.providersDir, "z.json"), { displayName: "Z", baseUrl: "http://127.0.0.1:9", credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.7", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" } });
    write(path.join(paths.configProfilesDir, "base.json"), { launch: { provider: "z" } });
    write(path.join(paths.configProfilesDir, "child.json"), { extends: ["base"] });
    write(path.join(paths.configProfilesDir, "plain.json"), {});
    write(path.join(paths.configProfilesDir, "broken.json"), { launch: { provider: 5 } });
    addIdentity(paths, "me");
    addIdentity(paths, "work");
    addIdentity(paths, "zid");
    setIdentityProvider(paths, "zid", "z");
    write(paths.globalConfigFile, { pools: { subs: { identities: ["work"] } } });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads a profile's provider through its extends chain, and reports an invalid profile with its reason", () => {
    const state = realSelectorStatePorts(paths, now);
    expect(state.profile("child")).toEqual({ kind: "found", value: { provider: "z" } });
    expect(state.profile("plain")).toEqual({ kind: "found", value: { provider: undefined } });
    expect(state.profile("nothing")).toEqual({ kind: "absent" });
    expect(state.profile("broken").kind).toBe("invalid");
  });

  it("reads an identity's own provider, a pool's existence, and the same login by name", () => {
    const state = realSelectorStatePorts(paths, now);
    expect(state.identity("zid")).toEqual({ kind: "found", value: { provider: "z" } });
    expect(state.identity("me")).toEqual({ kind: "found", value: { provider: undefined } });
    expect(state.identity("nobody")).toEqual({ kind: "absent" });
    expect(state.pool("subs")).toEqual({ kind: "found", value: undefined });
    expect(state.pool("none")).toEqual({ kind: "absent" });
    expect(state.sameLogin("me", "me")).toBe(true);
    expect(state.sameLogin("work", "me")).toBe(false);
  });

  it("treats two identities holding one account in one organisation as one login, and others as not", () => {
    addIdentity(paths, "twin");
    const login = (identity: string, account: string, organisation: string): void => {
      write(path.join(paths.identitiesDir, identity, ".claude.json"), { oauthAccount: { accountUuid: account, organizationUuid: organisation } });
    };
    login("me", "acc-1", "org-1");
    login("twin", "acc-1", "org-1");
    login("work", "acc-1", "org-2");
    const state = realSelectorStatePorts(paths, now);
    expect(state.sameLogin("twin", "me")).toBe(true);
    expect(state.sameLogin("work", "me")).toBe(false);
    expect(state.sameLogin("zid", "me")).toBe(false);
    expect(state.sameLogin("nobody", "me")).toBe(false);
  });

  it("names the member back soonest when a pool picks nobody", () => {
    expect(poolRefusal("subs", { identity: "work", at: "2026-11-13T15:00:00.000Z" })).toBe('every member of pool "subs" is refused right now; the earliest back is work at 2026-11-13T15:00:00.000Z');
    expect(poolRefusal("subs", undefined)).toBe('every member of pool "subs" is refused right now');
  });

  it("ranks a pool to its only member", () => {
    expect(realSelectorStatePorts(paths, now).poolPick("subs")).toEqual({ identity: "work" });
  });

  it("expands a selector as the door would from the same files, for model explain", () => {
    const ports = cliSelectorPorts(paths, now);
    const expand = (name: string): unknown => {
      const result = expandSelectorName(name, ports, { identity: "me" });
      return result === undefined || "refusal" in result ? result : result.name;
    };
    expect(expand("auto/z/sonnet")).toBe("z/glm-4.7");
    expect(expand("auto/z/opus")).toBe("z/glm-5.3");
    expect(expand("auto/child/sonnet")).toBe("z/glm-4.7");
    expect(expand("auto/zid/opus")).toBe("z/glm-5.3");
    expect(expand("auto/subs/sonnet")).toBe("acct:work/sonnet");
    expect(expand("auto/me/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
    expect(expand("auto/plain/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
  });
});

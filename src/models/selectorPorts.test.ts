import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addIdentity, setIdentityProvider } from "../identityStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { cliSelectorPorts, poolRefusal, realSelectorStatePorts } from "./selectorPorts";
import { USAGE_SCHEMA_VERSION } from "../usage/schema";
import { expandSelectorName } from "./selectors";

const SEEN = "2026-11-13T11:30:00.000Z";
const RESETS = "2026-11-14T12:00:00.000Z";
const LOW = 0.2;

/** Writes one JSON file of the layout, making its directory. */
function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

describe("the selector state read from the person's files", () => {
  let root: string;
  let paths: LayoutPaths;
  /** A home directory of the test's own, so no pool ranking reads the real one's per-directory picks. */
  let home: string;
  const now = (): number => Date.parse("2026-11-13T12:00:00Z");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "selector-ports-test-"));
    paths = buildLayoutPaths(root);
    home = path.join(root, "home");
    fs.mkdirSync(home);
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
    const state = realSelectorStatePorts(paths, now, home);
    expect(state.profile("child")).toEqual({ kind: "found", value: { provider: "z" } });
    expect(state.profile("plain")).toEqual({ kind: "found", value: { provider: undefined } });
    expect(state.profile("nothing")).toEqual({ kind: "absent" });
    expect(state.profile("broken").kind).toBe("invalid");
  });

  it("reads an identity's own provider, a pool's existence, and the same login by name", () => {
    const state = realSelectorStatePorts(paths, now, home);
    expect(state.identity("zid")).toEqual({ kind: "found", value: { provider: "z" } });
    expect(state.identity("me")).toEqual({ kind: "found", value: { provider: undefined } });
    expect(state.identity("nobody")).toEqual({ kind: "absent" });
    expect(state.pool("subs")).toEqual({ kind: "found", value: undefined });
    expect(state.pool("none")).toEqual({ kind: "absent" });
    expect(state.sameLogin("me", "me")).toBe(true);
    expect(state.sameLogin("work", "me")).toBe(false);
  });

  it("compares a selected name with the session's identity id, so a name another identity was renamed from never matches it", () => {
    // Identity "work" is renamed "personal", keeping its directory id "work"; a second identity then takes the name "work".
    write(path.join(paths.identitiesDir, "work", "identity.json"), { name: "personal", allowAmbientCredential: false });
    write(path.join(paths.identitiesDir, "work-2", "identity.json"), { name: "work", allowAmbientCredential: false });
    write(path.join(paths.identitiesDir, "work", ".claude.json"), { oauthAccount: { accountUuid: "acc-a", organizationUuid: "org" } });
    write(path.join(paths.identitiesDir, "work-2", ".claude.json"), { oauthAccount: { accountUuid: "acc-b", organizationUuid: "org" } });
    const state = realSelectorStatePorts(paths, now, home);
    expect(state.sameLogin("work", "work")).toBe(false);
    expect(state.sameLogin("personal", "work")).toBe(true);
    expect(state.sameLogin("work", "work-2")).toBe(true);
    const expand = (name: string, identityId: string): unknown => {
      const result = expandSelectorName(name, cliSelectorPorts(paths, now, home), { identityId });
      return result === undefined || "refusal" in result ? result : result.name;
    };
    expect(expand("auto/work/claude-opus-5-5", "work")).toBe("acct:work/claude-opus-5-5");
    expect(expand("auto/personal/claude-opus-5-5", "work")).toBe("anthropic/claude-opus-5-5");
  });

  it("treats two identities holding one account in one organisation as one login, and others as not", () => {
    addIdentity(paths, "twin");
    const login = (identity: string, account: string, organisation: string): void => {
      write(path.join(paths.identitiesDir, identity, ".claude.json"), { oauthAccount: { accountUuid: account, organizationUuid: organisation } });
    };
    login("me", "acc-1", "org-1");
    login("twin", "acc-1", "org-1");
    login("work", "acc-1", "org-2");
    const state = realSelectorStatePorts(paths, now, home);
    expect(state.sameLogin("twin", "me")).toBe(true);
    expect(state.sameLogin("work", "me")).toBe(false);
    expect(state.sameLogin("zid", "me")).toBe(false);
    expect(state.sameLogin("nobody", "me")).toBe(false);
  });

  it("names the member back soonest when a pool picks nobody", () => {
    expect(poolRefusal("subs", { identity: "work", at: "2026-11-13T15:00:00.000Z" })).toBe('every member of pool "subs" is refused right now; the earliest back is work at 2026-11-13T15:00:00.000Z');
    expect(poolRefusal("subs", undefined)).toBe('every member of pool "subs" is refused right now');
  });

  it("ranks a pool from the home directory it is given, reading that directory's last pick and never the process's own home", () => {
    write(paths.globalConfigFile, { pools: { both: { identities: ["me", "work"] } } });
    const pickFor = (identity: string): void => {
      // A minute before `now`, inside the prompt cache lifetime, so the pick holds.
      write(paths.usagePicksFile, { schemaVersion: 1, picks: { [home]: { identity, at: "2026-11-13T11:59:00.000Z" } } });
    };
    // Both members have recorded quota (so the ranking scores them and a warm last pick can hold), the same for each.
    for (const id of ["me", "work"]) {
      write(path.join(paths.usageSnapshotsDir, `${id}.json`), { schemaVersion: USAGE_SCHEMA_VERSION, identity: id, updatedAt: SEEN, providers: { anthropic: { lastRequestAt: SEEN, lastStatus: 200, rateLimit: { observedAt: SEEN, headers: {}, unified: { fiveHour: { utilization: LOW, resetsAt: RESETS }, sevenDay: { utilization: LOW, resetsAt: RESETS } } } } } });
    }
    pickFor("me");
    expect(realSelectorStatePorts(paths, now, home).poolPick("both")).toEqual({ identity: "me" });
    pickFor("work");
    expect(realSelectorStatePorts(paths, now, home).poolPick("both")).toEqual({ identity: "work" });
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("finds no profile, identity, pool, provider or family called %j, a name every object inherits", (name) => {
    const ports = cliSelectorPorts(paths, now, home);
    expect(ports.pool(name)).toEqual({ kind: "absent" });
    expect(ports.profile(name)).toEqual({ kind: "absent" });
    expect(ports.identity(name)).toEqual({ kind: "absent" });
    expect(ports.provider(name)).toEqual({ kind: "absent" });
    expect(ports.family(name)).toBe(false);
    const result = expandSelectorName(`auto/${name}/opus`, ports, { identityId: "me" });
    expect(result !== undefined && "refusal" in result ? result.refusal : "").toContain("names nothing");
  });

  it("ranks a pool to its only member", () => {
    expect(realSelectorStatePorts(paths, now, home).poolPick("subs")).toEqual({ identity: "work" });
  });

  it("expands a selector as the door would from the same files, for model explain", () => {
    const ports = cliSelectorPorts(paths, now, home);
    const expand = (name: string): unknown => {
      const result = expandSelectorName(name, ports, { identityId: "me" });
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

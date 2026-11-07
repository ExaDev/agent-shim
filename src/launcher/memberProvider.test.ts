import { describe, expect, it, vi } from "vitest";

import type { Identity } from "../config/schema";
import type { CascadeInput } from "../resolve/walk";
import { FAKE_HOME, fakeFs, paths } from "../test-helpers";
import { identityReader } from "./identity";
import { memberProviderResolver, type MemberProviderParams } from "./memberProvider";

const identityFile = (id: string): string => `${paths.identitiesDir}/${id}/identity.json`;
const providerFile = (name: string): string => `${paths.providersDir}/${name}.json`;

const PROVIDER = { displayName: "Example", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ env: "EXAMPLE_TOKEN" }] } };

const identity = (name: string, rest: Partial<Identity> = {}): Record<string, unknown> => ({ name, allowAmbientCredential: false, ...rest });

/** A cascade whose layers select `provider` through `launch.provider`, or select nothing. */
function cascadeSelecting(provider: string | undefined): CascadeInput {
  return { home: FAKE_HOME, loadProfile: () => undefined, levels: [], ...(provider === undefined ? {} : { cliOverride: { launch: { provider } } }) };
}

function resolver(files: Record<string, unknown>, overrides: Partial<MemberProviderParams> = {}) {
  return memberProviderResolver({ paths, fs: fakeFs(files), env: {}, cliProvider: undefined, loadCascade: () => cascadeSelecting(undefined), ...overrides });
}

describe("memberProviderResolver", () => {
  const members = { [identityFile("work")]: identity("work"), [identityFile("personal")]: identity("personal", { provider: "own" }), [providerFile("own")]: PROVIDER, [providerFile("flag")]: PROVIDER, [providerFile("pinned")]: PROVIDER };

  it("gives every member the provider the launch flag names, outranking what a member declares", () => {
    const providerOf = resolver(members, { cliProvider: "flag" });
    expect([providerOf("work"), providerOf("personal")]).toEqual(["flag", "flag"]);
  });

  it("gives no member a provider when the launch opts out of providers, whatever a member declares", () => {
    const providerOf = resolver(members, { cliProvider: false, loadCascade: () => cascadeSelecting("pinned") });
    expect([providerOf("work"), providerOf("personal")]).toEqual([undefined, undefined]);
  });

  it("falls to the provider a member declares in its own identity when nothing else selects one", () => {
    const providerOf = resolver(members);
    expect([providerOf("work"), providerOf("personal")]).toEqual([undefined, "own"]);
  });

  it("lets a provider a cascade layer selects outrank a member's own declaration", () => {
    const providerOf = resolver(members, { loadCascade: () => cascadeSelecting("pinned") });
    expect([providerOf("work"), providerOf("personal")]).toEqual(["pinned", "pinned"]);
  });

  it("reads a member's cascade over the configuration profile that member would launch with", () => {
    const loadCascade = vi.fn((base: string | undefined) => cascadeSelecting(base === "glm" ? "pinned" : undefined));
    const files = { ...members, [identityFile("work")]: identity("work", { defaultConfigProfile: "glm" }) };
    const providerOf = resolver(files, { loadCascade });
    expect(providerOf("work")).toBe("pinned");
    expect(providerOf("personal")).toBe("own");
    expect(loadCascade.mock.calls.map(([base]) => base)).toEqual(["glm", undefined]);
  });

  it("prefers the launch's own profile choice to a member's default, as a launch does", () => {
    const loadCascade = vi.fn((base: string | undefined) => cascadeSelecting(base === "flagged" ? "pinned" : undefined));
    const files = { ...members, [identityFile("work")]: identity("work", { defaultConfigProfile: "glm" }) };
    expect(resolver(files, { loadCascade, cliFlagConfigProfile: "flagged" })("work")).toBe("pinned");
    expect(resolver(files, { loadCascade, env: { AGENT_SHIM_CONFIG_PROFILE: "flagged" } })("work")).toBe("pinned");
    expect(resolver(files, { loadCascade, directoryRuleConfigProfile: "flagged" })("work")).toBe("pinned");
    expect(resolver(members, { loadCascade, globalDefaultConfigProfile: "flagged" })("work")).toBe("pinned");
  });

  it("loads each distinct cascade once however many members share its profile", () => {
    const loadCascade = vi.fn(() => cascadeSelecting(undefined));
    const providerOf = resolver(members, { loadCascade });
    providerOf("work");
    providerOf("personal");
    providerOf("work");
    expect(loadCascade).toHaveBeenCalledTimes(1);
  });

  it("names the provider a renamed one became, as a launch does", () => {
    const files = { ...members, [paths.providerAliasesFile]: { old: "own" } };
    const providerOf = resolver(files, { cliProvider: "old" });
    expect(providerOf("work")).toBe("own");
  });

  it("names a provider no file defines as it was named, leaving the refusal to the launch", () => {
    expect(resolver(members, { cliProvider: "missing" })("work")).toBe("missing");
  });

  it("resolves a member with an invalid identity file from the launch's own selections, leaving the refusal to the launch that picks it", () => {
    const files = { ...members, [identityFile("work")]: { name: "work", allowAmbientCredential: "no" } };
    expect(resolver(files, { cliProvider: "flag" })("work")).toBe("flag");
    expect(resolver(files)("work")).toBeUndefined();
  });

  it("names no provider for a member with no identity", () => {
    expect(resolver(members, { loadCascade: () => cascadeSelecting(undefined) })("nobody")).toBeUndefined();
  });
});

describe("identityReader", () => {
  it("answers ids and identities from one read of each identity file", () => {
    const reads: string[] = [];
    const base = fakeFs({ [identityFile("work")]: identity("work"), [identityFile("personal")]: identity("personal", { provider: "own" }) });
    const reader = identityReader(paths.identitiesDir, {
      readdir: base.readdir,
      readConfigFile: (file) => {
        reads.push(file);
        return base.readConfigFile(file);
      },
    });
    expect(reader.idOf("work")).toBe("work");
    expect(reader.load("personal")?.provider).toBe("own");
    expect(reader.load("work")?.name).toBe("work");
    expect(reader.load("nobody")).toBeUndefined();
    expect([...reads].sort()).toEqual([identityFile("personal"), identityFile("work")]);
  });
});

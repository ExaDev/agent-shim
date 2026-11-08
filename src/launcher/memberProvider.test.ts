import { describe, expect, it, vi } from "vitest";

import { ConfigFileNotJsonError, ConfigValidationError } from "../config/load";
import type { Identity } from "../config/schema";
import type { CascadeInput } from "../resolve/walk";
import { FAKE_HOME, fakeFs, paths } from "../test-helpers";
import { identityReader } from "./identity";
import type { UnreadableProvider } from "../usage/poolPick";
import { memberProviderResolver, type MemberProviderParams } from "./memberProvider";

const identityFile = (id: string): string => `${paths.identitiesDir}/${id}/identity.json`;
const providerFile = (name: string): string => `${paths.providersDir}/${name}.json`;

const PROVIDER = { displayName: "Example", baseUrl: "https://api.example.com/anthropic", credential: { sources: [{ env: "EXAMPLE_TOKEN" }] } };

const identity = (name: string, rest: Partial<Identity> = {}): Record<string, unknown> => ({ name, allowAmbientCredential: false, ...rest });

/** A cascade whose layers select `provider` through `launch.provider`, or select nothing. */
function cascadeSelecting(provider: string | undefined): CascadeInput {
  return { home: FAKE_HOME, loadProfile: () => undefined, levels: [], ...(provider === undefined ? {} : { cliOverride: { launch: { provider } } }) };
}

/** The unreadable-provider report a resolver gave, failing the test when it gave a name or nothing. */
function unreadable(resolved: string | UnreadableProvider | undefined): UnreadableProvider {
  if (typeof resolved !== "object") {
    throw new Error(`expected an unreadable provider, got ${String(resolved)}`);
  }
  return resolved;
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

  describe("a member whose provider configuration cannot be read", () => {
    const withBroken = (provider: string, file: unknown): Record<string, unknown> => ({
      ...members,
      [identityFile("work")]: identity("work", { provider }),
      [providerFile(provider)]: file,
    });

    it("reports a provider file that fails validation, naming the provider as the member declares it", () => {
      const providerOf = resolver(withBroken("bad", { displayName: 5 }));
      const broken = unreadable(providerOf("work"));
      expect(broken.named).toBe("bad");
      expect(broken.reason).toContain(providerFile("bad"));
      expect(providerOf("personal")).toBe("own");
    });

    it("reports a provider file in the format before the credential block", () => {
      const providerOf = resolver(withBroken("old", { displayName: "Old", baseUrl: "https://api.example.com/anthropic", tokenEnv: "OLD_TOKEN" }));
      const broken = unreadable(providerOf("work"));
      expect(broken.named).toBe("old");
      expect(broken.reason).toContain("tokenEnv");
      expect(providerOf("personal")).toBe("own");
    });

    it("reports a provider file that is not JSON", () => {
      const base = fakeFs(members);
      const fs = {
        ...base,
        readConfigFile: (file: string) => {
          if (file === providerFile("own")) {
            throw new ConfigFileNotJsonError(file);
          }
          return base.readConfigFile(file);
        },
      };
      const providerOf = memberProviderResolver({ paths, fs, env: {}, cliProvider: undefined, loadCascade: () => cascadeSelecting(undefined) });
      const broken = unreadable(providerOf("personal"));
      expect(broken.named).toBe("own");
      expect(broken.reason).toContain(providerFile("own"));
      expect(providerOf("work")).toBeUndefined();
    });

    it("reports the provider the launch flag names when its file is broken, for every member", () => {
      const providerOf = resolver(withBroken("bad", { displayName: 5 }), { cliProvider: "bad" });
      expect(unreadable(providerOf("personal")).named).toBe("bad");
      expect(unreadable(providerOf("work")).named).toBe("bad");
    });

    it("reports a configuration profile that fails validation, naming the provider the member and flag leave", () => {
      const loadCascade = (base: string | undefined): CascadeInput => {
        if (base === "broken") {
          throw new ConfigValidationError("/profiles/broken.json", []);
        }
        return cascadeSelecting(undefined);
      };
      const files = { ...members, [identityFile("work")]: identity("work", { defaultConfigProfile: "broken", provider: "own" }) };
      const providerOf = resolver(files, { loadCascade });
      const broken = unreadable(providerOf("work"));
      expect(broken.named).toBe("own");
      expect(broken.reason).toContain("/profiles/broken.json");
      expect(providerOf("personal")).toBe("own");
      expect(unreadable(resolver(files, { loadCascade, cliProvider: "flag" })("work")).named).toBe("flag");
    });

    it("names no provider when a broken profile leaves nothing that names one", () => {
      const loadCascade = (): CascadeInput => {
        throw new ConfigValidationError("/profiles/broken.json", []);
      };
      const broken = unreadable(resolver(members, { loadCascade })("work"));
      expect(broken.named).toBeUndefined();
      expect(broken.reason).toContain("/profiles/broken.json");
    });

    it("lets an error that is not a configuration fault through", () => {
      const providerOf = resolver(members, {
        loadCascade: () => {
          throw new Error("disk on fire");
        },
      });
      expect(() => providerOf("work")).toThrow("disk on fire");
    });
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

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as library from "./index";

describe("library surface", () => {
  it("exposes the module groups", () => {
    expect(typeof library.resolveDecisions).toBe("function");
    expect(typeof library.resyncFarm).toBe("function");
    expect(typeof library.startConnectServer).toBe("function");
    expect(typeof library.runFrontDoorSupervisor).toBe("function");
    expect(typeof library.runSupervisor).toBe("function");
    expect(typeof library.evaluateAmbientCredentialGuard).toBe("function");
    expect(typeof library.readUsageSnapshot).toBe("function");
  });

  it("exposes exactly the documented entry points, so adding or removing one is a deliberate change to this list and to docs/library.md", () => {
    expect(Object.keys(library).sort()).toEqual([
      "AMBIENT_CREDENTIAL_VARS",
      "CONNECT_INTERCEPT_HOST",
      "CONNECT_INTERCEPT_HOSTS",
      "CONNECT_LIMITS",
      "CategoryClassificationOverlaySchema",
      "CategoryClassificationSchema",
      "CategoryMapSchema",
      "CliError",
      "ConfigProfileSchema",
      "CredentialCacheSchema",
      "CredentialSchema",
      "CredentialSourceSchema",
      "DirectoryRuleAlreadyExistsError",
      "DirectoryRuleMissingTargetError",
      "DirectoryRuleNotFoundError",
      "DirectoryRuleSchema",
      "DirectoryRulesSchema",
      "EXIT_FAILURE",
      "EXIT_USAGE",
      "EntryValueSchema",
      "FARM_MANIFEST_FILENAME",
      "FrontDoorStartError",
      "GlobalConfigSchema",
      "HeadroomStartError",
      "IdentityAlreadyExistsError",
      "IdentityNotFoundError",
      "IdentitySchema",
      "InvalidCategoryNameError",
      "InvalidIdentityNameError",
      "InvalidProviderNameError",
      "LegacyProviderFileError",
      "PoolNameSchema",
      "PoolNotFoundError",
      "PoolSchema",
      "PortableConfigSchema",
      "ProfileAlreadyExistsError",
      "ProfileNotFoundError",
      "ProviderAlreadyExistsError",
      "ProviderKindMismatchError",
      "ProviderNotFoundError",
      "ProviderSchema",
      "ROUTED_PATH_PREFIX",
      "UsageError",
      "UsageSnapshotError",
      "UsageSnapshotSchema",
      "WhenSchema",
      "addDirectoryRule",
      "addIdentity",
      "addPool",
      "addProvider",
      "buildEntryFacts",
      "buildLayoutPaths",
      "carryOver",
      "createLeafCache",
      "createProfile",
      "describeProviderEndpoint",
      "detectAmbientCredential",
      "ensureCa",
      "ensureFrontDoor",
      "ensureHeadroom",
      "evaluateAmbientCredentialGuard",
      "formatAmbientCredentialGuardMessage",
      "forwardableHeaders",
      "generateCa",
      "identityExists",
      "isIdentityDirectoryName",
      "isInterceptedHost",
      "listDirectoryRules",
      "listIdentities",
      "listProfiles",
      "listProviders",
      "listUsageSnapshots",
      "mintLeaf",
      "parseConnectTarget",
      "profileExists",
      "providerExists",
      "readActiveIdentity",
      "readDirectoryRules",
      "readFarmManifest",
      "readGlobalConfig",
      "readIdentity",
      "readPools",
      "readProfile",
      "readProvider",
      "readUsageSnapshot",
      "realConnectCertStore",
      "realConnectEffects",
      "recoverFarm",
      "recoveryDiagnostics",
      "removeDirectoryRule",
      "removeIdentity",
      "removePool",
      "removeProfile",
      "removeProvider",
      "requirePool",
      "resolveAgentShimHome",
      "resolveClaudeHome",
      "resolveDecisions",
      "resolveLayoutPaths",
      "resolveSupervisorConfig",
      "resyncFarm",
      "runFrontDoorSupervisor",
      "runSupervisor",
      "servedByPipeline",
      "setAllowAmbientCredential",
      "setDefaultConfigProfile",
      "setGlobalDefaultProfile",
      "setIdentityCredential",
      "setPool",
      "setProfileCategories",
      "setProfileEntries",
      "setProfileLaunchFlags",
      "setProfileMetadata",
      "snapshotPath",
      "startConnectServer",
      "topLevelNames",
      "updateDirectoryRule",
      "updateProvider",
      "useIdentity",
      "writeDirectoryRules",
    ]);
  });

  it("exposes nothing that exists for the command line alone", () => {
    const names = Object.keys(library);
    for (const cliOnly of ["buildProgram", "registerCheckCommand", "registerDoctorCommand", "reportFatalError", "runDoctor"]) {
      expect(names).not.toContain(cliOnly);
    }
  });

  it("locates the state root through the same resolution the CLI uses, adopting a former ~/.claude-use in place", () => {
    const legacy = "/home/u/.claude-use";
    expect(library.resolveAgentShimHome({}, "/home/u", (candidate) => candidate === legacy)).toBe(legacy);
    expect(library.resolveAgentShimHome({}, "/home/u", () => false)).toBe("/home/u/.agent-shim");
    expect(library.buildLayoutPaths("/root").identitiesDir).toBe("/root/identities");
  });

  it("validates configuration files with the exported schemas and types them from the same definitions", () => {
    const identity: library.Identity = library.IdentitySchema.parse({ name: "work" });
    expect(identity.name).toBe("work");
    expect(library.ProviderSchema.safeParse({ displayName: "z", baseUrl: "https://api.example.com/api", credential: { sources: [{ env: "TOKEN" }] } }).success).toBe(true);
    expect(library.ProviderSchema.safeParse({ displayName: "z" }).success).toBe(false);
    expect(library.CategoryMapSchema.parse({ all: true })).toEqual({ history: true, knowledge: true, settings: true });
  });

  it("creates, reads and lists identities and profiles under a state root it is given, and refuses a duplicate with a typed error", () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-library-"));
    try {
      const paths = library.buildLayoutPaths(root);
      expect(library.addIdentity(paths, "work").name).toBe("work");
      expect(library.readIdentity(paths, "work")?.name).toBe("work");
      expect(library.listIdentities(paths).map((entry) => entry.name)).toEqual(["work"]);
      expect(() => library.addIdentity(paths, "work")).toThrow(library.IdentityAlreadyExistsError);
      library.createProfile(paths, "base");
      expect(library.listProfiles(paths).map((entry) => entry.name)).toEqual(["base"]);
      expect(() => library.readPools(paths)).not.toThrow();
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("raises typed errors a caller can tell from a crash", () => {
    const error = new library.UsageError("bad input");
    expect(error).toBeInstanceOf(library.CliError);
    expect(error.exitCode).toBe(library.EXIT_USAGE);
  });

  it("runs the ambient-credential guard in process", () => {
    expect(library.detectAmbientCredential({ ANTHROPIC_API_KEY: "set" })).toEqual({ variable: "ANTHROPIC_API_KEY" });
    expect(library.detectAmbientCredential({})).toBeUndefined();
  });

  it("reads a usage snapshot through an injected filesystem and validates it with the exported schema", () => {
    const snapshot = {
      schemaVersion: 1,
      identity: "work",
      updatedAt: "2026-10-02T10:00:00.000Z",
      providers: { anthropic: { lastRequestAt: "2026-10-02T10:00:00.000Z", lastStatus: 200 } },
    };
    const fs = { readFileUtf8: (file: string): string | undefined => (file === library.snapshotPath("/snapshots", "work") ? JSON.stringify(snapshot) : undefined) };
    expect(library.readUsageSnapshot(fs, "/snapshots", "work")).toEqual(snapshot);
    expect(library.readUsageSnapshot(fs, "/snapshots", "other")).toBeUndefined();
    expect(library.UsageSnapshotSchema.safeParse({ ...snapshot, extra: true }).success).toBe(false);
  });
});

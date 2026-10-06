import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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

  it("reads a window past its reset as empty, exactly as pool ranking and the launch warnings do", () => {
    const nowMs = Date.parse("2026-10-05T12:00:00.000Z");
    expect(library.effectiveWindow({ utilization: 1, status: "rejected", resetsAt: "2026-10-05T11:00:00.000Z" }, nowMs)).toEqual({ reset: true, utilization: 0 });
    expect(library.effectiveWindow({ utilization: 0.5, resetsAt: "2026-10-05T13:00:00.000Z" }, nowMs)).toMatchObject({ reset: false, utilization: 0.5 });
  });

  it("evaluates a rule's `when` with the semantics the cascade uses", () => {
    const context = { nowMs: 0, env: { CI: "1" }, branch: "main", branchDetached: false } satisfies library.ConditionContext;
    expect(library.evaluateWhen({ branch: "main" }, context)).toEqual({ passed: true, checked: ["branch"], failed: [] });
    expect(library.evaluateWhen({ branch: "release/*" }, context)).toMatchObject({ passed: false, failed: ["branch"] });
    expect(library.matchBranch("feat/*", "feat/x")).toBe(true);
  });

  it("ranks a pool over snapshots and a clock, and its report validates against the published schema", () => {
    const nowMs = Date.parse("2026-10-05T12:00:00.000Z");
    const at = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString();
    const HOUR_MS = 3_600_000;
    const SIX_DAYS_MS = 518_400_000;
    const LIGHTLY_USED = 0.1;
    const HEAVILY_USED = 0.6;
    const snapshot = (identity: string, utilization: number, resetsInMs: number): library.UsageSnapshot => ({
      schemaVersion: 1,
      identity,
      updatedAt: at(-HOUR_MS),
      providers: { anthropic: { lastRequestAt: at(-HOUR_MS), lastStatus: 200, rateLimit: { observedAt: at(-HOUR_MS), headers: {}, unified: { sevenDay: { utilization, resetsAt: at(resetsInMs) } } } } },
    });
    const ranking = library.rankPool({
      nowMs,
      resuming: false,
      members: [
        { identity: "later", records: [], snapshot: snapshot("later", LIGHTLY_USED, SIX_DAYS_MS), account: { organizationRateLimitTier: "default_claude_max_20x" } },
        { identity: "sooner", records: [], snapshot: snapshot("sooner", HEAVILY_USED, HOUR_MS), account: { organizationRateLimitTier: "default_claude_max_20x" } },
      ],
    });
    expect(ranking.pick?.identity).toBe("sooner");
    expect(library.planOf({ organizationRateLimitTier: "default_claude_max_5x" })).toMatchObject({ kind: "subscription", capacity: 5 });
    const report: library.PoolPickReport = { pool: "p", directory: "/d", pick: "sooner", candidates: ranking.candidates.map((c) => ({ identity: c.identity, class: c.class, feasible: c.feasible, plan: c.plan, reasons: [...c.reasons] })), missing: [] };
    expect(library.PoolPickReportSchema.parse(report)).toEqual(report);
    expect(library.PoolPickReportSchema.safeParse({ ...report, extra: true }).success).toBe(false);
  });

  it("exposes exactly the documented entry points, so adding or removing one is a deliberate change to this list and to docs/library.md", () => {
    expect(Object.keys(library).sort()).toEqual([
      "AMBIENT_CREDENTIAL_VARS",
      "CHECK_CREDENTIAL_APPLIES",
      "CONNECT_INTERCEPT_HOST",
      "CONNECT_INTERCEPT_HOSTS",
      "CONNECT_LIMITS",
      "CONTROL_PATH_PREFIX",
      "CategoryClassificationOverlaySchema",
      "CategoryClassificationSchema",
      "CategoryMapSchema",
      "CheckReportJsonSchema",
      "CheckRunInputSchema",
      "CliError",
      "ConfigProfileSchema",
      "CredentialCacheSchema",
      "CredentialSchema",
      "CredentialSourceSchema",
      "DOOR_EVENT_BUFFER_EVENTS",
      "DOOR_EVENT_SOURCE_RC",
      "DirectoryRuleAlreadyExistsError",
      "DirectoryRuleMissingTargetError",
      "DirectoryRuleNotFoundError",
      "DirectoryRuleSchema",
      "DirectoryRulesSchema",
      "DoctorFindingSchema",
      "DoctorRunOutputSchema",
      "DoorEventSchema",
      "DoorEventSourceQuerySchema",
      "EXIT_FAILURE",
      "EXIT_USAGE",
      "EffectiveWindowSchema",
      "EntryValueSchema",
      "FARM_MANIFEST_FILENAME",
      "FrontDoorSessionStatusSchema",
      "FrontDoorSessionsOutputSchema",
      "FrontDoorStartError",
      "FrontDoorStateSchema",
      "FrontDoorStatusOutputSchema",
      "GlobalConfigSchema",
      "HeadroomSocketTargetSchema",
      "HeadroomStartError",
      "IdentityAlreadyExistsError",
      "IdentityNotFoundError",
      "IdentitySchema",
      "InvalidCategoryNameError",
      "InvalidIdentityNameError",
      "InvalidProviderNameError",
      "LAUNCH_EVENT_SOURCE",
      "LaunchLifecycleEventSchema",
      "LaunchRefusedError",
      "LegacyProviderFileError",
      "PROMPT_CACHE_TTL_MS",
      "PlanClassSchema",
      "PoolNameSchema",
      "PoolNotFoundError",
      "PoolPickReportSchema",
      "PoolSchema",
      "PortableConfigSchema",
      "ProfileAlreadyExistsError",
      "ProfileNotFoundError",
      "ProviderAlreadyExistsError",
      "ProviderKindMismatchError",
      "ProviderNotFoundError",
      "ProviderSchema",
      "RC_CONTEXT_USAGE_DETAILS",
      "RC_IDLE_EXPIRY_MS",
      "RC_ORPC_PATH_PREFIX",
      "RC_PENDING_DEADLINE_MS",
      "RC_PERMISSION_MODES",
      "RC_READ_FILE_ENCODINGS",
      "RC_REQUEST_PARSE_CAP_BYTES",
      "RC_SELF_HOST_ENV",
      "RC_SELF_HOST_KEEPALIVE_MS",
      "RC_SELF_HOST_RECORD_DIR",
      "RC_SELF_HOST_RECORD_FILE",
      "RC_SELF_HOST_RETENTION_MS",
      "RC_SELF_HOST_SCOPE_LIST",
      "RC_SELF_HOST_WORKER_JWT_TTL_SECONDS",
      "RC_SESSIONS_PATH_PREFIX",
      "RC_STREAM_BACKOFF_MS",
      "RC_WEB_FETCH_ALLOW_PRIVATE_ENV",
      "RC_WEB_FETCH_DEADLINE_MS",
      "RC_WEB_FETCH_MAX_BYTES",
      "RC_WEB_FETCH_MAX_REDIRECTS",
      "ROUTED_PATH_PREFIX",
      "RcLiveRateLimitSchema",
      "RcPermissionModeSchema",
      "RcRateLimitInfoSchema",
      "RcRateLimitWindowSchema",
      "RcStreamEnvelopeSchema",
      "RcStreamEventSchema",
      "UsageError",
      "UsageListOutputSchema",
      "UsageLiveOutputSchema",
      "UsageSnapshotError",
      "UsageSnapshotSchema",
      "UsageWindowsInputSchema",
      "UsageWindowsOutputSchema",
      "WhenSchema",
      "addDirectoryRule",
      "addIdentity",
      "addPool",
      "addProvider",
      "answerRcControlRequest",
      "authenticateRcSessionMcpServer",
      "buildEntryFacts",
      "buildLayoutPaths",
      "buildRcControlRequestPayload",
      "buildRcControlResponsePayload",
      "buildRcEndSessionPayload",
      "buildRcEventWriteBody",
      "buildRcFileSuggestionsPayload",
      "buildRcGetContextUsagePayload",
      "buildRcGetUsagePayload",
      "buildRcInterruptPayload",
      "buildRcKeepAlivePayload",
      "buildRcMarkReadBody",
      "buildRcMcpAuthenticatePayload",
      "buildRcMcpOAuthCallbackUrlPayload",
      "buildRcMcpReconnectPayload",
      "buildRcMcpStatusPayload",
      "buildRcReadFilePayload",
      "buildRcSetModelPayload",
      "buildRcSetPermissionModePayload",
      "buildRcUserMessagePayload",
      "carryOver",
      "checkReportHasWarnings",
      "checkReportToJson",
      "collectCheckReport",
      "collectDoctorReport",
      "collectFrontDoorStatus",
      "collectPoolPick",
      "createControlApiRouter",
      "createDoorApiNodeHandler",
      "createDoorApiRouter",
      "createDoorEventHub",
      "createEventsApiRouter",
      "createLaunchEventPublisher",
      "createLeafCache",
      "createProfile",
      "createRcApiNodeHandler",
      "createRcApiRouter",
      "createRcControlHandler",
      "createRcCredentialStore",
      "createRcEventFanout",
      "createRcLiveUsage",
      "createRcSelfHostSurface",
      "createRcSessionTracker",
      "createRcStreamHub",
      "createSseParser",
      "describeProviderEndpoint",
      "detectAmbientCredential",
      "doorApiAuth",
      "doorApiNodeHandlerOf",
      "effectiveWindow",
      "endRcSession",
      "ensureCa",
      "ensureFrontDoor",
      "ensureHeadroom",
      "evaluateAmbientCredentialGuard",
      "evaluateWhen",
      "fetchThroughWebProxy",
      "formatAmbientCredentialGuardMessage",
      "formatCheckReport",
      "formatDoctorReport",
      "formatFrontDoorStatus",
      "forwardableHeaders",
      "frontDoorApiClient",
      "frontDoorApiLink",
      "frontDoorRcApiClient",
      "frontDoorRcControl",
      "generateCa",
      "getRcSessionContextUsage",
      "getRcSessionMcpStatus",
      "getRcSessionUsage",
      "headroomSocketTarget",
      "identityExists",
      "injectRcUserMessage",
      "interruptRcSession",
      "isIdentityDirectoryName",
      "isInterceptedHost",
      "isPrivateAddress",
      "isRcContextUsageDetail",
      "isRcPermissionMode",
      "isRcReadFileEncoding",
      "lateRcEventDial",
      "lateRcStreamDial",
      "listDirectoryRules",
      "listIdentities",
      "listProfiles",
      "listProviders",
      "listUsageSnapshots",
      "matchBranch",
      "mintLeaf",
      "mintRcSelfHostCredential",
      "observingRoutedRoute",
      "parseConnectTarget",
      "parseRcStreamEnvelope",
      "planOf",
      "prepareClaudeLaunch",
      "prepareLaunch",
      "profileExists",
      "providerExists",
      "rankPool",
      "rcEventWriteResultFromAnswer",
      "rcFanoutOnDoorHub",
      "rcObserverAsPassthrough",
      "rcRateLimitInfoOf",
      "rcSelfHostFromEnv",
      "rcWebFetchAllowsPrivateFromEnv",
      "readActiveIdentity",
      "readDirectoryRules",
      "readFarmManifest",
      "readGlobalConfig",
      "readIdentity",
      "readPools",
      "readProfile",
      "readProvider",
      "readRcSelfHostRecord",
      "readRcSessionFile",
      "readUsageSnapshot",
      "realConnectCertStore",
      "realConnectEffects",
      "realRcControlTransport",
      "realRcEventDial",
      "realRcStreamDial",
      "realRcWebFetch",
      "reconnectRcSessionMcpServer",
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
      "runCheck",
      "runDoctor",
      "runFrontDoorSupervisor",
      "runLauncher",
      "runSupervisor",
      "sendRcKeepAlive",
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
      "setRcSessionModel",
      "setRcSessionPermissionMode",
      "snapshotPath",
      "spawnClaude",
      "startConnectServer",
      "submitRcSessionMcpOAuthCallbackUrl",
      "suggestRcSessionFiles",
      "teleportRcSession",
      "topLevelNames",
      "updateDirectoryRule",
      "updateProvider",
      "useIdentity",
      "writeDirectoryRules",
    ]);
  });

  it("exposes nothing that exists for the command line alone", () => {
    const names = Object.keys(library);
    for (const cliOnly of ["buildProgram", "registerCheckCommand", "registerDoctorCommand", "reportFatalError"]) {
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

  it("audits a state root and reports on a directory, returning data a caller can read without the command line", () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-library-"));
    const claudeHome = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    try {
      const paths = library.buildLayoutPaths(root);
      library.addIdentity(paths, "work");
      const doctor = library.collectDoctorReport({ paths, env: {} });
      expect(doctor.findings.some((finding) => finding.section === "identity" && finding.severity === "pass")).toBe(true);
      expect(library.formatDoctorReport(doctor).length).toBeGreaterThan(0);
      const check = library.collectCheckReport({ paths, cwd: root, identity: "work", env: {} });
      expect(check.identityName).toBe("work");
      expect(library.checkReportToJson(check)).toHaveProperty("identity.name", "work");
    } finally {
      vi.unstubAllEnvs();
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("refuses a launch for an identity that does not exist with a typed error carrying the launcher's own message, rather than exiting", () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-library-"));
    const claudeHome = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    try {
      const attempt = (): void => {
        library.prepareClaudeLaunch({ argv: ["@nobody"], cwd: root, env: {}, paths: library.buildLayoutPaths(root) });
      };
      expect(attempt).toThrow(library.LaunchRefusedError);
      expect(attempt).toThrow(/nobody/);
    } finally {
      vi.unstubAllEnvs();
      nodeFs.rmSync(root, { recursive: true, force: true });
      nodeFs.rmSync(claudeHome, { recursive: true, force: true });
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

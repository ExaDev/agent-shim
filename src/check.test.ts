import { describe, expect, it } from "vitest";

import type { Credential } from "./config/schema";
import type { Decision } from "./resolve/types";
import { shippedClassification, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, createFakeFarmFs } from "./test-helpers";
import {
  checkReportHasWarnings,
  checkReportToJson,
  flagAmbiguousEncodings,
  formatCheckReport,
  formatDecision,
  inspectSettingsExposure,
  lookupKeychainService,
  runCheck,
  type RunCheckParams,
} from "./check";
import type { RunPort } from "./launcher/ports";
import type { CascadeInput } from "./resolve/walk";
import type { FlattenedCascade } from "./resolve/types";
import { makeFacts } from "./test-helpers";

/** A cascade with no configured layers at all — everything falls back to the shipped classification/category defaults. */
function emptyCascade(overrides: Partial<CascadeInput> = {}): CascadeInput {
  return {
    home: FAKE_HOME,
    loadProfile: () => undefined,
    ...overrides,
  };
}

function baseParams(overrides: Partial<RunCheckParams> = {}): RunCheckParams {
  return {
    cwd: `${FAKE_HOME}/work`,
    home: FAKE_HOME,
    claudeHome: FAKE_CLAUDE_HOME,
    env: {},
    nowMs: FAKE_NOW_MS,
    farmFs: createFakeFarmFs(),
    cascade: emptyCascade(),
    classification: { defaults: shippedClassification },
    identitySource: "none",
    configProfileSource: "none",
    settingsFiles: {},
    platform: "linux",
    ...overrides,
  };
}

describe("runCheck", () => {
  it("resolves every entry present under the canonical claude home, using the shipped defaults with no configured layers", () => {
    const farmFs = createFakeFarmFs({
      [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "content",
      [`${FAKE_CLAUDE_HOME}/.credentials.json`]: "secret",
      [`${FAKE_CLAUDE_HOME}/projects/-Users-testuser-work`]: { dir: true },
    });

    const report = runCheck(baseParams({ farmFs }));

    const byPath = new Map(report.resolved.decisions);
    expect(byPath.get("skills")?.shared).toBe(true);
    expect(byPath.get(".credentials.json")?.shared).toBe(false);
    expect(byPath.get(".credentials.json")?.via).toBe("secret-floor");
    expect(byPath.get("projects")?.shared).toBe(true);
  });

  it("never touches the farm and never spawns anything — it only reads via the injected FarmFs", () => {
    const farmFs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills`]: { dir: true } });
    runCheck(baseParams({ farmFs }));
    // buildEntryFacts only calls lstat/readdir, which this fake never records as writes.
    expect(farmFs.writes).toEqual([]);
  });

  it("reports the ambient-credential guard result", () => {
    const withVar = runCheck(baseParams({ env: { ANTHROPIC_API_KEY: "sk-real-secret-value" } }));
    expect(withVar.ambientCredential.ok).toBe(false);
    if (!withVar.ambientCredential.ok) {
      expect(withVar.ambientCredential.message).toContain("ANTHROPIC_API_KEY");
      // The advisory must never leak the actual secret value into its output.
      expect(withVar.ambientCredential.message).not.toContain("sk-real-secret-value");
    }

    const withEmptyVar = runCheck(baseParams({ env: { ANTHROPIC_API_KEY: "" } }));
    expect(withEmptyVar.ambientCredential.ok).toBe(true);

    const withoutVar = runCheck(baseParams());
    expect(withoutVar.ambientCredential.ok).toBe(true);
  });

  it("respects an identity's own allowAmbientCredential opt-in", () => {
    const report = runCheck(
      baseParams({
        env: { ANTHROPIC_API_KEY: "sk-real-secret-value" },
        identity: { name: "work", allowAmbientCredential: true },
        identityName: "work",
      }),
    );
    expect(report.ambientCredential.ok).toBe(true);
  });

  it("flags a history/projects/ entries pattern whose encoding is lossy", () => {
    const cascade = emptyCascade({
      baseConfigProfile: "base",
      loadProfile: (name) =>
        name === "base"
          ? {
              name: "base",
              profile: { entries: { "history/projects/~/work/clients.acme": true } },
            }
          : undefined,
    });

    const report = runCheck(baseParams({ cascade }));
    expect(report.projectEncodingAmbiguities).toHaveLength(1);
    expect(report.projectEncodingAmbiguities[0]?.reason).toBe("lossy-characters");
    expect(report.projectEncodingAmbiguities[0]?.fragment).toBe("~/work/clients.acme");
  });

  it("reports nothing for a plain, unambiguous history/projects/ pattern", () => {
    const cascade = emptyCascade({
      baseConfigProfile: "base",
      loadProfile: (name) =>
        name === "base" ? { name: "base", profile: { entries: { "history/projects/~/work/clients/*": true } } } : undefined,
    });

    const report = runCheck(baseParams({ cascade }));
    expect(report.projectEncodingAmbiguities).toEqual([]);
  });

  it("runs the Keychain diagnostic only on darwin, with both a run port and a farm root available", () => {
    const fakeRun: RunPort = {
      run: () => ({ status: 0, stdout: "", stderr: '    "svce"<blob>="Claude Code-credentials-abc123"\n' }),
    };

    const onLinux = runCheck(baseParams({ platform: "linux", run: fakeRun, farmRoot: "/farm/work" }));
    expect(onLinux.keychain).toBeUndefined();

    const onDarwinNoRoot = runCheck(baseParams({ platform: "darwin", run: fakeRun }));
    expect(onDarwinNoRoot.keychain).toBeUndefined();

    const onDarwin = runCheck(baseParams({ platform: "darwin", run: fakeRun, farmRoot: "/farm/work" }));
    expect(onDarwin.keychain?.serviceName).toBe("Claude Code-credentials-abc123");
  });

  it("reports the settings-secrets advisory only when the settings category resolves shared and a file has real content", () => {
    const settingsFiles = {
      "settings.json": JSON.stringify({
        env: { REAL_SECRET_TOKEN: "sk-should-never-appear-in-output" },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }, { type: "command", command: "echo bye" }] }] },
      }),
    };

    const shared = runCheck(baseParams({ settingsFiles }));
    expect(shared.settingsExposure).toHaveLength(1);
    expect(shared.settingsExposure[0]).toEqual({
      file: "settings.json",
      envKeyNames: ["REAL_SECRET_TOKEN"],
      hookEventNames: ["PreToolUse"],
      hookCommandCount: 2,
    });

    const cascadeClosingSettings = emptyCascade({
      baseConfigProfile: "base",
      loadProfile: (name) => (name === "base" ? { name: "base", profile: { categories: { settings: false } } } : undefined),
    });
    const closed = runCheck(baseParams({ settingsFiles, cascade: cascadeClosingSettings }));
    expect(closed.settingsExposure).toEqual([]);
  });

  it("never includes a secret value anywhere in the formatted report", () => {
    const settingsFiles = {
      "settings.json": JSON.stringify({ env: { MY_TOKEN: "sk-should-never-appear-in-output" } }),
    };
    const report = runCheck(baseParams({ settingsFiles, env: { ANTHROPIC_API_KEY: "sk-also-should-never-appear" } }));
    const rendered = formatCheckReport(report).join("\n");
    expect(rendered).not.toContain("sk-should-never-appear-in-output");
    expect(rendered).not.toContain("sk-also-should-never-appear");
    expect(rendered).toContain("MY_TOKEN");
  });
});

describe("inspectSettingsExposure", () => {
  it("returns nothing when the settings category is not shared", () => {
    expect(
      inspectSettingsExposure({ settingsShared: false, files: { "settings.json": JSON.stringify({ env: { X: "y" } }) } }),
    ).toEqual([]);
  });

  it("returns nothing for a file with empty env and hooks", () => {
    expect(inspectSettingsExposure({ settingsShared: true, files: { "settings.json": JSON.stringify({}) } })).toEqual([]);
  });

  it("returns nothing for a missing file", () => {
    expect(inspectSettingsExposure({ settingsShared: true, files: { "settings.json": undefined } })).toEqual([]);
  });

  it("ignores unparseable JSON rather than throwing", () => {
    expect(inspectSettingsExposure({ settingsShared: true, files: { "settings.json": "{not json" } })).toEqual([]);
  });

  it("counts hook commands across multiple matcher groups and events", () => {
    const raw = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "a" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "b" }, { type: "command", command: "c" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "d" }] }],
      },
    });
    const result = inspectSettingsExposure({ settingsShared: true, files: { "settings.json": raw } });
    expect(result).toEqual([
      { file: "settings.json", envKeyNames: [], hookEventNames: ["PreToolUse", "Stop"], hookCommandCount: 4 },
    ]);
  });
});

describe("lookupKeychainService", () => {
  it("parses the service name out of security's stderr attribute dump", () => {
    const run: RunPort = {
      run: (command, args) => {
        expect(command).toBe("security");
        expect(args).toContain("find-generic-password");
        return { status: 0, stdout: "", stderr: '    "svce"<blob>="Claude Code-credentials-deadbeef"\n' };
      },
    };
    const result = lookupKeychainService(run, "/farm/work");
    expect(result).toEqual({
      checked: true,
      found: true,
      serviceName: "Claude Code-credentials-deadbeef",
      note: 'Keychain service name for this identity: "Claude Code-credentials-deadbeef".',
    });
  });

  it("reports no entry found when security exits non-zero", () => {
    const run: RunPort = { run: () => ({ status: 44, stdout: "", stderr: "" }) };
    const result = lookupKeychainService(run, "/farm/work");
    expect(result.found).toBe(false);
    expect(result.serviceName).toBeUndefined();
  });

  it("reports a found-but-unparseable entry distinctly from not-found", () => {
    const run: RunPort = { run: () => ({ status: 0, stdout: "", stderr: "something unexpected" }) };
    const result = lookupKeychainService(run, "/farm/work");
    expect(result.found).toBe(true);
    expect(result.serviceName).toBeUndefined();
  });
});

describe("flagAmbiguousEncodings", () => {
  const facts = makeFacts({ "projects/-home-testuser-work-clients-acme": { dir: true } });

  it("reports how many real project directories a lossy pattern currently matches", () => {
    const flattened: FlattenedCascade = {
      categories: new Map(),
      launch: {},
      diagnostics: [],
      rules: new Map([
        [
          "projects/-home-testuser-work-clients-acme",
          {
            rawKey: "history/projects/~/work/clients.acme",
            declaredCategory: "history",
            canonicalPattern: "projects/-home-testuser-work-clients-acme",
            value: true,
            layer: 0,
            ordinal: 0,
            isExact: true,
            literalPrefix: "projects/-home-testuser-work-clients-acme",
            segmentCount: 2,
            matches: () => true,
          },
        ],
      ]),
    };
    const ambiguities = flagAmbiguousEncodings(flattened, facts);
    expect(ambiguities).toHaveLength(1);
    expect(ambiguities[0]?.detail).toContain("1 existing project directory");
  });

  it("returns nothing when no rule targets history/projects/", () => {
    const flattened: FlattenedCascade = { categories: new Map(), launch: {}, diagnostics: [], rules: new Map() };
    expect(flagAmbiguousEncodings(flattened, facts)).toEqual([]);
  });
});

describe("formatDecision", () => {
  it("names the secret floor distinctly from an ordinary category default", () => {
    const secretDecision: Decision = { relPath: ".credentials.json", shared: false, via: "secret-floor", category: "secret" };
    expect(formatDecision(secretDecision)).toContain("never shared, cannot be overridden");

    const defaultDecision: Decision = { relPath: "skills", shared: true, via: "category-default", category: "knowledge" };
    expect(formatDecision(defaultDecision)).toContain("shipped default");
  });

  it("notes eliminated candidates when a more specific rule's when-condition failed", () => {
    const decision: Decision = {
      relPath: "history/projects/foo",
      shared: false,
      via: "category-default",
      category: "history",
      eliminated: [
        {
          rule: {
            rawKey: "history/projects/*",
            declaredCategory: "history",
            canonicalPattern: "projects/*",
            value: true,
            layer: 0,
            ordinal: 0,
            isExact: false,
            literalPrefix: "projects/",
            segmentCount: 2,
            matches: () => true,
          },
          failed: ["newerThan"],
        },
      ],
    };
    expect(formatDecision(decision)).toContain("1 more specific rule(s) eliminated");
  });
});

describe("checkReportToJson", () => {
  it("renders every decision, the layers and the diagnostics as plain JSON-safe data", () => {
    const farmFs = createFakeFarmFs({
      [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "content",
      [`${FAKE_CLAUDE_HOME}/.credentials.json`]: "secret",
    });
    const report = runCheck(baseParams({ farmFs, identityName: "work", identitySource: "argv" }));

    const json: unknown = JSON.parse(JSON.stringify(checkReportToJson(report)));
    expect(json).toMatchObject({
      identity: { name: "work", source: "argv" },
      configProfile: { name: null, source: "none" },
      ambientCredential: { ok: true },
    });
    const entries = typeof json === "object" && json !== null && "entries" in json ? json.entries : undefined;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".credentials.json", shared: false, via: "secret-floor", category: "secret" }),
        expect.objectContaining({ path: "skills", shared: true }),
      ]),
    );
  });

  it("names a refusing ambient credential's variable, never its value", () => {
    const report = runCheck(baseParams({ env: { ANTHROPIC_API_KEY: "sk-real-secret-value" } }));
    const text = JSON.stringify(checkReportToJson(report));
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).not.toContain("sk-real-secret-value");
  });
});

describe("checkReportHasWarnings", () => {
  it("is false for a clean report", () => {
    expect(checkReportHasWarnings(runCheck(baseParams()))).toBe(false);
  });

  it("is true for an ambient credential a launch would refuse", () => {
    expect(checkReportHasWarnings(runCheck(baseParams({ env: { ANTHROPIC_API_KEY: "sk-x" } })))).toBe(true);
  });

  it("is true for an ambiguous history/projects/ encoding", () => {
    const cascade = emptyCascade({
      baseConfigProfile: "base",
      loadProfile: (name) =>
        name === "base" ? { name: "base", profile: { entries: { "history/projects/~/work/clients.acme": true } } } : undefined,
    });
    expect(checkReportHasWarnings(runCheck(baseParams({ cascade })))).toBe(true);
  });
});

describe("runCheck credential report", () => {
  const workCredential: Credential = { sources: [{ op: "op://vault/claude-work/token" }], target: "oauthToken" };

  it("reports the stored login when neither a provider nor an identity credential applies", () => {
    const report = runCheck(baseParams({ identityName: "work", identity: { name: "work", allowAmbientCredential: false } }));
    expect(report.credential).toEqual({ applies: "stored-login" });
    expect(formatCheckReport(report)).toContain("  The identity's stored login (no credential block applies).");
  });

  it("reports the identity's credential by source kind and target when no provider is selected", () => {
    const report = runCheck(baseParams({ identityName: "work", identity: { name: "work", allowAmbientCredential: false, credential: workCredential } }));
    expect(report.credential).toEqual({
      applies: "identity",
      identity: { target: "oauthToken", sources: [{ kind: "op", reference: "op://vault/claude-work/token" }] },
    });
    expect(formatCheckReport(report)).toContain("  Identity work: oauthToken from op op://vault/claude-work/token");
  });

  it("reports a selected provider's credential as the one that applies, and never a literal value", () => {
    const report = runCheck(
      baseParams({
        identityName: "work",
        identity: { name: "work", allowAmbientCredential: false, credential: workCredential },
        provider: { name: "codex", definition: { displayName: "Codex", baseUrl: "http://127.0.0.1:18789", credential: { sources: [{ literal: "placeholder-value" }] } } },
      }),
    );
    expect(report.credential.applies).toBe("provider");
    const text = formatCheckReport(report).join("\n");
    expect(text).toContain("  Provider codex: bearer from literal (non-secret placeholder)");
    expect(text).toContain("(not used: the provider's credential applies)");
    expect(text + JSON.stringify(checkReportToJson(report))).not.toContain("placeholder-value");
    expect(checkReportHasWarnings(report)).toBe(false);
  });

  it("reports a selected provider that cannot be used, and counts it as a warning for --strict", () => {
    const report = runCheck(baseParams({ provider: { name: "z", problem: 'no provider named "z"' } }));
    expect(report.credential).toEqual({ applies: "provider", provider: { name: "z", problem: 'no provider named "z"' } });
    expect(formatCheckReport(report)).toContain('  Provider z: unusable: no provider named "z"');
    expect(checkReportHasWarnings(report)).toBe(true);
  });
});

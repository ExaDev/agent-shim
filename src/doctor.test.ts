import { describe, expect, it } from "vitest";

import {
  formatDoctorReport,
  refinePathShadow,
  runDoctor,
  type DoctorConfigProfileInput,
  type DoctorIdentityInput,
  type DoctorProviderInput,
  type RunDoctorParams,
} from "./doctor";
import type { RunPort } from "./launcher/ports";

const DISCOVERED_BINARY = { ok: true, binary: { path: "/opt/claude/2.1.0", source: "versions-dir", version: "2.1.0" } } as const;

const ALIVE_SUPERVISOR_PID = 11;
const ALIVE_DAEMON_PID = 12;
const REPLACEMENT_SUPERVISOR_PID = 21;
const REPLACEMENT_DAEMON_PID = 22;
const HEADROOM_PORT = 8123;

function baseParams(overrides: Partial<RunDoctorParams> = {}): RunDoctorParams {
  return {
    env: {},
    identities: [],
    configProfiles: [],
    providers: [],
    directoryRules: { path: "/claude-use/directory-rules.json", raw: undefined },
    globalConfig: { path: "/claude-use/config.json", raw: undefined },
    categoriesLocal: { path: "/claude-use/categories.local.json", raw: undefined },
    activeIdentity: { path: "/claude-use/active-identity", raw: undefined },
    binaryDiscovery: DISCOVERED_BINARY,
    claudeShim: { state: undefined, targetExists: false },
    pathResolution: { ownExecutablePath: "/home/u/.local/bin/claude-use", claudeUse: { status: "ok" } },
    platform: "linux",
    headroom: { state: { path: "/claude-use/headroom/state.json", raw: undefined }, isRunning: () => false },
    ...overrides,
  };
}

function identity(name: string, overrides: Partial<DoctorIdentityInput> = {}): DoctorIdentityInput {
  return {
    name,
    path: `/claude-use/identities/${name}/identity.json`,
    raw: JSON.stringify({ name, allowAmbientCredential: false }),
    farmRoot: `/claude-use/identities/${name}`,
    ...overrides,
  };
}

function profile(name: string, body: Record<string, unknown> = {}, overrides: Partial<DoctorConfigProfileInput> = {}): DoctorConfigProfileInput {
  return {
    name,
    path: `/claude-use/config-profiles/${name}.json`,
    raw: JSON.stringify(body),
    ...overrides,
  };
}

function findingsFor(report: ReturnType<typeof runDoctor>, section: string) {
  return report.findings.filter((finding) => finding.section === section);
}

describe("runDoctor: headroom", () => {
  it("passes with a note when the daemon has never run", () => {
    const report = runDoctor(baseParams());
    const findings = findingsFor(report, "headroom");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("pass");
    expect(findings[0]?.message).toContain("ever run");
  });

  it("fails on a malformed state.json instead of guessing", () => {
    const report = runDoctor(baseParams({ headroom: { state: { path: "/claude-use/headroom/state.json", raw: "{bad" }, isRunning: () => false } }));
    expect(findingsFor(report, "headroom").some((finding) => finding.severity === "fail")).toBe(true);
  });

  it("passes when supervisor and daemon pids are both alive", () => {
    const alive = new Set([ALIVE_SUPERVISOR_PID, ALIVE_DAEMON_PID]);
    const report = runDoctor(
      baseParams({
        headroom: {
          state: { path: "/claude-use/headroom/state.json", raw: JSON.stringify({ supervisorPid: ALIVE_SUPERVISOR_PID, headroomPid: ALIVE_DAEMON_PID, port: HEADROOM_PORT, version: "headroom 0.39.1" }) },
          isRunning: (pid: number) => alive.has(pid),
        },
      }),
    );
    const findings = findingsFor(report, "headroom");
    expect(findings.every((finding) => finding.severity === "pass")).toBe(true);
    expect(findings[0]?.message).toContain(`127.0.0.1:${String(HEADROOM_PORT)}`);
  });

  it("warns, without failing the report, when the recorded supervisor is no longer running", () => {
    const report = runDoctor(
      baseParams({
        headroom: {
          state: { path: "/claude-use/headroom/state.json", raw: JSON.stringify({ supervisorPid: ALIVE_SUPERVISOR_PID, headroomPid: ALIVE_DAEMON_PID, port: HEADROOM_PORT }) },
          isRunning: () => false,
        },
      }),
    );
    const findings = findingsFor(report, "headroom");
    expect(findings.some((finding) => finding.severity === "warn")).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("warns about a recorded lastError even while a replacement supervisor runs", () => {
    const alive = new Set([REPLACEMENT_SUPERVISOR_PID, REPLACEMENT_DAEMON_PID]);
    const report = runDoctor(
      baseParams({
        headroom: {
          state: {
            path: "/claude-use/headroom/state.json",
            raw: JSON.stringify({ supervisorPid: REPLACEMENT_SUPERVISOR_PID, headroomPid: REPLACEMENT_DAEMON_PID, port: HEADROOM_PORT, lastError: "previous crash" }),
          },
          isRunning: (pid: number) => alive.has(pid),
        },
      }),
    );
    expect(findingsFor(report, "headroom").some((finding) => finding.severity === "warn" && finding.message.includes("previous crash"))).toBe(true);
  });

  it("warns when the installed headroom source follows a git branch that can move", () => {
    const alive = new Set([ALIVE_SUPERVISOR_PID, ALIVE_DAEMON_PID]);
    const stateFor = (installedSource: string) =>
      baseParams({
        headroom: {
          state: {
            path: "/claude-use/headroom/state.json",
            raw: JSON.stringify({ supervisorPid: ALIVE_SUPERVISOR_PID, headroomPid: ALIVE_DAEMON_PID, port: HEADROOM_PORT, installedSource }),
          },
          isRunning: (pid: number) => alive.has(pid),
          caCert: { path: "/claude-use/headroom/ca/ca.pem", exists: true },
        },
      });
    const moving = findingsFor(runDoctor(stateFor("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@feat/branch")), "headroom");
    expect(moving.some((finding) => finding.severity === "warn" && finding.message.includes("can move"))).toBe(true);
    const pinned = findingsFor(runDoctor(stateFor("headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@eb02fa4126450c9905a49394fdec19ae2e7c9c30")), "headroom");
    expect(pinned.some((finding) => finding.message.includes("can move"))).toBe(false);
  });
});

describe("runDoctor: ambient-credential", () => {
  it("passes when no ambient-credential variable is set", () => {
    const report = runDoctor(baseParams({ env: {} }));
    expect(findingsFor(report, "ambient-credential")).toEqual([
      { section: "ambient-credential", severity: "pass", message: "No ambient-credential environment variable is set." },
    ]);
  });

  it("warns, never fails, when one is set, without leaking its value", () => {
    const report = runDoctor(baseParams({ env: { ANTHROPIC_API_KEY: "sk-super-secret-value" } }));
    const [finding] = findingsFor(report, "ambient-credential");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("ANTHROPIC_API_KEY");
    expect(finding?.message).not.toContain("sk-super-secret-value");
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor: binary-discovery", () => {
  it("passes with path/source/version when discovery succeeded", () => {
    const report = runDoctor(baseParams());
    const [finding] = findingsFor(report, "binary-discovery");
    expect(finding?.severity).toBe("pass");
    expect(finding?.message).toContain("/opt/claude/2.1.0");
    expect(finding?.message).toContain("versions-dir");
    expect(finding?.message).toContain("2.1.0");
  });

  it("fails with the given message when discovery failed", () => {
    const report = runDoctor(baseParams({ binaryDiscovery: { ok: false, message: "no claude binary found anywhere" } }));
    expect(findingsFor(report, "binary-discovery")).toEqual([
      { section: "binary-discovery", severity: "fail", message: "no claude binary found anywhere" },
    ]);
    expect(report.ok).toBe(false);
  });
});

describe("runDoctor: claude-shim", () => {
  it("passes when no shim is enabled (the default)", () => {
    const report = runDoctor(baseParams());
    const [finding] = findingsFor(report, "claude-shim");
    expect(finding?.severity).toBe("pass");
    expect(finding?.message).toContain("shim enable");
  });

  it("passes when enabled and the target still exists", () => {
    const state = { targetPath: "/usr/local/bin/claude", method: "hardlink" as const, installedAtMs: 0 };
    const report = runDoctor(baseParams({ claudeShim: { state, targetExists: true } }));
    const [finding] = findingsFor(report, "claude-shim");
    expect(finding?.severity).toBe("pass");
    expect(finding?.message).toContain("/usr/local/bin/claude");
  });

  it("warns, not fails, when the marker is stale (target no longer exists)", () => {
    const state = { targetPath: "/usr/local/bin/claude", method: "copy" as const, installedAtMs: 0 };
    const report = runDoctor(baseParams({ claudeShim: { state, targetExists: false } }));
    const [finding] = findingsFor(report, "claude-shim");
    expect(finding?.severity).toBe("warn");
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor: path-resolution", () => {
  it("passes when a bare `claude-use` reaches this running executable", () => {
    const report = runDoctor(baseParams());
    const [finding] = findingsFor(report, "path-resolution");
    expect(finding?.severity).toBe("pass");
    expect(finding?.message).toContain("/home/u/.local/bin/claude-use");
    expect(report.ok).toBe(true);
  });

  it("fails when an earlier PATH entry shadows the running executable, naming both and how to fix it", () => {
    const report = runDoctor(
      baseParams({
        pathResolution: {
          ownExecutablePath: "/home/u/.local/bin/claude-use",
          claudeUse: { status: "shadowed", by: "/home/u/.dotfiles/bin/claude-use" },
        },
      }),
    );
    const [finding] = findingsFor(report, "path-resolution");
    expect(finding?.severity).toBe("fail");
    expect(finding?.message).toContain("/home/u/.dotfiles/bin/claude-use");
    expect(finding?.message).toContain("/home/u/.local/bin/claude-use");
    expect(finding?.message).toContain("/home/u/.local/bin ahead of it on PATH");
    expect(report.ok).toBe(false);
  });

  it("warns, not fails, when the running executable's own directory is not on PATH at all", () => {
    const report = runDoctor(
      baseParams({
        pathResolution: { ownExecutablePath: "/tmp/npx-cache/claude-use", claudeUse: { status: "not-on-path" } },
      }),
    );
    const [finding] = findingsFor(report, "path-resolution");
    expect(finding?.severity).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("reports nothing about `claude` when no shim is enabled, since a `claude` on PATH is then Claude Code's own binary", () => {
    const report = runDoctor(baseParams());
    expect(findingsFor(report, "path-resolution").map((finding) => finding.subject)).toEqual(["claude-use"]);
  });

  it("warns, not fails, when an enabled `claude` shim is shadowed — the launcher is still reachable as `claude-use run`", () => {
    const report = runDoctor(
      baseParams({
        pathResolution: {
          ownExecutablePath: "/home/u/.local/bin/claude-use",
          claudeUse: { status: "ok" },
          claude: { status: "shadowed", by: "/opt/homebrew/bin/claude" },
        },
      }),
    );
    const claudeFinding = findingsFor(report, "path-resolution").find((finding) => finding.subject === "claude");
    expect(claudeFinding?.severity).toBe("warn");
    expect(claudeFinding?.message).toContain("/opt/homebrew/bin/claude");
    expect(report.ok).toBe(true);
  });
});

describe("refinePathShadow", () => {
  it("leaves a genuine shadow alone", () => {
    const status = refinePathShadow({ status: "shadowed", by: "/a/claude-use" }, "/b/claude-use", (target) => target);
    expect(status).toEqual({ status: "shadowed", by: "/a/claude-use" });
  });

  it("collapses to ok when both names resolve to the same real file", () => {
    const realpaths: Record<string, string> = { "/a/claude-use": "/real/claude-use", "/b/claude-use": "/real/claude-use" };
    const status = refinePathShadow(
      { status: "shadowed", by: "/a/claude-use" },
      "/b/claude-use",
      (target) => realpaths[target] ?? target,
    );
    expect(status).toEqual({ status: "ok" });
  });

  it("passes through every non-shadowed status untouched", () => {
    const realpath = (target: string): string => target;
    expect(refinePathShadow({ status: "ok" }, "/b/claude-use", realpath)).toEqual({ status: "ok" });
    expect(refinePathShadow({ status: "not-on-path" }, "/b/claude-use", realpath)).toEqual({ status: "not-on-path" });
  });
});

describe("runDoctor: identity", () => {
  it("fails when identity.json is missing", () => {
    const report = runDoctor(baseParams({ identities: [identity("work", { raw: undefined })] }));
    const [finding] = findingsFor(report, "identity");
    expect(finding?.severity).toBe("fail");
    expect(finding?.message).toContain("is missing");
  });

  it("fails on invalid JSON", () => {
    const report = runDoctor(baseParams({ identities: [identity("work", { raw: "{not json" })] }));
    expect(findingsFor(report, "identity")[0]?.severity).toBe("fail");
  });

  it("fails on a schema violation, with the issue in the message", () => {
    const report = runDoctor(
      baseParams({ identities: [identity("work", { raw: JSON.stringify({ name: "has spaces", allowAmbientCredential: false }) })] }),
    );
    const [finding] = findingsFor(report, "identity");
    expect(finding?.severity).toBe("fail");
    expect(finding?.message).toContain("name");
  });

  it("fails when defaultConfigProfile names a profile that does not exist", () => {
    const report = runDoctor(
      baseParams({
        identities: [identity("work", { raw: JSON.stringify({ name: "work", allowAmbientCredential: false, defaultConfigProfile: "ghost" }) })],
      }),
    );
    const [finding] = findingsFor(report, "identity");
    expect(finding?.severity).toBe("fail");
    expect(finding?.message).toContain("ghost");
  });

  it("passes when defaultConfigProfile names a real profile", () => {
    const report = runDoctor(
      baseParams({
        identities: [identity("work", { raw: JSON.stringify({ name: "work", allowAmbientCredential: false, defaultConfigProfile: "base" }) })],
        configProfiles: [profile("base")],
      }),
    );
    const identityFindings = findingsFor(report, "identity");
    expect(identityFindings).toEqual([
      { section: "identity", subject: "work", severity: "pass", message: "work is valid and authenticates with its stored login." },
    ]);
  });

  it("names an identity's credential by source kind and target when it has one", () => {
    const report = runDoctor(
      baseParams({
        identities: [
          identity("work", {
            raw: JSON.stringify({ name: "work", credential: { sources: [{ op: "op://vault/claude-work/token" }], target: "oauthToken" } }),
          }),
        ],
      }),
    );
    expect(findingsFor(report, "identity")[0]?.message).toBe(
      "work is valid and authenticates with credential oauthToken from op op://vault/claude-work/token.",
    );
  });
});

function provider(name: string, body: unknown): DoctorProviderInput {
  return { name, path: `/claude-use/providers/${name}.json`, raw: JSON.stringify(body) };
}

describe("runDoctor: provider", () => {
  it("passes a current-format provider, describing its credential without any value", () => {
    const report = runDoctor(
      baseParams({ providers: [provider("codex", { displayName: "Codex", baseUrl: "http://127.0.0.1:18789", credential: { sources: [{ literal: "placeholder-value" }] } })] }),
    );
    const findings = findingsFor(report, "provider");
    expect(findings).toEqual([
      { section: "provider", subject: "codex", severity: "pass", message: "codex is valid (http://127.0.0.1:18789, credential bearer from literal (non-secret placeholder))." },
    ]);
    expect(report.ok).toBe(true);
  });

  it("fails an old-format provider with the old fields named and the whole replacement, never the fixed token's value", () => {
    const report = runDoctor(
      baseParams({
        providers: [
          provider("codex", {
            displayName: "Codex",
            baseUrl: "http://127.0.0.1:18789",
            env: { ANTHROPIC_AUTH_TOKEN: "fixed-proxy-value", ANTHROPIC_API_KEY: "", API_TIMEOUT_MS: "600000" },
          }),
          provider("z", { displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" }),
        ],
      }),
    );
    const [codex, z] = findingsFor(report, "provider");
    expect(report.ok).toBe(false);
    expect(codex?.severity).toBe("fail");
    expect(codex?.message).toContain("uses env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY, which a credential block replaced");
    expect(codex?.message).toContain('"literal": "<the value of env.ANTHROPIC_AUTH_TOKEN>"');
    expect(codex?.message).toContain('"API_TIMEOUT_MS": "600000"');
    expect(codex?.message).not.toContain("fixed-proxy-value");
    expect(z?.severity).toBe("fail");
    const replacement: unknown = JSON.parse(z?.message.slice(z.message.indexOf("{")) ?? "");
    expect(replacement).toEqual({ displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } });
  });

  it("fails an invalid provider with its validation errors, and invalid JSON", () => {
    const report = runDoctor(
      baseParams({
        providers: [provider("x", { displayName: "x", baseUrl: "https://a.example" }), { name: "y", path: "/claude-use/providers/y.json", raw: "{bad" }],
      }),
    );
    const findings = findingsFor(report, "provider");
    expect(findings.map((finding) => finding.severity)).toEqual(["fail", "fail"]);
    expect(findings[0]?.message).toContain("credential");
    expect(findings[1]?.message).toContain("not valid JSON");
  });
});

describe("runDoctor: config-profile extends chain", () => {
  it("flags a genuine two-profile cycle for both profiles", () => {
    const report = runDoctor(
      baseParams({
        configProfiles: [profile("a", { extends: ["b"] }), profile("b", { extends: ["a"] })],
      }),
    );
    const failures = findingsFor(report, "config-profile").filter((finding) => finding.severity === "fail");
    expect(failures.map((finding) => finding.subject).sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual(["a", "b"]);
    expect(failures.every((finding) => finding.message.includes("Circular"))).toBe(true);
  });

  it("flags an extends reference to a profile with no file at all", () => {
    const report = runDoctor(baseParams({ configProfiles: [profile("a", { extends: ["ghost"] })] }));
    const [finding] = findingsFor(report, "config-profile").filter((f) => f.severity === "fail");
    expect(finding?.message).toContain("ghost");
  });

  it("does not flag a genuine diamond as a cycle", () => {
    const report = runDoctor(
      baseParams({
        configProfiles: [
          profile("base"),
          profile("a", { extends: ["base"] }),
          profile("b", { extends: ["base"] }),
          profile("c", { extends: ["a", "b"] }),
        ],
      }),
    );
    expect(findingsFor(report, "config-profile").some((finding) => finding.severity === "fail")).toBe(false);
  });

  it("fails a profile with a schema violation", () => {
    const report = runDoctor(baseParams({ configProfiles: [profile("bad", { categories: { secret: true } })] }));
    const [finding] = findingsFor(report, "config-profile");
    expect(finding?.severity).toBe("fail");
  });
});

describe("runDoctor: keychain", () => {
  const fakeRun: RunPort = { run: () => ({ status: 0, stdout: "", stderr: '    "svce"<blob>="Claude Code-credentials-abc"\n' }) };

  it("is entirely skipped when run is omitted", () => {
    const report = runDoctor(baseParams({ identities: [identity("work")], platform: "darwin" }));
    expect(findingsFor(report, "keychain")).toEqual([{ section: "keychain", severity: "pass", message: "Skipped (not macOS)." }]);
  });

  it("is entirely skipped when platform is not darwin", () => {
    const report = runDoctor(baseParams({ identities: [identity("work")], run: fakeRun, platform: "linux" }));
    expect(findingsFor(report, "keychain")).toEqual([{ section: "keychain", severity: "pass", message: "Skipped (not macOS)." }]);
  });

  it("passes when found, warns (not fails) when not found, per identity", () => {
    const notFoundRun: RunPort = { run: () => ({ status: 44, stdout: "", stderr: "" }) };
    const foundReport = runDoctor(baseParams({ identities: [identity("work")], run: fakeRun, platform: "darwin" }));
    const notFoundReport = runDoctor(baseParams({ identities: [identity("work")], run: notFoundRun, platform: "darwin" }));
    expect(findingsFor(foundReport, "keychain")[0]?.severity).toBe("pass");
    expect(findingsFor(notFoundReport, "keychain")[0]?.severity).toBe("warn");
    expect(notFoundReport.ok).toBe(true);
  });
});

describe("runDoctor: directory-rules", () => {
  it("passes when not configured", () => {
    const report = runDoctor(baseParams());
    expect(findingsFor(report, "directory-rules")).toEqual([
      { section: "directory-rules", severity: "pass", message: "No directory-rules.json configured." },
    ]);
  });

  it("fails on a schema violation", () => {
    const report = runDoctor(baseParams({ directoryRules: { path: "/x/directory-rules.json", raw: "{not json" } }));
    expect(findingsFor(report, "directory-rules")[0]?.severity).toBe("fail");
  });

  it("fails a rule naming a nonexistent identity", () => {
    const report = runDoctor(
      baseParams({
        directoryRules: {
          path: "/x/directory-rules.json",
          raw: JSON.stringify({ rules: [{ path: "/work", identity: "ghost" }] }),
        },
      }),
    );
    const ruleFindings = findingsFor(report, "directory-rules").filter((finding) => finding.subject === "/work");
    expect(ruleFindings).toHaveLength(1);
    expect(ruleFindings[0]?.severity).toBe("fail");
    expect(ruleFindings[0]?.message).toContain("ghost");
  });

  it("fails a rule naming a nonexistent config profile", () => {
    const report = runDoctor(
      baseParams({
        directoryRules: {
          path: "/x/directory-rules.json",
          raw: JSON.stringify({ rules: [{ path: "/work", configProfile: "ghost" }] }),
        },
      }),
    );
    const ruleFindings = findingsFor(report, "directory-rules").filter((finding) => finding.subject === "/work");
    expect(ruleFindings[0]?.severity).toBe("fail");
    expect(ruleFindings[0]?.message).toContain("ghost");
  });

  it("passes a rule whose references all exist", () => {
    const report = runDoctor(
      baseParams({
        identities: [identity("work")],
        configProfiles: [profile("base")],
        directoryRules: {
          path: "/x/directory-rules.json",
          raw: JSON.stringify({ rules: [{ path: "/work", identity: "work", configProfile: "base" }] }),
        },
      }),
    );
    const ruleFindings = findingsFor(report, "directory-rules").filter((finding) => finding.subject === "/work");
    expect(ruleFindings).toEqual([{ section: "directory-rules", subject: "/work", severity: "pass", message: 'Rule for "/work" is valid.' }]);
  });
});

describe("runDoctor: global-config", () => {
  it("passes when not configured", () => {
    const report = runDoctor(baseParams());
    expect(findingsFor(report, "global-config")).toEqual([
      { section: "global-config", severity: "pass", message: "No config.json configured." },
    ]);
  });

  it("fails on a schema violation", () => {
    const report = runDoctor(baseParams({ globalConfig: { path: "/x/config.json", raw: "{not json" } }));
    expect(findingsFor(report, "global-config")[0]?.severity).toBe("fail");
  });

  it("fails when defaultConfigProfile references nothing", () => {
    const report = runDoctor(
      baseParams({ globalConfig: { path: "/x/config.json", raw: JSON.stringify({ defaultConfigProfile: "ghost" }) } }),
    );
    const [finding] = findingsFor(report, "global-config");
    expect(finding?.severity).toBe("fail");
    expect(finding?.message).toContain("ghost");
  });
});

describe("runDoctor: categories.local.json", () => {
  it("passes when not configured", () => {
    const report = runDoctor(baseParams());
    expect(findingsFor(report, "categories-local")).toEqual([
      { section: "categories-local", severity: "pass", message: "No categories.local.json configured." },
    ]);
  });

  it("fails on a schema violation", () => {
    const report = runDoctor(baseParams({ categoriesLocal: { path: "/x/categories.local.json", raw: JSON.stringify({ secret: "not an array" }) } }));
    expect(findingsFor(report, "categories-local")[0]?.severity).toBe("fail");
  });
});

describe("runDoctor: active-identity", () => {
  it("passes when unset", () => {
    const report = runDoctor(baseParams());
    expect(findingsFor(report, "active-identity")).toEqual([
      { section: "active-identity", severity: "pass", message: "No active identity set." },
    ]);
  });

  it("warns, not fails, when present but whitespace-only", () => {
    const report = runDoctor(baseParams({ activeIdentity: { path: "/x/active-identity", raw: "  \n" } }));
    const [finding] = findingsFor(report, "active-identity");
    expect(finding?.severity).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("fails when naming a nonexistent identity", () => {
    const report = runDoctor(baseParams({ activeIdentity: { path: "/x/active-identity", raw: "ghost\n" } }));
    expect(findingsFor(report, "active-identity")[0]?.severity).toBe("fail");
  });

  it("passes when naming a real identity", () => {
    const report = runDoctor(baseParams({ identities: [identity("work")], activeIdentity: { path: "/x/active-identity", raw: "work\n" } }));
    expect(findingsFor(report, "active-identity")).toEqual([
      { section: "active-identity", severity: "pass", message: 'Active identity "work" is valid.' },
    ]);
  });
});

describe("runDoctor: aggregation contract", () => {
  it("returns a full report with one fail per broken input, rather than throwing, when everything is malformed at once", () => {
    const params = baseParams({
      identities: [identity("work", { raw: "{not json" })],
      configProfiles: [profile("bad", { categories: { secret: true } })],
      directoryRules: { path: "/x/directory-rules.json", raw: "{not json" },
      globalConfig: { path: "/x/config.json", raw: "{not json" },
      categoriesLocal: { path: "/x/categories.local.json", raw: "{not json" },
      activeIdentity: { path: "/x/active-identity", raw: "ghost\n" },
      binaryDiscovery: { ok: false, message: "not found" },
    });

    // A genuine throw here fails the test on its own -- no separate not.toThrow() wrapper needed, which also avoids report ever being possibly-undefined below.
    const report = runDoctor(params);

    expect(report.ok).toBe(false);
    expect(findingsFor(report, "identity")[0]?.severity).toBe("fail");
    expect(findingsFor(report, "config-profile")[0]?.severity).toBe("fail");
    expect(findingsFor(report, "directory-rules")[0]?.severity).toBe("fail");
    expect(findingsFor(report, "global-config")[0]?.severity).toBe("fail");
    expect(findingsFor(report, "categories-local")[0]?.severity).toBe("fail");
    expect(findingsFor(report, "active-identity")[0]?.severity).toBe("fail");
    expect(findingsFor(report, "binary-discovery")[0]?.severity).toBe("fail");
  });

  it("is ok=false iff at least one finding is fail, regardless of any number of warn findings", () => {
    const onlyWarn = runDoctor(baseParams({ env: { ANTHROPIC_API_KEY: "x" }, activeIdentity: { path: "/x", raw: "   " } }));
    expect(onlyWarn.findings.some((finding) => finding.severity === "warn")).toBe(true);
    expect(onlyWarn.findings.some((finding) => finding.severity === "fail")).toBe(false);
    expect(onlyWarn.ok).toBe(true);
  });
});

describe("formatDoctorReport", () => {
  it("prefixes each line with the right severity marker and ends with a passing summary", () => {
    const report = runDoctor(baseParams());
    const lines = formatDoctorReport(report);
    expect(lines.some((line) => line.includes("[PASS]"))).toBe(true);
    expect(lines.at(-1)).toBe("All checks passed.");
  });

  it("ends with a failure-count summary when the report has failures", () => {
    const report = runDoctor(baseParams({ binaryDiscovery: { ok: false, message: "not found" } }));
    const lines = formatDoctorReport(report);
    expect(lines.some((line) => line.includes("[FAIL]"))).toBe(true);
    expect(lines.at(-1)).toBe("1 check(s) failed.");
  });
});

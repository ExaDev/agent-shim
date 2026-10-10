import type { DoctorIdentityInput, RunDoctorParams, runDoctor } from "./doctorReport";

const DISCOVERED_BINARY = { ok: true, binary: { path: "/opt/claude/2.1.0", source: "versions-dir", version: "2.1.0" } } as const;

/** A `RunDoctorParams` describing a clean, empty installation on Linux, for a test to override only what it exercises. */
export function baseParams(overrides: Partial<RunDoctorParams> = {}): RunDoctorParams {
  return {
    env: {},
    identities: [],
    configProfiles: [],
    providers: [],
    directoryRules: { path: "/agent-shim/directory-rules.json", raw: undefined },
    globalConfig: { path: "/agent-shim/config.json", raw: undefined },
    categoriesLocal: { path: "/agent-shim/categories.local.json", raw: undefined },
    activeIdentity: { path: "/agent-shim/active-identity", raw: undefined },
    binaryDiscovery: DISCOVERED_BINARY,
    claudeShim: { state: undefined, targetExists: false },
    rootPath: "/home/u/.agent-shim",
    pathResolution: { ownExecutablePath: "/home/u/.local/bin/agent-shim", agentShim: { status: "ok" } },
    platform: "linux",
    headroom: { state: { path: "/agent-shim/headroom/state.v2.json", raw: undefined }, isRunning: () => false },
    ...overrides,
  };
}

/** One identity input with a valid `identity.json` and a stored login, for a test to override. */
export function identity(name: string, overrides: Partial<DoctorIdentityInput> = {}): DoctorIdentityInput {
  return {
    name,
    path: `/agent-shim/identities/${name}/identity.json`,
    raw: JSON.stringify({ name, allowAmbientCredential: false }),
    farmRoot: `/agent-shim/identities/${name}`,
    credentialsFilePresent: true,
    ...overrides,
  };
}

/** The findings of one section of a report. */
export function findingsFor(report: ReturnType<typeof runDoctor>, section: string) {
  return report.findings.filter((finding) => finding.section === section);
}

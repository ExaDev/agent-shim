import { describe, expect, it, vi } from "vitest";

import type { Pool } from "./config/schema";
import { catalogueCredentialFingerprint } from "./codex/catalogueCredential";
import { prepareLaunch, resolveLaunch, type PrepareLaunchParams } from "./launcher";
import { catalogueBindingPath, catalogueCachePath } from "./providerCatalogue";
import { FAKE_NOW_MS, createFakeFarmFs, discovered, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

const HOUR_MS = 3_600_000;
const SIX_DAYS_MS = 518_400_000;
const FRONTDOOR_PORT = 4100;
const RECORDED_DOOR_PID = 123;
const SERVING_DOOR_PID = 500;
const TEST_GENERATION = "10000000-0000-4000-8000-000000000001";
const U10 = 0.1;
const U60 = 0.6;
const MAX_20X = "default_claude_max_20x";
/** A made-up value in the shape of an OAuth token, so a leak into any output is findable without a real credential existing anywhere. */
const TOKEN_SHAPED = "sk-ant-REDACTED";

const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

function snapshotOf(identity: string, utilization: number, resetsInMs: number): string {
  const seen = iso(-HOUR_MS);
  return JSON.stringify({
    schemaVersion: 1,
    identity,
    updatedAt: seen,
    account: { organizationRateLimitTier: MAX_20X },
    providers: { anthropic: { lastRequestAt: seen, lastStatus: 200, rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization, resetsAt: iso(resetsInMs), status: "allowed" } } } } },
  });
}

/** `work` expires its quota tonight and `personal` has plenty but a week away, so the pool picks `work`. */
const SEED = { [snapshotPath("work")]: snapshotOf("work", U60, HOUR_MS), [snapshotPath("personal")]: snapshotOf("personal", U10, SIX_DAYS_MS) };
const POOLS: Readonly<Record<string, Pool>> = { main: { identities: ["work", "personal"] } };

/** `work` carries a credential block whose sources would each run something or hold a value if resolved. */
const CREDENTIALED = { [`${paths.identitiesDir}/work/identity.json`]: { name: "work", credential: { target: "oauthToken", sources: [{ command: ["op", "read", "op://vault/item/token"] }, { literal: TOKEN_SHAPED }] } } };

function ports(options: { readonly argv: readonly string[]; readonly env?: Record<string, string>; readonly files?: Record<string, unknown>; readonly cliOverride?: Parameters<typeof fakeFarm>[1] }) {
  const farmFs = createFakeFarmFs(SEED);
  const log = fakeLog();
  const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
  const credentials = fakeCredentials();
  const params: PrepareLaunchParams = {
    paths,
    fs: fakeFs({ ...(options.env?.CODEX_HOME === undefined ? {} : { [`${paths.frontdoorDir}/codex-homes/500.json`]: JSON.stringify({ codexHome: options.env.CODEX_HOME, generation: TEST_GENERATION }) }), ...options.files }),
    proc: fakeProc(options.env ?? {}, options.argv),
    log,
    resolveClaudeBinary: () => discovered,
    farm: fakeFarm(farmFs, options.cliOverride),
    frontdoor,
    credentials,
    pools: POOLS,
  };
  return { params, farmFs, log, frontdoor, credentials };
}

describe("resolveLaunch", () => {
  it("uses the successor catalogue when the door changes during readiness", () => {
    const successor = SERVING_DOOR_PID + 1;
    const home = "/successor/codex";
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [`${paths.frontdoorDir}/codex-homes/${String(successor)}.json`]: JSON.stringify({ codexHome: home, generation: TEST_GENERATION }),
      [catalogueCachePath(paths, "codex", successor, TEST_GENERATION)]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "successor-model" }], credentialFingerprint: fingerprint, supervisorPid: successor }),
      [`${home}/auth.json`]: JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }),
    };
    const { params } = ports({ argv: ["@work", "--headroom", "--print"], files });
    let changed = false;
    const read = params.fs.readFileUtf8;
    const fs = { ...params.fs, readFileUtf8: (file: string) => file === paths.frontdoorStateFile && changed ? JSON.stringify({ supervisorPid: successor, port: FRONTDOOR_PORT }) : read(file) };
    const frontdoor = { ...fakeFrontDoorPort(), waitForCatalogues: () => { changed = true; return "The front door changed while waiting for provider catalogues"; } };
    const prepared = prepareLaunch({ ...params, fs, frontdoor, headroom: { ensure: () => ({ socketPath: "/s", projectId: "p" }), release: () => undefined } });
    expect(JSON.stringify(prepared.args)).toContain("successor-model");
  });
  it("reports a catalogue readiness warning without refusing the launch", () => {
    const { params, log } = ports({ argv: ["@work", "--headroom", "--print"] });
    const frontdoor = { ...fakeFrontDoorPort(), waitForCatalogues: () => "catalogue timed out" };
    prepareLaunch({ ...params, frontdoor, headroom: { ensure: () => ({ socketPath: "/s", projectId: "p" }), release: () => undefined } });
    expect(log.warns).toContain("catalogue timed out");
  });
  it("includes a Codex catalogue fetched as the front door starts", () => {
    const home = "/door/codex";
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    const cachePath = catalogueCachePath(paths, "codex", SERVING_DOOR_PID, TEST_GENERATION);
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [`${paths.frontdoorDir}/codex-homes/500.json`]: JSON.stringify({ codexHome: home, generation: TEST_GENERATION }),
      [cachePath]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "fresh-model" }], credentialFingerprint: fingerprint, supervisorPid: SERVING_DOOR_PID }),
      [`${home}/auth.json`]: JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }),
    };
    const { params } = ports({ argv: ["@work", "--headroom", "--print"], files });
    let ready = false;
    const read = params.fs.readFileUtf8;
    const fs = { ...params.fs, readFileUtf8: (file: string) => file === cachePath && !ready ? undefined : read(file) };
    const frontdoor = { ...fakeFrontDoorPort(), waitForCatalogues: () => { ready = true; return undefined; } };
    const prepared = prepareLaunch({ ...params, fs, frontdoor, headroom: { ensure: () => ({ socketPath: "/s", projectId: "p" }), release: () => undefined } });
    expect(JSON.stringify(prepared.args)).toContain("fresh-model");
  });

  it.each([RECORDED_DOOR_PID - 1, undefined])("does not show a Codex catalogue with non-current supervisor %s", (owner) => {
    const home = "/door/codex";
    const fingerprint = catalogueCredentialFingerprint(true, "token", "workspace");
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [paths.frontdoorStateFile]: JSON.stringify({ supervisorPid: RECORDED_DOOR_PID, port: 456 }),
      [`${paths.frontdoorDir}/codex-homes/123.json`]: JSON.stringify({ codexHome: home, generation: TEST_GENERATION }),
      [catalogueCachePath(paths, "codex", RECORDED_DOOR_PID, TEST_GENERATION)]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "old-door-model" }], credentialFingerprint: fingerprint, supervisorPid: owner }),
      [catalogueBindingPath(paths, "codex", RECORDED_DOOR_PID, TEST_GENERATION)]: JSON.stringify({ fingerprint, source: `${home}/auth.json`, revision: "current" }),
      [`${home}/auth.json.revision`]: "current",
      [`${home}/auth.json`]: JSON.stringify({ tokens: { access_token: "token", account_id: "workspace" } }),
    };
    const { params } = ports({ argv: ["@work", "--print"], env: { CODEX_HOME: home }, files });
    expect(JSON.stringify(resolveLaunch(params).args)).not.toContain("old-door-model");
  });

  it("uses the launcher's account when the recorded front door has exited", () => {
    const home = "/launcher/codex";
    const fingerprint = catalogueCredentialFingerprint(true, "local-token", "workspace");
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [paths.frontdoorStateFile]: JSON.stringify({ supervisorPid: 123, port: 456 }),
      [`${paths.catalogueDir}/codex.json`]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "local-model" }], credentialFingerprint: fingerprint }),
      [`${paths.catalogueDir}/codex.binding.json`]: JSON.stringify({ fingerprint, source: `${home}/auth.json`, revision: "current" }),
      [`${home}/auth.json.revision`]: "current",
    };
    const { params } = ports({ argv: ["@work", "--print"], env: { CODEX_HOME: home }, files });
    expect(JSON.stringify(resolveLaunch({ ...params, proc: { ...params.proc, isProcessAlive: () => false } }).args)).toContain("local-model");
  });

  it("uses the front door returned by ensure when it replaces the recorded door", () => {
    const newHome = "/new-door/codex";
    const fingerprint = catalogueCredentialFingerprint(true, "new-token", "workspace");
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [paths.frontdoorStateFile]: JSON.stringify({ supervisorPid: 123, port: 456 }),
      [`${paths.frontdoorDir}/codex-homes/123.json`]: JSON.stringify({ codexHome: "/old-door/codex", generation: TEST_GENERATION }),
      [`${paths.frontdoorDir}/codex-homes/500.json`]: JSON.stringify({ codexHome: newHome, generation: TEST_GENERATION }),
      [`${paths.catalogueDir}/supervisors/500/${TEST_GENERATION}/codex.json`]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "new-door-model" }], credentialFingerprint: fingerprint, supervisorPid: 500 }),
      [`${paths.catalogueDir}/supervisors/500/${TEST_GENERATION}/codex.binding.json`]: JSON.stringify({ fingerprint, source: `${newHome}/auth.json`, revision: "current" }),
      [`${newHome}/auth.json.revision`]: "current",
      [`${newHome}/auth.json`]: JSON.stringify({ tokens: { access_token: "new-token", account_id: "workspace" } }),
    };
    const { params } = ports({ argv: ["@work", "--headroom", "--print"], files });
    const prepared = prepareLaunch({ ...params, headroom: { ensure: () => ({ socketPath: "/s", projectId: "p" }), release: () => undefined } });
    expect(JSON.stringify(prepared.args)).toContain("new-door-model");
  });

  it("uses the serving front door's Codex account for the model picker", () => {
    const doorHome = "/door/codex";
    const generation = "10000000-0000-4000-8000-000000000001";
    const fingerprint = catalogueCredentialFingerprint(true, "door-token", "workspace");
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [paths.frontdoorStateFile]: JSON.stringify({ supervisorPid: 500, port: 456 }),
      [`${paths.frontdoorDir}/codex-homes/123.json`]: JSON.stringify({ codexHome: doorHome, generation: TEST_GENERATION }),
      [`${paths.frontdoorDir}/codex-homes/500.json`]: JSON.stringify({ codexHome: doorHome, generation }),
      [catalogueCachePath(paths, "codex", SERVING_DOOR_PID, generation)]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "door-model" }], credentialFingerprint: fingerprint, supervisorPid: SERVING_DOOR_PID }),
      [catalogueBindingPath(paths, "codex", SERVING_DOOR_PID, generation)]: JSON.stringify({ fingerprint, source: `${doorHome}/auth.json`, revision: "current" }),
      [`${doorHome}/auth.json.revision`]: "current",
      [`${doorHome}/auth.json`]: JSON.stringify({ tokens: { access_token: "door-token", account_id: "workspace" } }),
    };
    const options = { argv: ["@work", "--print"], env: { CODEX_HOME: "/launcher/codex" }, files };
    expect(JSON.stringify(resolveLaunch(ports(options).params).args)).toContain("door-model");
    expect(JSON.stringify(prepareLaunch(ports(options).params).args)).toContain("door-model");
  });

  it("reports the same Codex picker arguments as a real launch", () => {
    const codexHome = "/home/testuser/.codex";
    const files = {
      [paths.frontdoorStateFile]: JSON.stringify({ supervisorPid: 500, port: 456 }),
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [`${paths.catalogueDir}/supervisors/500/${TEST_GENERATION}/codex.json`]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "gpt-test" }], credentialFingerprint: catalogueCredentialFingerprint(true, "fake-access", "workspace"), supervisorPid: 500 }),
      [`${paths.catalogueDir}/supervisors/500/${TEST_GENERATION}/codex.binding.json`]: JSON.stringify({ fingerprint: catalogueCredentialFingerprint(true, "fake-access", "workspace"), source: `${codexHome}/auth.json`, revision: "current" }),
      [`${codexHome}/auth.json.revision`]: "current",
      [`${codexHome}/auth.json`]: JSON.stringify({ tokens: { access_token: "fake-access", account_id: "workspace" } }),
    };
    const options = { argv: ["@work", "--print"], env: { CODEX_HOME: codexHome }, files };
    expect(resolveLaunch(ports(options).params).args).toEqual(prepareLaunch(ports(options).params).args);
  });

  it("does not report another Codex account's cached models in read-only resolution", () => {
    const codexHome = "/home/testuser/.codex";
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [`${paths.catalogueDir}/codex.json`]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "stale-model" }], credentialFingerprint: catalogueCredentialFingerprint(true, "previous-account", "workspace") }),
      [`${paths.catalogueDir}/codex.binding.json`]: JSON.stringify({ fingerprint: catalogueCredentialFingerprint(true, "current-account", "workspace"), source: `${codexHome}/auth.json`, revision: "current" }),
      [`${codexHome}/auth.json.revision`]: "current",
      [`${codexHome}/auth.json`]: JSON.stringify({ tokens: { access_token: "current-account", account_id: "workspace" } }),
    };
    const options = { argv: ["@work", "--print"], env: { CODEX_HOME: codexHome }, files };
    expect(resolveLaunch(ports(options).params).args).toEqual(prepareLaunch(ports(options).params).args);
  });

  it("does not report an unbound Codex catalogue in read-only resolution", () => {
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [`${paths.catalogueDir}/codex.json`]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "unbound-model" }] }),
    };
    const resolved = resolveLaunch(ports({ argv: ["@work", "--print"], files }).params);
    expect(JSON.stringify(resolved.args)).not.toContain("unbound-model");
  });

  it("does not trust a binding left behind when the Codex account changes", () => {
    const codexHome = "/home/testuser/.codex";
    const previousBinding = catalogueCredentialFingerprint(true, "previous-account", "workspace");
    const files = {
      [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } },
      [`${paths.catalogueDir}/codex.json`]: JSON.stringify({ fetchedAt: 1, url: "https://example.test", models: [{ id: "stale-model" }], credentialFingerprint: previousBinding }),
      [`${paths.catalogueDir}/codex.binding.json`]: JSON.stringify({ fingerprint: previousBinding, source: `${codexHome}/auth.json`, revision: "previous" }),
      [`${codexHome}/auth.json.revision`]: "current",
      [`${codexHome}/auth.json`]: JSON.stringify({ tokens: { access_token: "current-account", account_id: "workspace" } }),
    };
    const options = { argv: ["@work", "--print"], env: { CODEX_HOME: codexHome }, files };
    expect(resolveLaunch(ports(options).params).args).toEqual(prepareLaunch(ports(options).params).args);
  });


  it("does not read the Codex login while resolving a launch", () => {
    const codexHome = "/home/testuser/.codex";
    const { params } = ports({ argv: ["@work", "--print"], env: { CODEX_HOME: codexHome }, files: { [`${paths.providersDir}/codex.json`]: { kind: "codex", displayName: "Codex", credential: { sources: [{ env: "CODEX_TOKEN" }] } } } });
    const read = vi.spyOn(params.fs, "readFileUtf8");
    resolveLaunch(params);
    expect(read).not.toHaveBeenCalledWith(`${codexHome}/auth.json`);
  });

  it("reports the decision a real launch of the same inputs makes", () => {
    const resolved = resolveLaunch(ports({ argv: ["@pool:main", "--headroom", "--print"] }).params);
    const prepared = prepareLaunch({ ...ports({ argv: ["@pool:main", "--headroom", "--print"] }).params, headroom: { ensure: () => ({ socketPath: "/s", projectId: "p" }), release: () => undefined } });
    expect(resolved.decision).toEqual(prepared.decision);
    expect(resolved.decision).toMatchObject({ identity: "work", identitySource: "argv", pool: { name: "main" } });
    expect(resolved.flags).toMatchObject({ headroom: true });
    expect(resolved.args).toEqual(prepared.args);
    expect(resolved.bin).toBe(discovered.path);
    expect(resolved.routing).toEqual({ frontDoor: true, headroom: true });
  });

  it("writes nothing: no farm resync, no recorded pool pick", () => {
    const { params, farmFs } = ports({ argv: ["@pool:main", "--print"] });
    resolveLaunch(params);
    expect(farmFs.writes).toEqual([]);
    // The same launch performed does write, so the empty list above is a measurement and not a fake that cannot record.
    const performed = ports({ argv: ["@pool:main", "--print"] });
    prepareLaunch(performed.params);
    expect(performed.farmFs.writes.length).toBeGreaterThan(0);
  });

  it("starts no daemon and registers no session", () => {
    const { params, frontdoor } = ports({ argv: ["@work", "--headroom", "--track-usage", "--print"] });
    const resolved = resolveLaunch(params);
    expect(resolved.routing.frontDoor).toBe(true);
    expect(frontdoor.ensures()).toBe(0);
    expect(frontdoor.releases()).toBe(0);
  });

  it("reports the identity's credential by its block and runs and reads none of it", () => {
    const { params, credentials } = ports({ argv: ["@work", "--print"], files: CREDENTIALED });
    const resolved = resolveLaunch(params);
    expect(resolved.credential).toMatchObject({ subject: "identity", name: "work", summary: { target: "oauthToken", sources: [{ kind: "command", program: "op" }, { kind: "literal" }] } });
    expect(credentials.runCommand).not.toHaveBeenCalled();
    expect(credentials.readSecretFile).not.toHaveBeenCalled();
    expect(JSON.stringify(resolved)).not.toContain(TOKEN_SHAPED);
    expect(resolved.environment).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("names the environment variables a launch sets and never their values", () => {
    const resolved = resolveLaunch(ports({ argv: ["@work", "--track-usage", "--print"] }).params);
    expect(resolved.environment).toEqual(expect.arrayContaining(["CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "ANTHROPIC_CUSTOM_HEADERS"]));
    expect(resolved.environment).toEqual([...resolved.environment].sort());
  });

  it("refuses a launch exactly as a real one is refused", () => {
    const { params, log } = ports({ argv: ["@nobody", "--print"], files: {} });
    expect(() => resolveLaunch(params)).toThrow();
    expect(log.errors.join("\n")).toContain('no identity named "nobody"');
  });

  it("reports the cascade's diagnostics a real launch reports at its resync", () => {
    const { params, log } = ports({ argv: ["@work", "--print"], cliOverride: { entries: { "secret/.credentials.json": true } } });
    resolveLaunch(params);
    expect(log.warns.join("\n")).toContain("SECRET_ENTRY_KEY");
  });

  it("does not refuse an ambient credential it cannot tell from the identity's own injected token", () => {
    const { params, log } = ports({ argv: ["@work", "--print"], files: CREDENTIALED, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_SHAPED } });
    expect(() => resolveLaunch(params)).not.toThrow();
    expect(log.errors).toEqual([]);
    expect(log.warns.join("\n")).toContain("not resolved here");
  });

  it("still refuses an ambient credential when no credential block could account for it", () => {
    const { params } = ports({ argv: ["@work", "--print"], env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_SHAPED } });
    expect(() => resolveLaunch(params)).toThrow();
  });
});

describe("a launch with no farm to resync", () => {
  const SECRET_KEY_OVERRIDE = { entries: { "secret/.credentials.json": true } } as const;

  it("reports the cascade's diagnostics itself, since no resync will", () => {
    const { params, log } = ports({ argv: ["--print"], env: { CLAUDE_CONFIG_DIR: "/somewhere/else" }, cliOverride: SECRET_KEY_OVERRIDE });
    prepareLaunch(params);
    expect(log.errors.join("\n")).toContain("SECRET_ENTRY_KEY");
  });

  it("leaves reporting to the resync when there is a farm, so a diagnostic appears once", () => {
    const { params, log } = ports({ argv: ["@work", "--print"], cliOverride: SECRET_KEY_OVERRIDE });
    prepareLaunch(params);
    const reported = [...log.errors, ...log.warns].filter((line) => line.includes("SECRET_ENTRY_KEY"));
    expect(reported).toHaveLength(1);
  });
});

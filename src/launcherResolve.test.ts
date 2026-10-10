import { describe, expect, it } from "vitest";

import type { Pool } from "./config/schema";
import { prepareLaunch, resolveLaunch, type PrepareLaunchParams } from "./launcher";
import { FAKE_NOW_MS, createFakeFarmFs, discovered, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

const HOUR_MS = 3_600_000;
const SIX_DAYS_MS = 518_400_000;
const FRONTDOOR_PORT = 4100;
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
    fs: fakeFs(options.files ?? {}),
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

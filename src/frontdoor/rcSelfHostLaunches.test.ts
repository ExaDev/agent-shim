import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { registerLaunch } from "../launcher/launchRecords";
import { createRcSelfHostLaunchCheck } from "./rcSelfHostLaunches";

/** Two launcher pids with no meaning beyond being told apart. */
const SELF_HOSTED_PID = 4101;
const NATIVE_PID = 4102;
const STARTED_AT_MS = 1_700_000_000_000;
/** The first launcher pid the directory cases number their entries from. */
const LAUNCH_PID_BASE = 4200;

/**
 * A door state where launch SELF_HOSTED_PID runs the identity whose id is `rig` (the minted one, since renamed `rig2`) and launch NATIVE_PID runs the identity whose id is `work-2` (a suffixed id, created while another `work` existed) and is named `rig`, so a lookup of the minted id by name would find the wrong identity. The launch records are written by the launcher's own `registerLaunch`, from the id the launcher resolves, exactly as a real launch writes them.
 */
function world(): ReturnType<typeof createFakeFarmFs> {
  const fs = createFakeFarmFs({
    "/state/identities/rig/identity.json": '{"name":"rig2"}',
    "/state/identities/work-2/identity.json": '{"name":"rig"}',
    [`/state/frontdoor/sessions/${String(SELF_HOSTED_PID)}.json`]: JSON.stringify({ pid: SELF_HOSTED_PID, startedAt: STARTED_AT_MS, token: "cap-self-hosted" }),
    [`/state/frontdoor/sessions/${String(NATIVE_PID)}.json`]: JSON.stringify({ pid: NATIVE_PID, startedAt: STARTED_AT_MS, token: "cap-native" }),
  });
  const running = (): boolean => true;
  registerLaunch(fs, "/state/launches", { pid: SELF_HOSTED_PID, identity: "rig", startedAtMs: STARTED_AT_MS }, running);
  registerLaunch(fs, "/state/launches", { pid: NATIVE_PID, identity: "work-2", startedAtMs: STARTED_AT_MS }, running);
  return fs;
}

/** The minted record's credential fields, whose values the check never reads. */
const RECORD_FIELDS = { accessToken: "sk-ant-oat1", refreshToken: "refresh", organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222" };

/** The pid of the door in these cases, and of a client process under each launcher, and of a process no launcher started. */
const DOOR_PID = 4000;
const SELF_HOSTED_CLIENT_PID = 5101;
const NATIVE_CLIENT_PID = 5102;
const OUTSIDE_PID = 5200;
/** The shell each self-hosted client runs under, between it and its launcher. */
const SHELL_PID = 5301;
/** The process tree the peer cases read: each launcher's client a grandchild through a shell, and the outside process under init. */
const PARENTS: ReadonlyMap<number, number> = new Map([
  [SELF_HOSTED_CLIENT_PID, SHELL_PID],
  [SHELL_PID, SELF_HOSTED_PID],
  [SELF_HOSTED_PID, 1],
  [NATIVE_CLIENT_PID, NATIVE_PID],
  [NATIVE_PID, 1],
  [OUTSIDE_PID, 1],
  [DOOR_PID, 1],
]);
/** The made-up local ports of each redirected connection's client end, and one no process holds. */
const SELF_HOSTED_PORT = 6101;
const NATIVE_PORT = 6102;
const OUTSIDE_PORT = 6200;
const DOOR_PORT = 6000;
const UNHELD_PORT = 6999;
/** Which pid holds the client end on each made-up port. */
const PORT_OWNERS: ReadonlyMap<number, number> = new Map([
  [SELF_HOSTED_PORT, SELF_HOSTED_CLIENT_PID],
  [NATIVE_PORT, NATIVE_CLIENT_PID],
  [OUTSIDE_PORT, OUTSIDE_PID],
  [DOOR_PORT, DOOR_PID],
]);

const checks = (minted: string | undefined, record: "none" | "legacy" | "current" = "current", tables: Readonly<{ parents?: ReadonlyMap<number, number> | undefined }> = { parents: PARENTS }): ReturnType<typeof createRcSelfHostLaunchCheck> =>
  createRcSelfHostLaunchCheck({
    fs: world(),
    sessionsDir: "/state/frontdoor/sessions",
    launchesDir: "/state/launches",
    identitiesDir: "/state/identities",
    mintedRecord: () => (record === "none" ? undefined : record === "legacy" ? RECORD_FIELDS : { ...RECORD_FIELDS, ...(minted === undefined ? {} : { identityId: minted }) }),
    peerProcessOf: async (port) => await Promise.resolve(PORT_OWNERS.get(port)),
    parentTable: async () => await Promise.resolve(tables.parents),
    doorPid: DOOR_PID,
  });
const check = (minted: string | undefined, record: "none" | "legacy" | "current" = "current"): ((capability: string) => boolean) => checks(minted, record).ownsLaunch;

describe("which launches the self-hosted mode owns", () => {
  it("owns the launch running the minted identity, by its id whatever it is now named, and no other launch", () => {
    expect(check("rig")("cap-self-hosted")).toBe(true);
    expect(check("rig")("cap-native")).toBe(false);
  });

  it("owns a minted identity whose id carries a creation suffix, and not one merely named like the minted id", () => {
    expect(check("work-2")("cap-native")).toBe(true);
    expect(check("work-2")("cap-self-hosted")).toBe(false);
  });

  it("owns nothing while nothing is minted, and fails closed for a capability no registry entry holds", () => {
    expect(check(undefined, "none")("cap-self-hosted")).toBe(false);
    expect(check(undefined, "none")("cap-unknown")).toBe(false);
    expect(check("rig")("cap-unknown")).toBe(true);
  });

  it("fails closed for a mint that names no identity: every launch is the mode's", () => {
    expect(check(undefined, "legacy")("cap-native")).toBe(true);
    expect(check(undefined, "legacy")("cap-unknown")).toBe(true);
  });
});

describe("which redirected connections the self-hosted mode owns", () => {
  it("owns a connection whose peer descends from the minted identity's launch, and no other launch's", async () => {
    expect(await checks("rig").ownsPeer(SELF_HOSTED_PORT)).toBe(true);
    expect(await checks("rig").ownsPeer(NATIVE_PORT)).toBe(false);
  });

  it("leaves the door's own client half and a process no launcher started to the ordinary path", async () => {
    expect(await checks("rig").ownsPeer(DOOR_PORT)).toBe(false);
    expect(await checks("rig").ownsPeer(OUTSIDE_PORT)).toBe(false);
  });

  it("fails closed for a connection whose peer or parentage cannot be read, and owns nothing while nothing is minted", async () => {
    expect(await checks("rig").ownsPeer(UNHELD_PORT)).toBe(true);
    expect(await checks("rig", "current", { parents: undefined }).ownsPeer(NATIVE_PORT)).toBe(true);
    expect(await checks(undefined, "none").ownsPeer(UNHELD_PORT)).toBe(false);
    expect(await checks(undefined, "legacy").ownsPeer(NATIVE_PORT)).toBe(true);
  });
});

/** The cases that make no redirected connection hold no peer at all. */
const NO_PEERS: ReadonlyMap<number, number> = new Map();

describe("attributing a launch by the configuration directory its session names", () => {
  /** A door state holding one session entry per case's launch, each written as the launcher writes it. */
  const withSessions = (entries: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ReturnType<typeof createRcSelfHostLaunchCheck> => {
    const fs = createFakeFarmFs(Object.fromEntries(Object.entries(entries).map(([capability, extra], index) => [`/state/frontdoor/sessions/${String(LAUNCH_PID_BASE + index)}.json`, JSON.stringify({ pid: LAUNCH_PID_BASE + index, startedAt: STARTED_AT_MS, token: capability, ...extra })])));
    return createRcSelfHostLaunchCheck({
      fs,
      sessionsDir: "/state/frontdoor/sessions",
      launchesDir: "/state/launches",
      identitiesDir: "/state/identities",
      mintedRecord: () => ({ ...RECORD_FIELDS, identityId: "rig" }),
      peerProcessOf: async (port) => await Promise.resolve(NO_PEERS.get(port)),
      parentTable: async () => await Promise.resolve(PARENTS),
      doorPid: DOOR_PID,
    });
  };

  it("owns a launch whose child runs in the minted identity's directory, an escape-hatch launch pointed at it included, and no other directory", () => {
    const checked = withSessions({ "cap-own": { configDir: "/state/identities/rig" }, "cap-hatch": { configDir: "/state/identities/./rig/" }, "cap-other": { configDir: "/state/identities/work-2" }, "cap-default": { configDir: "/home/user/.claude" } });
    expect(checked.ownsLaunch("cap-own")).toBe(true);
    expect(checked.ownsLaunch("cap-hatch")).toBe(true);
    expect(checked.ownsLaunch("cap-other")).toBe(false);
    expect(checked.ownsLaunch("cap-default")).toBe(false);
  });

  it("fails closed for an older launcher's entry that names neither a directory nor a launch record", () => {
    expect(withSessions({ "cap-legacy": {} }).ownsLaunch("cap-legacy")).toBe(true);
  });

  it("decides a reused pid by the entry the new launch wrote, never by a crashed launcher's", () => {
    const fs = createFakeFarmFs({ [`/state/frontdoor/sessions/${String(SELF_HOSTED_PID)}.json`]: JSON.stringify({ pid: SELF_HOSTED_PID, startedAt: STARTED_AT_MS, token: "cap-crashed", configDir: "/state/identities/rig" }) });
    const running = (): boolean => true;
    // The crashed self-hosted launcher's launch record survives; the native launcher reusing its pid writes its own registry entry over the crashed one's.
    registerLaunch(fs, "/state/launches", { pid: SELF_HOSTED_PID, identity: "rig", startedAtMs: STARTED_AT_MS }, running);
    fs.seed({ [`/state/frontdoor/sessions/${String(SELF_HOSTED_PID)}.json`]: JSON.stringify({ pid: SELF_HOSTED_PID, startedAt: STARTED_AT_MS + 1, token: "cap-reused", configDir: "/state/identities/work-2" }) });
    const checked = createRcSelfHostLaunchCheck({
      fs,
      sessionsDir: "/state/frontdoor/sessions",
      launchesDir: "/state/launches",
      identitiesDir: "/state/identities",
      mintedRecord: () => ({ ...RECORD_FIELDS, identityId: "rig" }),
      peerProcessOf: async (port) => await Promise.resolve(NO_PEERS.get(port)),
      parentTable: async () => await Promise.resolve(PARENTS),
      doorPid: DOOR_PID,
    });
    expect(checked.ownsLaunch("cap-reused")).toBe(false);
    // The crashed launch's capability matches no entry any more, so nothing attributes it and it fails closed.
    expect(checked.ownsLaunch("cap-crashed")).toBe(true);
  });
});

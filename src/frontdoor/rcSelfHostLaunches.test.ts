import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { registerLaunch } from "../launcher/launchRecords";
import { createRcSelfHostLaunchCheck } from "./rcSelfHostLaunches";

/** Two launcher pids with no meaning beyond being told apart. */
const SELF_HOSTED_PID = 4101;
const NATIVE_PID = 4102;
const STARTED_AT_MS = 1_700_000_000_000;

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

const check = (minted: string | undefined, record: "none" | "legacy" | "current" = "current"): ((capability: string) => boolean) =>
  createRcSelfHostLaunchCheck({
    fs: world(),
    sessionsDir: "/state/frontdoor/sessions",
    launchesDir: "/state/launches",
    mintedRecord: () => (record === "none" ? undefined : record === "legacy" ? RECORD_FIELDS : { ...RECORD_FIELDS, ...(minted === undefined ? {} : { identityId: minted }) }),
  });

describe("which launches the self-hosted mode owns", () => {
  it("owns the launch running the minted identity, by its id whatever it is now named, and no other launch", () => {
    expect(check("rig")("cap-self-hosted")).toBe(true);
    expect(check("rig")("cap-native")).toBe(false);
  });

  it("owns a minted identity whose id carries a creation suffix, and not one merely named like the minted id", () => {
    expect(check("work-2")("cap-native")).toBe(true);
    expect(check("work-2")("cap-self-hosted")).toBe(false);
  });

  it("owns nothing while nothing is minted, and nothing for a capability no launch holds", () => {
    expect(check(undefined, "none")("cap-self-hosted")).toBe(false);
    expect(check("rig")("cap-unknown")).toBe(false);
  });

  it("fails closed for a mint that names no identity: every launch is the mode's", () => {
    expect(check(undefined, "legacy")("cap-native")).toBe(true);
    expect(check(undefined, "legacy")("cap-unknown")).toBe(true);
  });
});

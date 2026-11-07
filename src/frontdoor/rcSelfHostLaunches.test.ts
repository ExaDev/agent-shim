import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { createRcSelfHostLaunchCheck } from "./rcSelfHostLaunches";

/** Two launcher pids with no meaning beyond being told apart. */
const SELF_HOSTED_PID = 4101;
const NATIVE_PID = 4102;
const STARTED_AT_MS = 1_700_000_000_000;

/** A door state where launch SELF_HOSTED_PID runs `rig` (id `id-rig`, the minted identity, since renamed) and launch NATIVE_PID runs `work`. */
function world(): ReturnType<typeof createFakeFarmFs> {
  const startedAt = new Date(STARTED_AT_MS).toISOString();
  return createFakeFarmFs({
    "/state/identities/id-rig/identity.json": '{"name":"rig-renamed"}',
    "/state/identities/id-work/identity.json": '{"name":"work"}',
    [`/state/frontdoor/sessions/${String(SELF_HOSTED_PID)}.json`]: JSON.stringify({ pid: SELF_HOSTED_PID, startedAt: STARTED_AT_MS, token: "cap-self-hosted" }),
    [`/state/frontdoor/sessions/${String(NATIVE_PID)}.json`]: JSON.stringify({ pid: NATIVE_PID, startedAt: STARTED_AT_MS, token: "cap-native" }),
    [`/state/launches/${String(SELF_HOSTED_PID)}.a.json`]: JSON.stringify({ pid: SELF_HOSTED_PID, identity: "rig-renamed", startedAt }),
    [`/state/launches/${String(NATIVE_PID)}.b.json`]: JSON.stringify({ pid: NATIVE_PID, identity: "work", startedAt }),
  });
}

/** The minted record's credential fields, whose values the check never reads. */
const RECORD_FIELDS = { accessToken: "sk-ant-oat1", refreshToken: "refresh", organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222" };

const check = (minted: string | undefined, record: "none" | "legacy" | "current" = "current"): ((capability: string) => boolean) =>
  createRcSelfHostLaunchCheck({
    fs: world(),
    sessionsDir: "/state/frontdoor/sessions",
    launchesDir: "/state/launches",
    identitiesDir: "/state/identities",
    mintedRecord: () => (record === "none" ? undefined : record === "legacy" ? RECORD_FIELDS : { ...RECORD_FIELDS, ...(minted === undefined ? {} : { identityId: minted }) }),
  });

describe("which launches the self-hosted mode owns", () => {
  it("owns the launch running the minted identity, by its id whatever it is now named, and no other launch", () => {
    expect(check("id-rig")("cap-self-hosted")).toBe(true);
    expect(check("id-rig")("cap-native")).toBe(false);
  });

  it("owns nothing while nothing is minted, and nothing for a capability no launch holds", () => {
    expect(check(undefined, "none")("cap-self-hosted")).toBe(false);
    expect(check("id-rig")("cap-unknown")).toBe(false);
  });

  it("fails closed for a mint that names no identity: every launch is the mode's", () => {
    expect(check(undefined, "legacy")("cap-native")).toBe(true);
    expect(check(undefined, "legacy")("cap-unknown")).toBe(true);
  });
});

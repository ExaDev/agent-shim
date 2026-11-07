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

const check = (minted: string | undefined): ((capability: string) => boolean) =>
  createRcSelfHostLaunchCheck({ fs: world(), sessionsDir: "/state/frontdoor/sessions", launchesDir: "/state/launches", identitiesDir: "/state/identities", mintedIdentityId: () => minted });

describe("which launches the self-hosted mode owns", () => {
  it("owns the launch running the minted identity, by its id whatever it is now named, and no other launch", () => {
    expect(check("id-rig")("cap-self-hosted")).toBe(true);
    expect(check("id-rig")("cap-native")).toBe(false);
  });

  it("owns nothing while nothing is minted, and nothing for a capability no launch holds", () => {
    expect(check(undefined)("cap-self-hosted")).toBe(false);
    expect(check("id-rig")("cap-unknown")).toBe(false);
  });
});

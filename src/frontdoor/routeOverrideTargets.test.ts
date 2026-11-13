import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { SelectorStatePorts } from "../models/selectorPorts";
import { staticSelectorPorts } from "../models/selectorPorts";
import { overrideTargetProblem, type OverrideNames } from "../routeOverrideChecks";
import type { SelectorTarget } from "../models/selectors";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { isBareClaudeName } from "../models/tiers";
import { send, startWorld } from "./mainLoopRouteTestWorld";

/** The configuration both sides read: identities `me` (the session's, id `id-me`) and `work`, a pool `subs` of `work`, a profile `zprof` on provider `z` and `plain` on none. */
const STATE: SelectorStatePorts = {
  profile: (name) => (name === "zprof" ? { kind: "found", value: { provider: "z" } } : name === "plain" ? { kind: "found", value: { provider: undefined } } : { kind: "absent" }),
  identity: (name) => (name === "me" || name === "work" ? { kind: "found", value: { provider: undefined } } : { kind: "absent" }),
  pool: (name) => (name === "subs" ? { kind: "found", value: undefined } : { kind: "absent" }),
  poolPick: () => ({ identity: "work" }),
  sameLogin: (identity, sessionIdentityId) => sessionIdentityId === "id-me" && identity === "me",
};

const NAMES = (providers: readonly string[]): OverrideNames => ({ providers: new Set(providers), identities: new Set(["me", "work"]), profiles: new Set(["zprof", "plain"]), pools: new Set(["subs"]), virtualModels: new Set(), family: () => false });

/** Targets an override can be given, selectors of every kind and shape among them. */
const TARGETS = [
  "auto/z", "auto/z/sonnet", "auto/z/glm-9", "auto/provider:z/opus", "auto/r", "auto/r/opus", "auto/bad", "auto/nothing",
  "auto/sonnet", "auto/Opus", "auto/zprof/sonnet", "auto/plain", "auto/plain/sonnet", "auto/plain/claude-opus-5-1",
  "auto/me", "auto/me/opus", "auto/me/claude-opus-5-1", "auto/work", "auto/work/sonnet", "auto/subs/sonnet", "auto/pool:subs",
  "auto/family:glm/sonnet", "auto/family:glm", "auto//x", "auto/z/",
  "z/glm-9", "z/", "anthropic/", "auto/provider:auto/x", "anthropic/claude-opus-5-1", "acct:work/opus", "acct:work/",
  "acct:me/opus", "acct:me/claude-opus-5-1", "acct:me/haiku", "acct:me/", "acct:nobody/opus",
];

const TIMEOUT_MS = 120_000;

describe("route set accepts exactly the override targets the door routes", () => {
  it("agrees with the door on every target, the session having sent a request of each tier", async () => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, undefined, undefined, { selectorState: STATE });
    try {
      // A provider a hand edit called `auto`, which only `auto/provider:auto/<model>` reaches: with it, a selector the expansion refuses is refused for that reason alone and not for naming no provider.
      world.setProvider("auto", { displayName: "Auto", baseUrl: "http://127.0.0.1:9", credential: { sources: [{ literal: "t" }] } });
      // The session has sent a request of every tier, so a class on the Anthropic route has an id to go by, as it has once a session runs.
      for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
        await send(world, { model: id, requestClass: "auxiliary", identity: "id-me" });
      }
      const ports = staticSelectorPorts({ ...STATE, claudeNameOf: () => undefined, routeProvider: () => undefined, provider: (name: string) => { const found = world.providerReads.lookupProvider(name); return found.kind === "found" ? { kind: "found", value: undefined } : found; }, providerTarget: (provider: string, target: SelectorTarget) => world.providerReads.selectorTarget(provider, target, {}), family: () => false }, () => "work", undefined);
      const providers = ["z", "m", "cx", "ag", "r", "bad", "auto"];
      const disagreements: string[] = [];
      for (const target of TARGETS) {
        const reachedBefore = world.anthropicModels.length;
        const answered = await send(world, { model: "", rawBody: JSON.stringify({ model: target, max_tokens: 1, messages: [] }), requestClass: "auxiliary", identity: "id-me" });
        // An account target is served by relaunching a supervised session; this one is unsupervised, so the door answers with the relaunch to run, which is that target routed.
        const relaunch = answered.status === HTTP_STATUS.badRequest && answered.text.includes("--resume");
        // A name the door hands the Anthropic route as it came, naming no Claude model, is routed nowhere: no route serves it.
        const forwardedAsIs = world.anthropicModels.length > reachedBefore && world.anthropicModels.at(-1) === target && !isBareClaudeName(target);
        const doorRefuses = (answered.status === HTTP_STATUS.badRequest && !relaunch) || forwardedAsIs;
        const checkRefuses = overrideTargetProblem(target, NAMES(providers), ports) !== undefined;
        if (doorRefuses !== checkRefuses) disagreements.push(`${target}: door ${doorRefuses ? "refuses" : "routes"}, check ${checkRefuses ? "refuses" : "accepts"}`);
      }
      expect(disagreements).toEqual([]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);
});

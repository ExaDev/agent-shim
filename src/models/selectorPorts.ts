import os from "node:os";


import { readProfile } from "../configProfilesStore";
import { loginKeyOf, readIdentityAccount } from "../identityAccounts";
import { createIdentityNameReader, identityIdOf, readIdentity } from "../identityStore";
import type { LayoutPaths } from "../paths";
import { collectPoolPick } from "../poolPickReport";
import { realMemberProviderResolver } from "../poolProviderWiring";
import { readPools } from "../poolStore";
import { readableOr } from "../readableConfig";
import { realFarmFs, realFsPort } from "../realPorts";
import { lineariseProfile } from "../resolve/extends";
import { servedModelPorts } from "../frontdoor/cachedCatalogue";
import { createProviderReads } from "../frontdoor/providerReads";
import { readModels } from "../modelsStore";
import { FAMILY_PREFIX, buildFamilies, familyNamed } from "./families";
import { createRouteOverridesReader, type RouteOverridesRead } from "../routeOverridesStore";
import type { SelectorLookup, SelectorPorts, SelectorRefusal } from "./selectors";
import { targetRefs } from "./targets";
import { ownEntry } from "../ownEntry";
import { DuplicateIdentityNameError } from "../identityRecords";
import { configFaultOf } from "../config/load";

/** The part of a selector's live state that is the person's configuration (profiles, identities, pools and logins), as opposed to the providers and families the door reads itself. */
export type SelectorStatePorts = Pick<SelectorPorts, "profile" | "identity" | "pool" | "poolPick" | "sameLogin">;

/**
 * Why the `what` named `name` cannot be used, from the error its read raised, for a refusal the session's client reads: the error's class or code and the command that says more, never the error's own message, which names files under the state root and identities' directory ids. A name two identities claim says so, since that is the person's to fix.
 */
function reasonOf(what: string, name: string, error: unknown): string {
  if (error instanceof DuplicateIdentityNameError) {
    return `identity name "${name}" is claimed by more than one identity, so nothing that names it can be resolved: rename all but one (agent-shim doctor names them)`;
  }
  return `the ${what} "${name}" cannot be read (${configFaultOf(error)}): agent-shim doctor says what is wrong`;
}

/**
 * The provider a profile's launch names once its `extends` chain is applied: the last profile of the chain, base first, that names one, as the cascade applies them (a profile's own setting outranks what it extends).
 */
function profileProvider(paths: LayoutPaths, name: string): string | undefined {
  const { order } = lineariseProfile(name, (candidate) => {
    const profile = readProfile(paths, candidate);
    return profile === undefined ? undefined : { name: candidate, profile };
  });
  return order.reduce<string | undefined>((provider, candidate) => readProfile(paths, candidate)?.launch?.provider ?? provider, undefined);
}

/** Why pool `name` picks no member: every one is refused right now, naming the one back soonest when the ranking knows it. */
export function poolRefusal(name: string, earliestReturn: { readonly identity: string; readonly at: string } | undefined): string {
  const back = earliestReturn === undefined ? "" : `; the earliest back is ${earliestReturn.identity} at ${earliestReturn.at}`;
  return `every member of pool "${name}" is refused right now${back}`;
}

/**
 * The selector state read from the person's configuration under `paths`, every read fresh at the moment it is asked, so a profile, identity or pool edited while a session runs is what its next request expands against. A pool is ranked as `agent-shim pool pick <pool>` ranks it from the directory `home`: the last pick recorded for that directory (the door does not know the session's own) and each member's provider as a launch from `home` resolves it, and records nothing. `home` is injected so a caller other than the door (a test) never reads the real home's picks or committed files.
 */
export function realSelectorStatePorts(paths: LayoutPaths, now: () => number, home: string): SelectorStatePorts {
  const lookUp = <T>(what: string, name: string, read: () => T | undefined): SelectorLookup<T> => {
    try {
      const value = read();
      return value === undefined ? { kind: "absent" } : { kind: "found", value };
    } catch (error) {
      return { kind: "invalid", reason: reasonOf(what, name, error) };
    }
  };
  // The login an identity's stored account names, by the identity's directory id.
  const loginOfId = (id: string): string | undefined => {
    const read = readIdentityAccount(realFarmFs, paths.identitiesDir, id);
    return read?.account === undefined ? undefined : loginKeyOf(read.account);
  };
  return {
    profile: (name) => lookUp("configuration profile", name, () => (readProfile(paths, name) === undefined ? undefined : { provider: profileProvider(paths, name) })),
    identity: (name) => lookUp("identity", name, () => {
      const identity = readIdentity(paths, name);
      return identity === undefined ? undefined : { provider: identity.provider };
    }),
    pool: (name) => {
      const found = lookUp("pool", name, () => (ownEntry(readPools(paths), name) === undefined ? undefined : true));
      return found.kind === "found" ? { kind: "found", value: undefined } : found;
    },
    poolPick: (name): { readonly identity: string } | SelectorRefusal => {
      try {
        const pools = readPools(paths);
        const report = collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: name, pools, directory: home, nowMs: now(), providerOf: realMemberProviderResolver({ paths, cwd: home, env: {}, home }) });
        return report.pick === undefined ? { refusal: poolRefusal(name, report.earliestReturn) } : { identity: report.pick };
      } catch (error) {
        // A pool that cannot be ranked (a member pool nesting it, a member whose files cannot be read) is the person's configuration to fix, and `pool pick` names what.
        return { refusal: `${reasonOf("pool", name, error)}, or run agent-shim pool pick ${name}` };
      }
    },
    // The selected identity is found by its name as it is now, and compared by id with the session's, so a name a renamed identity used to hold, and another identity holds now, never stands for the session's.
    sameLogin: (identity, sessionIdentityId) => {
      try {
        const id = identityIdOf(paths, identity);
        if (id === undefined) {
          return false;
        }
        if (id === sessionIdentityId) {
          return true;
        }
        const login = loginOfId(id);
        return login !== undefined && login === loginOfId(sessionIdentityId);
      } catch (error) {
        return { refusal: reasonOf("identity", identity, error) };
      }
    },
  };
}

/**
 * Every port a selector is expanded against, as the CLI reads them, for a session on `routeProvider` (none: the Anthropic route): the configuration state above, the providers read as the door reads them (their default models and tier mappings, with their stored catalogues), and the families the providers' offered targets form under the global models block. What `agent-shim model explain` expands a selector with, so it says what the door would do with the same files.
 */
export function cliSelectorPorts(paths: LayoutPaths, now: () => number, home: string, routeProvider?: string): SelectorPorts {
  // A config.json that cannot be read holds no models block here; `doctor` reports the file itself.
  const models = readableOr(() => readModels(paths), undefined);
  const reads = createProviderReads({ fs: realFsPort, providersDir: paths.providersDir, models: () => models, catalogueModelsOf: servedModelPorts(paths, () => undefined).catalogueModelsOf });
  return {
    ...realSelectorStatePorts(paths, now, home),
    // No session is running, so none has sent a Claude id the CLI could name: a class on the Anthropic route is explained as the door refuses it before the session's first request of the tier.
    claudeNameOf: () => undefined,
    routeProvider: () => routeProvider,
    provider: (name) => {
      const found = reads.lookupProvider(name);
      return found.kind === "found" ? { kind: "found", value: undefined } : found;
    },
    providerTarget: (provider, target) => reads.selectorTarget(provider, target, {}),
    family: (key) => familyNamed(buildFamilies(targetRefs(paths), models), `${FAMILY_PREFIX}${key}`) !== undefined,
  };
}

/** The person's routing state the door reads per request besides the providers: what a selector names among profiles, identities and pools, the route overrides, and the name of the identity a session's header names by id, each read fresh (the overrides on change), so an edit reaches the next request with no restart. */
export function doorRoutingState(paths: LayoutPaths, log: (line: string) => void, home: string): { readonly selectorState: SelectorStatePorts; readonly routeOverrides: () => RouteOverridesRead; readonly identityNameOf: (id: string) => string | undefined } {
  return { selectorState: realSelectorStatePorts(paths, () => Date.now(), home), routeOverrides: createRouteOverridesReader(realFsPort, paths.routeOverridesFile, log), identityNameOf: createIdentityNameReader(paths).nameOf };
}

/**
 * `live` as a check made outside any session sees it, to decide whether a selector can be routed at all rather than where one session's request goes: the facts a session supplies as it runs are taken as a running session supplies them. A class on the Anthropic route has an id to go by (the session has sent one of the tier by then), the selected identity is another login (so an account selector needs a class, as it does for every session but its own login's), a pool's ranking picks a member even when every member is refused right now (`memberOf` names one), and the session is on `routeProvider`, the provider a check's scope names, or on the Anthropic route.
 */
export function staticSelectorPorts(live: Readonly<SelectorPorts>, memberOf: (pool: string) => string | undefined, routeProvider: string | undefined): SelectorPorts {
  return {
    ...live,
    claudeNameOf: (tier) => `claude-${tier}`,
    sameLogin: () => false,
    routeProvider: () => routeProvider,
    poolPick: (name) => {
      const pick = live.poolPick(name);
      const member = "refusal" in pick ? memberOf(name) : pick.identity;
      return member === undefined ? pick : { identity: member };
    },
  };
}

/** The selector ports an override's target is checked with, by `route set`, `config.route.set` and `doctor`: the configuration under `paths` as the CLI reads it, through `staticSelectorPorts`, for a session on `routeProvider`. */
export function routeTargetPorts(paths: LayoutPaths, routeProvider: string | undefined): SelectorPorts {
  return staticSelectorPorts(cliSelectorPorts(paths, () => Date.now(), os.homedir(), routeProvider), (pool) => {
    const [first] = ownEntry(readableOr(() => readPools(paths), {}), pool)?.identities ?? [];
    return first === undefined ? undefined : typeof first === "string" ? first : first.identity;
  }, routeProvider);
}

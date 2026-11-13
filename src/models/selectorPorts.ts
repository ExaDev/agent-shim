
import { readProfile } from "../configProfilesStore";
import { loginKeyOf, readIdentityAccount } from "../identityAccounts";
import { createIdentityNameReader, identityIdOf, readIdentity } from "../identityStore";
import type { LayoutPaths } from "../paths";
import { collectPoolPick } from "../poolPickReport";
import { realMemberProviderResolver } from "../poolProviderWiring";
import { readPools } from "../poolStore";
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

/** The part of a selector's live state that is the person's configuration (profiles, identities, pools and logins), as opposed to the providers and families the door reads itself. */
export type SelectorStatePorts = Pick<SelectorPorts, "profile" | "identity" | "pool" | "poolPick" | "sameLogin">;

/** The message of a failed read, for a refusal: the store's own error names the file and what is wrong with it. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const lookUp = <T>(read: () => T | undefined): SelectorLookup<T> => {
    try {
      const value = read();
      return value === undefined ? { kind: "absent" } : { kind: "found", value };
    } catch (error) {
      return { kind: "invalid", reason: reasonOf(error) };
    }
  };
  // The login an identity's stored account names, by the identity's directory id.
  const loginOfId = (id: string): string | undefined => {
    const read = readIdentityAccount(realFarmFs, paths.identitiesDir, id);
    return read?.account === undefined ? undefined : loginKeyOf(read.account);
  };
  return {
    profile: (name) => lookUp(() => (readProfile(paths, name) === undefined ? undefined : { provider: profileProvider(paths, name) })),
    identity: (name) => lookUp(() => {
      const identity = readIdentity(paths, name);
      return identity === undefined ? undefined : { provider: identity.provider };
    }),
    pool: (name) => {
      const found = lookUp(() => (ownEntry(readPools(paths), name) === undefined ? undefined : true));
      return found.kind === "found" ? { kind: "found", value: undefined } : found;
    },
    poolPick: (name): { readonly identity: string } | SelectorRefusal => {
      const pools = readPools(paths);
      const report = collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: name, pools, directory: home, nowMs: now(), providerOf: realMemberProviderResolver({ paths, cwd: home, env: {}, home }) });
      return report.pick === undefined ? { refusal: poolRefusal(name, report.earliestReturn) } : { identity: report.pick };
    },
    // The selected identity is found by its name as it is now, and compared by id with the session's, so a name a renamed identity used to hold, and another identity holds now, never stands for the session's.
    sameLogin: (identity, sessionIdentityId) => {
      const id = identityIdOf(paths, identity);
      if (id === undefined) {
        return false;
      }
      if (id === sessionIdentityId) {
        return true;
      }
      const login = loginOfId(id);
      return login !== undefined && login === loginOfId(sessionIdentityId);
    },
  };
}

/**
 * Every port a selector is expanded against, as the CLI reads them, for a session on `routeProvider` (none: the Anthropic route): the configuration state above, the providers read as the door reads them (their default models and tier mappings, with their stored catalogues), and the families the providers' offered targets form under the global models block. What `agent-shim model explain` expands a selector with, so it says what the door would do with the same files.
 */
export function cliSelectorPorts(paths: LayoutPaths, now: () => number, home: string, routeProvider?: string): SelectorPorts {
  const models = readModels(paths);
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

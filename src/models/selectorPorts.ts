import os from "node:os";

import { readProfile } from "../configProfilesStore";
import { loginKeyOf, readIdentityAccount } from "../identityAccounts";
import { identityIdOf, readIdentity } from "../identityStore";
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
import type { SelectorLookup, SelectorPorts, SelectorRefusal } from "./selectors";
import { targetRefs } from "./targets";

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

/**
 * The selector state read from the person's configuration under `paths`, every read fresh at the moment it is asked, so a profile, identity or pool edited while a session runs is what its next request expands against. A pool is ranked as `agent-shim pool pick <pool>` ranks it from the home directory: no directory's last pick and the provider each member declares, and records nothing.
 */
export function realSelectorStatePorts(paths: LayoutPaths, now: () => number): SelectorStatePorts {
  const lookUp = <T>(read: () => T | undefined): SelectorLookup<T> => {
    try {
      const value = read();
      return value === undefined ? { kind: "absent" } : { kind: "found", value };
    } catch (error) {
      return { kind: "invalid", reason: reasonOf(error) };
    }
  };
  const loginOf = (identity: string): string | undefined => {
    const id = identityIdOf(paths, identity);
    const read = id === undefined ? undefined : readIdentityAccount(realFarmFs, paths.identitiesDir, id);
    return read?.account === undefined ? undefined : loginKeyOf(read.account);
  };
  return {
    profile: (name) => lookUp(() => (readProfile(paths, name) === undefined ? undefined : { provider: profileProvider(paths, name) })),
    identity: (name) => lookUp(() => {
      const identity = readIdentity(paths, name);
      return identity === undefined ? undefined : { provider: identity.provider };
    }),
    pool: (name) => {
      const found = lookUp(() => (readPools(paths)[name] === undefined ? undefined : true));
      return found.kind === "found" ? { kind: "found", value: undefined } : found;
    },
    poolPick: (name): { readonly identity: string } | SelectorRefusal => {
      const pools = readPools(paths);
      const home = os.homedir();
      const report = collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: name, pools, directory: home, nowMs: now(), providerOf: realMemberProviderResolver({ paths, cwd: home, env: {} }) });
      if (report.pick !== undefined) {
        return { identity: report.pick };
      }
      const back = report.earliestReturn === undefined ? "" : `; the earliest back is ${report.earliestReturn.identity} at ${report.earliestReturn.at}`;
      return { refusal: `every member of pool "${name}" is refused right now${back}` };
    },
    sameLogin: (identity, sessionIdentity) => {
      if (identity === sessionIdentity) {
        return true;
      }
      const login = loginOf(identity);
      return login !== undefined && login === loginOf(sessionIdentity);
    },
  };
}

/**
 * Every port a selector is expanded against, as the CLI reads them: the configuration state above, the providers read as the door reads them (their default models and tier mappings, with their stored catalogues), and the families the providers' offered targets form under the global models block. What `agent-shim model explain` expands a selector with, so it says what the door would do with the same files.
 */
export function cliSelectorPorts(paths: LayoutPaths, now: () => number): SelectorPorts {
  const models = readModels(paths);
  const reads = createProviderReads({ fs: realFsPort, providersDir: paths.providersDir, models: () => models, catalogueModelsOf: servedModelPorts(paths, () => undefined).catalogueModelsOf });
  return {
    ...realSelectorStatePorts(paths, now),
    provider: (name) => {
      const found = reads.lookupProvider(name);
      return found.kind === "found" ? { kind: "found", value: undefined } : found;
    },
    providerTarget: (provider, target) => reads.selectorTarget(provider, target, {}),
    family: (key) => familyNamed(buildFamilies(targetRefs(paths), models), `${FAMILY_PREFIX}${key}`) !== undefined,
  };
}

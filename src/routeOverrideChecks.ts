import type { ModelsConfig } from "./config/schema";
import { listProfiles } from "./configProfilesStore";
import { listIdentities } from "./identityStore";
import { FAMILY_PREFIX, buildFamilies, familyNamed } from "./models/families";
import { withoutContextMarker } from "./models/identity";
import { expandSelectorName, type SelectorLookup, type SelectorPorts } from "./models/selectors";
import { ANTHROPIC_ROUTE_NAME } from "./models/reservedModelNames";
import { targetRefs } from "./models/targets";
import { isBareClaudeName } from "./models/tiers";
import { readModels } from "./modelsStore";
import type { LayoutPaths } from "./paths";
import { readPools } from "./poolStore";
import { listProviderNames } from "./providersStore";
import { realFsPort } from "./realPorts";
import { isOverrideKey, overrideMatches, overrideTargetShapeProblem, type RouteOverrideScope } from "./routeOverridesStore";
import type { RouteOverrides } from "./routeOverridesSchema";
import { ownEntry } from "./ownEntry";

/** The names a target or a scope may refer to: what is defined in the configuration as the checks see it. */
export interface OverrideNames {
  readonly providers: ReadonlySet<string>;
  readonly identities: ReadonlySet<string>;
  readonly profiles: ReadonlySet<string>;
  readonly pools: ReadonlySet<string>;
  readonly virtualModels: ReadonlySet<string>;
  /** Whether a model family of this canonical key is offered. */
  readonly family: (key: string) => boolean;
}

/** The names defined under `paths` now, read from the stores (a profile, identity or provider whose file cannot be read is not counted as defined). */
export function overrideNamesOf(paths: LayoutPaths): OverrideNames {
  const models = readModels(paths);
  return {
    providers: new Set(listProviderNames(realFsPort.readdir, paths.providersDir)),
    identities: new Set(listIdentities(paths).map((entry) => entry.name)),
    profiles: new Set(listProfiles(paths, () => undefined).map((entry) => entry.name)),
    pools: new Set(Object.keys(readPools(paths))),
    virtualModels: new Set(Object.keys(models?.virtual ?? {})),
    family: (key) => familyNamed(buildFamilies(targetRefs(paths), models), `${FAMILY_PREFIX}${key}`) !== undefined,
  };
}

/**
 * The selector ports a check reads when it has nothing but `names`: each name found or not, a provider's target taken as served under the name the request gives it. What `doctor` checks a file with when it is not handed the configuration's own ports.
 */
function namesSelectorPorts(names: Readonly<OverrideNames>): SelectorPorts {
  const found = <T>(present: boolean, value: T): SelectorLookup<T> => (present ? { kind: "found", value } : { kind: "absent" });
  return {
    profile: (name) => found(names.profiles.has(name), { provider: undefined }),
    identity: (name) => found(names.identities.has(name), { provider: undefined }),
    pool: (name) => found(names.pools.has(name), undefined),
    // A pool is taken to pick one of the defined identities: which one, only a ranking at the moment of a request says.
    poolPick: (name) => {
      const [member] = names.identities;
      return member === undefined ? { refusal: `pool "${name}" has no identity to pick` } : { identity: member };
    },
    provider: (name) => found(names.providers.has(name), undefined),
    providerTarget: (provider, target) => ({ name: `${provider}/${target.kind === "none" ? "default" : target.kind === "class" ? target.tier : target.model}` }),
    family: names.family,
    sameLogin: () => false,
    claudeNameOf: (tier) => `claude-${tier}`,
    routeProvider: () => undefined,
  };
}

/**
 * Why `target` cannot be an override's target, or undefined when the door routes it: a selector is expanded by the door's own `expandSelectorName` over `ports` (the configuration as `staticSelectorPorts` reads it for a running session), and whatever it expands to is held to the same rules as a target written out: an account model of a defined identity with a model after it, a family the providers offer, a provider model of a defined provider with a model after the provider part (or `anthropic/<model>`, the Anthropic route, when no provider has that name), a virtual model, a bare provider name, or a Claude name. `ports` defaults to what `names` alone says (`namesSelectorPorts`).
 */
export function overrideTargetProblem(target: string, names: Readonly<OverrideNames>, ports: Readonly<SelectorPorts> = namesSelectorPorts(names)): string | undefined {
  const shape = overrideTargetShapeProblem(target);
  if (shape !== undefined) {
    return shape;
  }
  const expanded = expandSelectorName(target, ports, {});
  if (expanded !== undefined && "refusal" in expanded) {
    return expanded.refusal;
  }
  const routed = expanded?.name ?? target;
  if (routed.startsWith("acct:")) {
    const [identity, ...rest] = routed.slice("acct:".length).split("/");
    return identity === undefined || rest.join("/") === "" ? "an account target is acct:<identity>/<model>" : names.identities.has(identity) ? undefined : `no identity "${identity}" is defined`;
  }
  if (routed.startsWith(FAMILY_PREFIX)) {
    return names.family(routed.slice(FAMILY_PREFIX.length)) ? undefined : `no target the providers offer belongs to ${routed}`;
  }
  if (routed.includes("/")) {
    const [provider = "", ...rest] = routed.split("/");
    if (rest.join("/") === "") {
      return `${JSON.stringify(routed)} names no model after the provider: write ${provider}/<model>`;
    }
    return names.providers.has(provider) || provider === ANTHROPIC_ROUTE_NAME ? undefined : `no provider "${provider}" is defined`;
  }
  const bare = withoutContextMarker(routed);
  return names.virtualModels.has(bare) || names.providers.has(bare) || isBareClaudeName(bare) ? undefined : `${JSON.stringify(target)} names no provider, virtual model, family or Claude model`;
}

/** Why `scope` cannot hold overrides given what `names` defines, or undefined: an identity or provider scope names a defined one, and a session scope any session id. */
export function overrideScopeProblem(scope: RouteOverrideScope, names: Readonly<OverrideNames>): string | undefined {
  if (scope.kind === "identity" && !names.identities.has(scope.name)) {
    return `no identity "${scope.name}" is defined`;
  }
  return scope.kind === "provider" && !names.providers.has(scope.name) ? `no provider "${scope.name}" is defined` : undefined;
}

/** One finding of the overrides check. */
export interface OverrideFinding {
  readonly severity: "fail" | "warn";
  readonly message: string;
}

/** Every scope the file holds a table for, in precedence order within each kind. */
function scopesIn(overrides: Readonly<RouteOverrides>): readonly RouteOverrideScope[] {
  const named = (kind: "session" | "identity" | "provider", tables: Readonly<Record<string, unknown>> | undefined): readonly RouteOverrideScope[] => Object.keys(tables ?? {}).map((name) => ({ kind, name }));
  return [...named("session", overrides.sessions), ...named("identity", overrides.identities), ...named("provider", overrides.providers), ...(overrides.global === undefined ? [] : [{ kind: "global" } as const])];
}

/** The table one scope holds. */
function entriesOf(overrides: Readonly<RouteOverrides>, scope: RouteOverrideScope): readonly (readonly [string, string])[] {
  const table = scope.kind === "global" ? overrides.global : scope.kind === "session" ? ownEntry(overrides.sessions, scope.name) : scope.kind === "identity" ? ownEntry(overrides.identities, scope.name) : ownEntry(overrides.providers, scope.name);
  return Object.entries(table ?? {});
}

/** A scope as a finding names it. */
function scopeLabel(scope: RouteOverrideScope): string {
  return scope.kind === "global" ? "the global table" : `the ${scope.kind} table for ${JSON.stringify(scope.name)}`;
}

/**
 * Checks the overrides against what `names` defines: every key a bare Claude name or class, every identity and provider scope defined, every target routable (`overrideTargetProblem`, over the ports `portsFor` gives the scope: a provider scope's session is on that provider), and every target that is itself a Claude name another entry of the same scopes would override, which the door does not follow (an override is applied once): a chain is a warning naming where the request goes, a chain that comes back to its start is a failure. Linear in the entries: each chain is followed through at most as many entries as its scope's tables hold.
 */
export function routeOverrideFindings(overrides: Readonly<RouteOverrides>, names: Readonly<OverrideNames>, portsFor: (scope: RouteOverrideScope) => Readonly<SelectorPorts> = () => namesSelectorPorts(names)): readonly OverrideFinding[] {
  const findings: OverrideFinding[] = [];
  for (const scope of scopesIn(overrides)) {
    const label = scopeLabel(scope);
    const scopeProblem = overrideScopeProblem(scope, names);
    if (scopeProblem !== undefined) {
      findings.push({ severity: "fail", message: `Route overrides: ${label} applies to nothing: ${scopeProblem}. Remove its entries with \`agent-shim route remove\`.` });
    }
    const entries = entriesOf(overrides, scope);
    // The scopes a request covered by this one is also covered by, so a chain is followed as the door would have looked each name up.
    const ids = scope.kind === "global" ? {} : scope.kind === "session" ? { sessionId: scope.name } : scope.kind === "identity" ? { identity: scope.name } : { provider: scope.name };
    const seenKeys = new Set<string>();
    for (const [key, target] of entries) {
      if (key !== key.toLowerCase()) {
        findings.push({ severity: "fail", message: `Route overrides: ${label} has the key ${JSON.stringify(key)}, which is not written in lower case as \`route set\` writes keys. Write it as ${JSON.stringify(key.toLowerCase())}${entries.some(([other]) => other !== key && other.toLowerCase() === key.toLowerCase()) ? "; the table also has another key differing only in case, so the front door refuses the file until one is removed" : ""}.` });
        seenKeys.add(key.toLowerCase());
        continue;
      }
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      if (!isOverrideKey(key)) {
        findings.push({ severity: "fail", message: `Route overrides: ${label} has the key ${JSON.stringify(key)}, which is no bare Claude name or class, so no request is ever routed by it.` });
        continue;
      }
      const problem = overrideTargetProblem(target, names, portsFor(scope));
      if (problem !== undefined) {
        findings.push({ severity: "fail", message: `Route overrides: ${label} routes ${JSON.stringify(key)} to ${JSON.stringify(target)}, which cannot be routed: ${problem}.` });
        continue;
      }
      if (!isBareClaudeName(target)) {
        continue;
      }
      const chain = [key];
      let next = overrideMatches(overrides, ids, target)[0];
      // An entry whose target its own key matches (`opus` to `claude-opus-5-1`) pins the class to one model: the door sends that model, which is what it says. The match is always this entry, since its own scope covers the lookup and holds the key.
      if (next?.key === key) {
        continue;
      }
      // Each turn adds a key not yet in the chain, so the walk ends within the number of distinct keys.
      while (next !== undefined && !chain.includes(next.key)) {
        chain.push(next.key);
        next = isBareClaudeName(next.target) ? overrideMatches(overrides, ids, next.target)[0] : undefined;
      }
      if (next !== undefined && chain.includes(next.key)) {
        findings.push({ severity: "fail", message: `Route overrides: ${label} routes ${JSON.stringify(key)} to ${JSON.stringify(target)}, and the overrides come back round (${[...chain, next.key].join(" -> ")}): each is applied once, so a request for ${JSON.stringify(key)} is sent as ${JSON.stringify(target)} and no further. Remove one of them.` });
      } else if (chain.length > 1) {
        findings.push({ severity: "warn", message: `Route overrides: ${label} routes ${JSON.stringify(key)} to ${JSON.stringify(target)}, which another override routes on (${chain.join(" -> ")}): an override is applied once, so a request for ${JSON.stringify(key)} is sent as ${JSON.stringify(target)} and no further.` });
      }
    }
  }
  return findings;
}

/**
 * The doctor's findings for the overrides file at `file`: a pass when there is none (`validated` undefined), a failure when it cannot be used (the reason the validation gave), else `routeOverrideFindings` over the names the configuration defines, or a pass when they find nothing.
 */
export function routeOverrideDoctorFindings(
  file: string,
  validated: { readonly ok: true; readonly data: RouteOverrides } | { readonly ok: false; readonly message: string } | undefined,
  defined: Readonly<{ readonly providers: readonly string[]; readonly identities: readonly string[]; readonly profiles: readonly string[]; readonly pools: readonly string[]; readonly models: ModelsConfig | undefined; readonly targets: readonly string[] }>,
  /** The configuration's own selector ports for a session on a provider (or none), as `route set` checks with; absent, what the names alone say. */
  portsFor?: (routeProvider: string | undefined) => Readonly<SelectorPorts>,
): readonly (OverrideFinding | { readonly severity: "pass"; readonly message: string })[] {
  if (validated === undefined) {
    return [{ severity: "pass", message: "No route overrides are set." }];
  }
  if (!validated.ok) {
    return [{ severity: "fail", message: `${validated.message} The front door refuses every main-loop request for a Claude name until it is fixed.` }];
  }
  const { models } = defined;
  const names: OverrideNames = {
    providers: new Set(defined.providers),
    identities: new Set(defined.identities),
    profiles: new Set(defined.profiles),
    pools: new Set(defined.pools),
    virtualModels: new Set(Object.keys(models?.virtual ?? {})),
    family: (key) => familyNamed(buildFamilies(defined.targets, models), `${FAMILY_PREFIX}${key}`) !== undefined,
  };
  const findings = routeOverrideFindings(validated.data, names, portsFor === undefined ? undefined : (scope) => portsFor(scope.kind === "provider" ? scope.name : undefined));
  return findings.length === 0 ? [{ severity: "pass", message: `${file} is consistent.` }] : findings;
}

import type { ModelsConfig } from "./config/schema";
import { listProfiles } from "./configProfilesStore";
import { listIdentities } from "./identityStore";
import { FAMILY_PREFIX, buildFamilies, familyNamed } from "./models/families";
import { withoutContextMarker } from "./models/identity";
import { parseSelectorName, SELECTOR_KINDS, type SelectorKind } from "./models/selectors";
import { targetRefs } from "./models/targets";
import { isBareClaudeName } from "./models/tiers";
import { readModels } from "./modelsStore";
import type { LayoutPaths } from "./paths";
import { readPools } from "./poolStore";
import { listProviderNames } from "./providersStore";
import { realFsPort } from "./realPorts";
import { isOverrideKey, overrideMatches, overrideTargetShapeProblem, type RouteOverrideScope } from "./routeOverridesStore";
import type { RouteOverrides } from "./routeOverridesSchema";

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

/** Whether `names` defines `word` as a thing of `kind`. */
function defines(names: Readonly<OverrideNames>, kind: SelectorKind, word: string): boolean {
  const sets: Readonly<Record<Exclude<SelectorKind, "family">, ReadonlySet<string>>> = { profile: names.profiles, identity: names.identities, pool: names.pools, provider: names.providers };
  return kind === "family" ? names.family(word) : sets[kind].has(word);
}

/**
 * Why `target` cannot be an override's target given what `names` defines, or undefined when it names something the door routes: a selector naming exactly one thing (or the thing its kind prefix names), an account model of a defined identity, a family the providers offer, a provider model of a defined provider (or `anthropic/<model>`, the Anthropic route, when no provider has that name), a virtual model, a bare provider name, or a Claude name.
 */
export function overrideTargetProblem(target: string, names: Readonly<OverrideNames>): string | undefined {
  const shape = overrideTargetShapeProblem(target);
  if (shape !== undefined) {
    return shape;
  }
  const parsed = parseSelectorName(target);
  if (parsed !== undefined) {
    if ("refusal" in parsed) {
      return parsed.refusal;
    }
    const { kind, name } = parsed.selector;
    const found = kind === undefined ? SELECTOR_KINDS.filter((candidate) => defines(names, candidate, name)) : defines(names, kind, name) ? [kind] : [];
    if (found.length === 0) {
      return `the selector names nothing: no ${kind ?? "configuration profile, identity, pool, provider or model family"} is called ${JSON.stringify(name)}`;
    }
    return found.length > 1 ? `the selector's ${JSON.stringify(name)} is ambiguous (it names a ${found.join(", a ")}): give it a kind prefix, such as auto/${found[0] ?? ""}:${name}` : undefined;
  }
  if (target.startsWith("acct:")) {
    const [identity, ...rest] = target.slice("acct:".length).split("/");
    return identity === undefined || rest.join("/") === "" ? "an account target is acct:<identity>/<model>" : names.identities.has(identity) ? undefined : `no identity "${identity}" is defined`;
  }
  if (target.startsWith(FAMILY_PREFIX)) {
    return names.family(target.slice(FAMILY_PREFIX.length)) ? undefined : `no target the providers offer belongs to ${target}`;
  }
  if (target.includes("/")) {
    const [provider = ""] = target.split("/");
    return names.providers.has(provider) || provider === "anthropic" ? undefined : `no provider "${provider}" is defined`;
  }
  const bare = withoutContextMarker(target);
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
  const table = scope.kind === "global" ? overrides.global : scope.kind === "session" ? overrides.sessions?.[scope.name] : scope.kind === "identity" ? overrides.identities?.[scope.name] : overrides.providers?.[scope.name];
  return Object.entries(table ?? {});
}

/** Whether two scopes are one. */
function sameScope(left: RouteOverrideScope, right: RouteOverrideScope): boolean {
  return left.kind === right.kind && (left.kind === "global" || (right.kind !== "global" && left.name === right.name));
}

/** A scope as a finding names it. */
function scopeLabel(scope: RouteOverrideScope): string {
  return scope.kind === "global" ? "the global table" : `the ${scope.kind} table for ${JSON.stringify(scope.name)}`;
}

/**
 * Checks the overrides against what `names` defines: every key a bare Claude name or class, every identity and provider scope defined, every target routable (`overrideTargetProblem`), and every target that is itself a Claude name another entry of the same scopes would override, which the door does not follow (an override is applied once): a chain is a warning naming where the request goes, a chain that comes back to its start is a failure. Linear in the entries: each chain is followed through at most as many entries as its scope's tables hold.
 */
export function routeOverrideFindings(overrides: Readonly<RouteOverrides>, names: Readonly<OverrideNames>): readonly OverrideFinding[] {
  const findings: OverrideFinding[] = [];
  for (const scope of scopesIn(overrides)) {
    const label = scopeLabel(scope);
    const scopeProblem = overrideScopeProblem(scope, names);
    if (scopeProblem !== undefined) {
      findings.push({ severity: "fail", message: `Route overrides: ${label} applies to nothing: ${scopeProblem}. Remove it with \`agent-shim route unset\`.` });
    }
    const entries = entriesOf(overrides, scope);
    // The scopes a request covered by this one is also covered by, so a chain is followed as the door would have looked each name up.
    const ids = scope.kind === "global" ? {} : scope.kind === "session" ? { sessionId: scope.name } : scope.kind === "identity" ? { identity: scope.name } : { provider: scope.name };
    for (const [key, target] of entries) {
      if (!isOverrideKey(key)) {
        findings.push({ severity: "fail", message: `Route overrides: ${label} has the key ${JSON.stringify(key)}, which is no bare Claude name or class, so no request is ever routed by it.` });
        continue;
      }
      const problem = overrideTargetProblem(target, names);
      if (problem !== undefined) {
        findings.push({ severity: "fail", message: `Route overrides: ${label} routes ${JSON.stringify(key)} to ${JSON.stringify(target)}, which cannot be routed: ${problem}.` });
        continue;
      }
      if (!isBareClaudeName(target)) {
        continue;
      }
      const chain = [key];
      let next = overrideMatches(overrides, ids, target)[0];
      // An entry whose target its own key matches (`opus` to `claude-opus-5-1`) pins the class to one model: the door sends that model, which is what it says.
      if (next?.key === key && sameScope(next.scope, scope)) {
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
  const findings = routeOverrideFindings(validated.data, names);
  return findings.length === 0 ? [{ severity: "pass", message: `${file} is consistent.` }] : findings;
}

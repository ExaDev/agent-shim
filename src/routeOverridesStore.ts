import type { z } from "zod";

import { UsageError } from "./cliError";
import { writeJsonAtomic, readJson } from "./config/store";
import { parseIgnoringUnrecognisedKeys } from "./config/unrecognisedKeys";
import type { FsPort } from "./launcher/ports";
import { withoutContextMarker } from "./models/identity";
import { AUTO_MODEL, SELECTOR_PREFIX } from "./models/reservedModelNames";
import { parseSelectorName } from "./models/selectors";
import { claudeNameTier } from "./models/tiers";
import type { LayoutPaths } from "./paths";
import { catalogueReadFault } from "./storedCatalogue";
import { RouteOverridesSchema, type OverrideTable, type RouteOverrides } from "./routeOverridesSchema";

/**
 * The runtime route overrides: per scope, a table from a bare Claude model name or class to the name a request asking for it is routed by instead. Stored at `LayoutPaths.routeOverridesFile`, written by `agent-shim route set|unset` and `config.route.set|unset`, and read by the door on change (`createRouteOverridesReader`), so an edit applies to the next request with no restart and nothing changed in Claude Code.
 */

/** The scopes an override can be set in, highest precedence first: an entry of an earlier scope outranks every entry of a later one. */
export const ROUTE_OVERRIDE_SCOPES = ["session", "identity", "provider", "global"] as const;

/** What no file means: no override anywhere. */
export const NO_ROUTE_OVERRIDES: RouteOverrides = { schemaVersion: 1 };

/** One scope an override is set in: global, or one named provider, identity or session. */
export type RouteOverrideScope = { readonly kind: "global" } | { readonly kind: "provider" | "identity" | "session"; readonly name: string };

/** The file key of each named scope's tables. */
const SCOPE_KEYS = { provider: "providers", identity: "identities", session: "sessions" } as const;

/** The table one scope holds, or none. */
function tableOf(overrides: Readonly<RouteOverrides>, scope: RouteOverrideScope): OverrideTable | undefined {
  return scope.kind === "global" ? overrides.global : overrides[SCOPE_KEYS[scope.kind]]?.[scope.name];
}

/** Whether `name` can be an override's key: a bare Claude name or class (`claude-opus-5-5`, `opus`), with no provider and no context marker. */
export function isOverrideKey(name: string): boolean {
  return !name.includes("/") && withoutContextMarker(name) === name && claudeNameTier(name) !== undefined;
}

/** Why `target` cannot be an override's target by its shape alone, or undefined when it can: the bare model `auto` names no provider, and a target the door would look up again is never looked up again, so only its shape is checked here (what it names is checked by the caller against the configuration). */
export function overrideTargetShapeProblem(target: string): string | undefined {
  if (target.trim() === "") {
    return "a target names a model";
  }
  return withoutContextMarker(target) === AUTO_MODEL ? `"${AUTO_MODEL}" alone names no provider: name the provider's live model as <provider>/${AUTO_MODEL}` : undefined;
}

/** One override that matched a request's model: the scope it is in, its key, its target, and whether the key is the model's exact name or its class. */
export interface OverrideMatch {
  readonly scope: RouteOverrideScope;
  readonly key: string;
  readonly target: string;
  readonly match: "exact" | "class";
}

/** The scopes that cover one request: its session id, its identity and the provider it would reach, each when it has one. */
export interface OverrideScopeIds {
  readonly sessionId?: string;
  readonly identity?: string;
  readonly provider?: string;
}

/** The scopes covering `ids`, highest precedence first. */
function scopesOf(ids: Readonly<OverrideScopeIds>): readonly RouteOverrideScope[] {
  return [
    ...(ids.sessionId === undefined ? [] : [{ kind: "session", name: ids.sessionId } as const]),
    ...(ids.identity === undefined ? [] : [{ kind: "identity", name: ids.identity } as const]),
    ...(ids.provider === undefined ? [] : [{ kind: "provider", name: ids.provider } as const]),
    { kind: "global" } as const,
  ];
}

/**
 * Every override that matches `model` for a request covered by `ids`, in precedence order: by scope (session, identity, provider, global) and, within a scope, the exact name before the class. The first is the one that applies; the rest are what it outranks. A model that is no bare Claude name matches nothing. The model is compared without its context marker. A constant number of lookups: two per scope.
 */
export function overrideMatches(overrides: Readonly<RouteOverrides>, ids: Readonly<OverrideScopeIds>, model: string): readonly OverrideMatch[] {
  const bare = withoutContextMarker(model);
  if (bare.includes("/")) {
    return [];
  }
  const tier = claudeNameTier(bare);
  if (tier === undefined) {
    return [];
  }
  return scopesOf(ids).flatMap((scope) => {
    const table = tableOf(overrides, scope);
    const exact = bare === tier ? undefined : table?.[bare];
    const byClass = table?.[tier];
    return [...(exact === undefined ? [] : [{ scope, key: bare, target: exact, match: "exact" } as const]), ...(byClass === undefined ? [] : [{ scope, key: tier, target: byClass, match: "class" } as const])];
  });
}

/** The override that applies to `model` for a request covered by `ids`, or undefined. */
export function overrideFor(overrides: Readonly<RouteOverrides>, ids: Readonly<OverrideScopeIds>, model: string): OverrideMatch | undefined {
  return overrideMatches(overrides, ids, model)[0];
}

/** Reads the overrides: none when the file does not exist. A file that exists and is not valid throws (`ConfigFileNotJsonError`, `ConfigValidationError`), so a damaged file is reported, never read as no overrides. */
export function readRouteOverrides(paths: LayoutPaths): RouteOverrides {
  return readJson(paths.routeOverridesFile, RouteOverridesSchema) ?? NO_ROUTE_OVERRIDES;
}

/** `overrides` with one top-level field replaced, or left out when `value` is undefined, so an emptied table or scope map leaves no key. */
function withField<K extends "global" | "providers" | "identities" | "sessions">(overrides: Readonly<RouteOverrides>, field: K, value: RouteOverrides[K] | undefined): RouteOverrides {
  const fields: Pick<RouteOverrides, "global" | "providers" | "identities" | "sessions"> = { ...overrides, [field]: value };
  return {
    schemaVersion: overrides.schemaVersion,
    ...(overrides.$schema === undefined ? {} : { $schema: overrides.$schema }),
    ...(fields.global === undefined ? {} : { global: fields.global }),
    ...(fields.providers === undefined ? {} : { providers: fields.providers }),
    ...(fields.identities === undefined ? {} : { identities: fields.identities }),
    ...(fields.sessions === undefined ? {} : { sessions: fields.sessions }),
  };
}

/** The overrides with one entry set (`target` a name) or removed (`target` undefined), an emptied table and an emptied scope map leaving no key. Throws `UsageError` for a key that is no bare Claude name or class, a target whose shape cannot be routed, and a removal of an entry that is not set. */
export function withRouteOverride(overrides: Readonly<RouteOverrides>, scope: RouteOverrideScope, key: string, target: string | undefined): RouteOverrides {
  if (!isOverrideKey(key)) {
    throw new UsageError(`An override's model must be a bare Claude name or class (opus, sonnet, haiku, fable, or a name such as claude-opus-5-5, with no [1m] marker), not ${JSON.stringify(key)}.`);
  }
  const table = tableOf(overrides, scope) ?? {};
  if (target === undefined && table[key] === undefined) {
    throw new UsageError(`No override of ${JSON.stringify(key)} is set ${describeScope(scope)}.`);
  }
  const problem = target === undefined ? undefined : overrideTargetShapeProblem(target);
  if (problem !== undefined) {
    throw new UsageError(`An override cannot route ${JSON.stringify(key)} to ${JSON.stringify(target)}: ${problem}.`);
  }
  const next = Object.fromEntries([...Object.entries(table).filter(([existing]) => existing !== key), ...(target === undefined ? [] : [[key, target] as const])]);
  if (scope.kind === "global") {
    return withField(overrides, "global", Object.keys(next).length === 0 ? undefined : next);
  }
  const field = SCOPE_KEYS[scope.kind];
  const tables = Object.fromEntries([...Object.entries(overrides[field] ?? {}).filter(([name]) => name !== scope.name), ...(Object.keys(next).length === 0 ? [] : [[scope.name, next] as const])]);
  return withField(overrides, field, Object.keys(tables).length === 0 ? undefined : tables);
}

/** Writes the overrides atomically (a temporary file renamed over the old one), so a reader sees the old table or the new one, never a part of either. */
export function writeRouteOverrides(paths: LayoutPaths, overrides: Readonly<RouteOverrides>): void {
  writeJsonAtomic(paths.routeOverridesFile, overrides);
}

/** A scope as a message names it. */
export function describeScope(scope: RouteOverrideScope): string {
  return scope.kind === "global" ? "globally" : `for ${scope.kind} ${JSON.stringify(scope.name)}`;
}

/** What one read of the overrides found: the table, or why it cannot be used (a class, a code or a validation summary, never the file's path or contents). */
export type RouteOverridesRead = { readonly table: RouteOverrides } | { readonly fault: string };

/** Why a parsed file is not the overrides, from its validation issues: each issue's path and message, which name keys and never values. */
function shapeFault(issues: readonly z.core.$ZodIssue[]): string {
  return `it is not the overrides file this release writes (${issues.map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`).join("; ")})`;
}

/** The revision of a file the port says does not exist. */
const ABSENT = Symbol("absent");

/**
 * A reader of the overrides for a process that consults them on every request it routes: the parse is kept with the file's revision (device, inode, size, modification and change times, as `FsPort.fileRevision` names it) taken before the read and again after it, and kept only when the two agree, so a request costs one stat while the file is unchanged, a change is read at the next request, and a read that raced a write is used for that request only. A missing file is no overrides. A file that exists and cannot be used (unreadable, not JSON, not this shape, or written by a newer release) is a fault the caller refuses requests with, logged once per revision by its class or code and never its path or contents.
 */
export function createRouteOverridesReader(fs: Readonly<Pick<FsPort, "fileRevision" | "readFileUtf8">>, file: string, log: (line: string) => void): () => RouteOverridesRead {
  let kept: { readonly revision: string; readonly read: RouteOverridesRead } | undefined;
  let loggedFor: string | undefined;
  // `absent` when the port says the file does not exist, undefined when it cannot say (no revisions, or a stat that failed), in which case the file is read and the read's own failure is the one reported.
  const revisionOf = (): string | typeof ABSENT | undefined => {
    if (fs.fileRevision === undefined) {
      return undefined;
    }
    try {
      return fs.fileRevision(file) ?? ABSENT;
    } catch {
      return undefined;
    }
  };
  const readNow = (): RouteOverridesRead => {
    let text: string | undefined;
    try {
      text = fs.readFileUtf8(file);
    } catch (error) {
      return { fault: `the route overrides file cannot be read (${catalogueReadFault(error)})` };
    }
    if (text === undefined) {
      return { table: NO_ROUTE_OVERRIDES };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { fault: "the route overrides file is not JSON" };
    }
    // A key this release does not know is ignored, as every configuration reader of this release ignores one (a newer release's setting), and doctor reports it.
    const result = parseIgnoringUnrecognisedKeys(RouteOverridesSchema, parsed);
    return result.success ? { table: result.data } : { fault: `the route overrides file cannot be used: ${shapeFault(result.issues)}` };
  };
  return () => {
    const before = revisionOf();
    if (before === ABSENT) {
      return { table: NO_ROUTE_OVERRIDES };
    }
    if (before !== undefined && kept?.revision === before) {
      return kept.read;
    }
    const read = readNow();
    if ("fault" in read && loggedFor !== (before ?? "")) {
      loggedFor = before ?? "";
      log(`front door: ${read.fault}; requests that would consult it are refused until it is fixed (agent-shim doctor)`);
    }
    if (before !== undefined && revisionOf() === before) {
      kept = { revision: before, read };
    }
    return read;
  };
}

/** A target with every naming of `kind` `from` renamed to `to`: an account target or a selector naming an identity, or a provider model, a bare provider name or a selector naming a provider. A selector whose word has no kind prefix is renamed when the word is `from`, since that word named it. */
function renamedTarget(target: string, kind: "identity" | "provider", from: string, to: string): string {
  const parsed = parseSelectorName(target);
  if (parsed !== undefined && !("refusal" in parsed)) {
    const { selector } = parsed;
    if (selector.name !== from || (selector.kind !== undefined && selector.kind !== kind)) {
      return target;
    }
    const prefix = `${SELECTOR_PREFIX}${selector.kind === undefined ? "" : `${selector.kind}:`}`;
    return `${prefix}${to}${target.slice(prefix.length + from.length)}`;
  }
  if (kind === "identity") {
    return target.startsWith(`acct:${from}/`) ? `acct:${to}/${target.slice(`acct:${from}/`.length)}` : target;
  }
  return target.startsWith(`${from}/`) ? `${to}/${target.slice(from.length + 1)}` : target === from ? to : target;
}

/**
 * The overrides with identity or provider `from` renamed to `to`, with what changed, or undefined when nothing names it: its scope table moves to the new name (its entries outranking any the new name's table already held) and every target that names it is rewritten. What `identity rename` and `provider rename` write.
 */
export function routeOverridesRenamed(overrides: Readonly<RouteOverrides>, kind: "identity" | "provider", from: string, to: string): { readonly value: RouteOverrides; readonly changes: readonly string[] } | undefined {
  const changes: string[] = [];
  const renameTable = (table: Readonly<OverrideTable>, where: string): OverrideTable => {
    const next = Object.fromEntries(Object.entries(table).map(([key, target]) => [key, renamedTarget(target, kind, from, to)] as const));
    if (Object.entries(next).some(([key, target]) => table[key] !== target)) {
      changes.push(where);
    }
    return next;
  };
  const renameTables = (tables: Readonly<Record<string, OverrideTable>> | undefined, field: string): Record<string, OverrideTable> | undefined => {
    if (tables === undefined) {
      return undefined;
    }
    const renamed = Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, renameTable(table, `${field} ${name}`)] as const));
    const moved = field === SCOPE_KEYS[kind] ? renamed[from] : undefined;
    if (moved === undefined) {
      return renamed;
    }
    changes.push(`${field} ${from} -> ${to}`);
    const rest = Object.fromEntries(Object.entries(renamed).filter(([name]) => name !== from));
    return { ...rest, [to]: { ...rest[to], ...moved } };
  };
  const global = overrides.global === undefined ? undefined : renameTable(overrides.global, "global");
  const providers = renameTables(overrides.providers, "providers");
  const identities = renameTables(overrides.identities, "identities");
  const sessions = renameTables(overrides.sessions, "sessions");
  if (changes.length === 0) {
    return undefined;
  }
  return { value: { ...overrides, ...(global === undefined ? {} : { global }), ...(providers === undefined ? {} : { providers }), ...(identities === undefined ? {} : { identities }), ...(sessions === undefined ? {} : { sessions }) }, changes };
}

/** One model name or class some covering scope overrides, as `check` and `model explain` report it: the entry that wins and the entries it outranks, each with its scope. */
export interface ApplyingOverride {
  readonly model: string;
  readonly target: string;
  readonly scope: string;
  readonly outranks: readonly { readonly scope: string; readonly target: string }[];
}

/** A scope as a report names it: `global`, or `<kind>:<name>`. */
export function scopeLabelOf(scope: RouteOverrideScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.name}`;
}

/**
 * Every key the scopes covering `ids` hold, each with the entry that wins for a request naming it and the ones that entry outranks, sorted by key. A class key's request is matched by the class entries alone, and an exact key's by its exact entries and its class's, as the door matches them.
 */
export function applyingOverrides(overrides: Readonly<RouteOverrides>, ids: Readonly<OverrideScopeIds>): readonly ApplyingOverride[] {
  const keys = new Set(scopesOf(ids).flatMap((scope) => Object.keys(tableOf(overrides, scope) ?? {})));
  return [...keys].sort().flatMap((model) => {
    const [winner, ...rest] = overrideMatches(overrides, ids, model);
    return winner === undefined ? [] : [{ model, target: winner.target, scope: scopeLabelOf(winner.scope), outranks: rest.map((match) => ({ scope: scopeLabelOf(match.scope), target: match.target })) }];
  });
}

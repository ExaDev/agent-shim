import { z } from "zod";

import categoriesDefaultJson from "../config/categories.default.json";
import { classifyEntries } from "../config/classify";
import { CategoryClassificationSchema, isOverridableCategory, type CategoryName, type ConfigProfile, type OverridableCategory, type WhenCondition } from "../config/schema";
import { resolveAll, resolveEntry, selectRule } from "../resolve/decide";
import { evaluateWhen, isDuration, matchBranch, parseDuration, type ConditionContext } from "../resolve/conditions";
import { lineariseProfile, profileLayers, type ProfileLoader, type ProfileSource } from "../resolve/extends";
import { flattenLayers, matchingRules } from "../resolve/flatten";
import { canonicaliseEntryKey, compareSpecificity, compileMatcher, isExactPattern, literalPrefixOf, normaliseRelative, patternCouldReachUnder } from "../resolve/match";
import { buildChildIndex, planFarm } from "../resolve/plan";
import { resolveDecisions, topLevelNames, type ResolvedState } from "../resolve/pipeline";
import { detectEncodingAmbiguity, encodeProjectPath, encodeProjectPattern, expandHome, splitOnWildcards } from "../resolve/projects";
import { planReconciliation, type ReconcileParams } from "../resolve/reconcile";
import type { CompiledRule, Decision, EntryFact, EntryFacts, FlattenedCascade, Layer } from "../resolve/types";
import { assembleCascade, walkDirectoryAncestors, type CascadeInput, type DirectoryLevelSources } from "../resolve/walk";
import type { CaseTable } from "../../conformance/runner/run.mjs";
import { ownEntry } from "../ownEntry";
import { numeric, optionalText, text } from "./args";

/**
 * A value a case gives as the plain data of a type the resolver defines: checked to be an object, and typed as that type. The resolver's own types have no schema of their own, since it reads values the configuration loader has already validated; a case's value is the data of a value that loader would have produced.
 */
const plain = <T>(): z.ZodType<T> => z.custom<T>((value) => typeof value === "object" && value !== null);

const TextListSchema = z.array(z.string());
const LayersSchema = z.array(plain<Layer>());
const WhenSchema = plain<WhenCondition>().optional();
const ContextSchema = plain<ConditionContext>();
const ReconcileSchema = plain<ReconcileParams>();
const RuleSchema = z.object({ canonicalPattern: z.string(), layer: z.number(), ordinal: z.number() });

/** What a case gives for a profile loader: the profiles it finds by name, each as `{ profile }` with an optional entry order and file path. A name it does not hold is not found. */
const ProfilesSchema = z.record(z.string(), z.object({ profile: plain<ConfigProfile>(), entryOrder: TextListSchema.optional(), filepath: z.string().optional() }));

/** The cascade input of `assembleCascade` as a case gives it: its data, with `profiles` in place of the loader function. */
const CascadeSchema = z.object({
  home: z.string(),
  globalConfig: plain<NonNullable<CascadeInput["globalConfig"]>>().optional(),
  baseConfigProfile: z.string().optional(),
  profiles: ProfilesSchema,
  levels: z.array(plain<DirectoryLevelSources>()).optional(),
  cliOverride: plain<NonNullable<CascadeInput["cliOverride"]>>().optional(),
});

/** The fact manifest of a case: the data of `EntryFacts`, with `entries` as `[relPath, fact]` pairs in the order the map holds them. */
const FactsSchema = z.object({
  nowMs: z.number(),
  home: z.string(),
  claudeHome: z.string(),
  cwd: z.string(),
  branch: z.string().optional(),
  branchDetached: z.boolean().optional(),
  env: z.record(z.string(), z.string().optional()),
  entries: z.array(z.tuple([z.string(), plain<EntryFact>()])),
});

/** The context `selectRule` reads. */
const SelectContextSchema = z.object({ nowMs: z.number(), env: z.record(z.string(), z.string().optional()), fact: plain<EntryFact>().optional(), branch: z.string().optional(), branchDetached: z.boolean().optional() });

/** The options of `walkDirectoryAncestors` as a case gives them: `unreadable` lists the directories its readable-directory predicate refuses, `allUnreadable` makes it refuse every one. */
const WalkOptionsSchema = z.object({ home: z.string(), limit: z.string().optional(), unreadable: TextListSchema.optional(), allUnreadable: z.boolean().optional() });

/** The shipped classification of the top-level names of `~/.claude`, which the resolver's tests use as the defaults. */
const SHIPPED_CLASSIFICATION = CategoryClassificationSchema.parse(categoriesDefaultJson);

function ruleOf(value: unknown): CompiledRule {
  const { canonicalPattern: pattern, layer, ordinal } = RuleSchema.parse(value);
  return {
    rawKey: `knowledge/${pattern}`,
    declaredCategory: "knowledge",
    canonicalPattern: pattern,
    value: true,
    layer,
    ordinal,
    isExact: isExactPattern(pattern),
    literalPrefix: literalPrefixOf(pattern),
    segmentCount: pattern.split("/").filter((segment) => segment !== "").length,
    matches: compileMatcher(pattern),
  };
}

function loaderOf(value: unknown): ProfileLoader {
  const held = ProfilesSchema.parse(value);
  return (name): ProfileSource | undefined => {
    const entry = ownEntry(held, name);
    return entry === undefined ? undefined : { name, profile: entry.profile, ...(entry.entryOrder === undefined ? {} : { entryOrder: entry.entryOrder }), ...(entry.filepath === undefined ? {} : { filepath: entry.filepath }) };
  };
}

function cascadeOf(value: unknown): CascadeInput {
  const parsed = CascadeSchema.parse(value);
  return {
    home: parsed.home,
    ...(parsed.globalConfig === undefined ? {} : { globalConfig: parsed.globalConfig }),
    ...(parsed.baseConfigProfile === undefined ? {} : { baseConfigProfile: parsed.baseConfigProfile }),
    loadProfile: loaderOf(parsed.profiles),
    ...(parsed.levels === undefined ? {} : { levels: parsed.levels }),
    ...(parsed.cliOverride === undefined ? {} : { cliOverride: parsed.cliOverride }),
  };
}

function factsOf(value: unknown): EntryFacts {
  const { entries, branch, branchDetached, ...rest } = FactsSchema.parse(value);
  return { ...rest, ...(branch === undefined ? {} : { branch }), ...(branchDetached === undefined ? {} : { branchDetached }), entries: new Map(entries) };
}

/** The value at a dotted path of keys, or undefined where the path ends. */
function at(value: unknown, dotted: string): unknown {
  let current: unknown = value;
  for (const key of dotted.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
}

/** Whether `actual` holds everything `expected` states: an object holds each member `expected` has (and may hold more), a list is equal member by member, anything else is the same value. */
function holds(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((member, index) => holds(actual[index], member));
  }
  if (typeof expected === "object" && expected !== null) {
    return typeof actual === "object" && actual !== null && !Array.isArray(actual) && Object.entries(expected).every(([key, member]) => holds(Reflect.get(actual, key), member));
  }
  return Object.is(actual, expected);
}

/** A rule as a case sees it: every member of the compiled rule but the matcher function. */
function ruleView(rule: CompiledRule): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => key !== "matches"));
}

/** A decision as a case sees it: every member, with its rules as `ruleView` shows them. */
function decisionView(decision: Decision | undefined): unknown {
  if (decision === undefined) {
    return undefined;
  }
  const { rule, eliminated, ...rest } = decision;
  return { ...rest, ...(rule === undefined ? {} : { rule: ruleView(rule) }), ...(eliminated === undefined ? {} : { eliminated: eliminated.map((entry) => ({ rule: ruleView(entry.rule), failed: entry.failed })) }) };
}

/** `flattenLayers` over the layers a case gives, as its tests call it. */
function flattened(layers: unknown, home: unknown): FlattenedCascade {
  return flattenLayers(LayersSchema.parse(layers), { home: text(home) });
}

/** What a case sees of a flattened cascade: the maps as lists of pairs in insertion order, the rules without their matchers. */
function flattenedView(result: FlattenedCascade): unknown {
  return { categories: [...result.categories], rules: [...result.rules].map(([pattern, rule]) => [pattern, ruleView(rule)]), launch: result.launch, models: result.models, diagnostics: result.diagnostics };
}

/** A category name a case gives, which is one a layer may toggle. */
function overridable(value: unknown): OverridableCategory {
  const name = text(value);
  if (!isOverridableCategory(name)) {
    throw new TypeError(`expected a category a layer may toggle, got ${name}`);
  }
  return name;
}

/** The classification of the top-level names the facts hold, from the shipped defaults, as the tests build it. */
function classificationOf(facts: EntryFacts): ReadonlyMap<string, CategoryName | null> {
  return classifyEntries(topLevelNames(facts), { defaults: SHIPPED_CLASSIFICATION }).classification;
}

/** `resolveEntry` over the layers and facts a case gives, flattened and classified as the tests do. */
function entryOf(relPath: unknown, layers: unknown, facts: unknown): ReturnType<typeof resolveEntry> {
  const held = factsOf(facts);
  return resolveEntry(text(relPath), { flattened: flattenLayers(LayersSchema.parse(layers), { home: held.home }), facts: held, classification: classificationOf(held) });
}

/** `resolveAll` over the layers and facts a case gives. */
function allOf(layers: unknown, facts: unknown): ReturnType<typeof resolveAll> {
  const held = factsOf(facts);
  return resolveAll({ flattened: flattenLayers(LayersSchema.parse(layers), { home: held.home }), facts: held, classification: classificationOf(held) });
}

/** `planFarm` over the layers and facts a case gives. */
function farmOf(layers: unknown, facts: unknown): ReturnType<typeof planFarm> {
  const held = factsOf(facts);
  const cascade = flattenLayers(LayersSchema.parse(layers), { home: held.home });
  return planFarm({ facts: held, decisions: resolveAll({ flattened: cascade, facts: held, classification: classificationOf(held) }).decisions, flattened: cascade });
}

/** `resolveDecisions` over what a case gives: the cascade input of `cascadeOf` and the facts, with the shipped classification. */
function stateOf(cascade: unknown, facts: unknown): ResolvedState {
  return resolveDecisions({ facts: factsOf(facts), cascade: cascadeOf(cascade), classification: { defaults: SHIPPED_CLASSIFICATION } });
}

/** The ambiguities of the fragments a case gives, with the existing project names when it gives them. */
function ambiguitiesOf(fragments: unknown, home: unknown, existingNames?: unknown): ReturnType<typeof detectEncodingAmbiguity> {
  return detectEncodingAmbiguity(TextListSchema.parse(fragments), { home: text(home), ...(existingNames === undefined ? {} : { existingNames: TextListSchema.parse(existingNames) }) });
}

/**
 * The functions of the cascade resolver, by the name a `function` case gives. A name with a dot after a function's own (`compareSpecificity.sign`) is that function read through one adapter, which returns what the original test asserted of the result, so that a case records no more than the test did.
 */
export const resolveTable: CaseTable = {
  // match
  canonicaliseEntryKey: (key, home) => canonicaliseEntryKey(text(key), { home: text(home) }),
  normaliseRelative: (fragment) => normaliseRelative(text(fragment)),
  isExactPattern: (pattern) => isExactPattern(text(pattern)),
  literalPrefixOf: (pattern) => literalPrefixOf(text(pattern)),
  compileMatcher: (pattern, relPath) => compileMatcher(text(pattern))(text(relPath)),
  patternCouldReachUnder: (pattern, dir) => patternCouldReachUnder(text(pattern), text(dir)),
  compareSpecificity: (left, right) => compareSpecificity(ruleOf(left), ruleOf(right)),
  "compareSpecificity.sign": (left, right) => Math.sign(compareSpecificity(ruleOf(left), ruleOf(right))),
  sortBySpecificity: (rules) =>
    z
      .array(z.unknown())
      .parse(rules)
      .map(ruleOf)
      .sort((a, b) => compareSpecificity(b, a))
      .map((rule) => rule.canonicalPattern),

  // projects
  encodeProjectPath: (realPath) => encodeProjectPath(text(realPath)),
  splitOnWildcards: (pattern) => splitOnWildcards(text(pattern)),
  expandHome: (fragment, home) => expandHome(text(fragment), text(home)),
  encodeProjectPattern: (fragment, home) => encodeProjectPattern(text(fragment), { home: text(home) }),
  detectEncodingAmbiguity: (fragments, home, existingNames) => ambiguitiesOf(fragments, home, existingNames),
  "detectEncodingAmbiguity.byReason": (fragments, home, reason) => ambiguitiesOf(fragments, home).filter((ambiguity) => ambiguity.reason === reason),
  "detectEncodingAmbiguity.hasReason": (fragments, home, reason) => ambiguitiesOf(fragments, home).some((ambiguity) => ambiguity.reason === reason),
  "detectEncodingAmbiguity.firstDetailContains": (fragments, home, existingNames, fragment) => ambiguitiesOf(fragments, home, existingNames)[0]?.detail.includes(text(fragment)) === true,

  // conditions
  parseDuration: (value) => parseDuration(text(value)),
  isDuration: (value) => isDuration(text(value)),
  matchBranch: (pattern, branch, detached) => matchBranch(text(pattern), optionalText(branch), detached === true),
  evaluateWhen: (when, context) => evaluateWhen(WhenSchema.parse(when), ContextSchema.parse(context)),
  "evaluateWhen.reasonContains": (when, context, fragment) => {
    const result = evaluateWhen(WhenSchema.parse(when), ContextSchema.parse(context));
    return result.status === "indeterminate" && result.reason.includes(text(fragment));
  },

  // extends
  lineariseProfile: (root, profiles) => lineariseProfile(text(root), loaderOf(profiles)),
  "lineariseProfile.diagnosticCodes": (root, profiles) => lineariseProfile(text(root), loaderOf(profiles)).diagnostics.map((diagnostic) => diagnostic.code),
  "lineariseProfile.hasDiagnostic": (root, profiles, code) => lineariseProfile(text(root), loaderOf(profiles)).diagnostics.some((diagnostic) => diagnostic.code === code),
  "lineariseProfile.countOf": (root, profiles, code) => lineariseProfile(text(root), loaderOf(profiles)).diagnostics.filter((diagnostic) => diagnostic.code === code).length,
  "lineariseProfile.messageContains": (root, profiles, code, fragment) => lineariseProfile(text(root), loaderOf(profiles)).diagnostics.find((diagnostic) => diagnostic.code === code)?.message.includes(text(fragment)) === true,
  "lineariseProfile.orderIsUnique": (root, profiles) => {
    const { order } = lineariseProfile(text(root), loaderOf(profiles));
    return new Set(order).size === order.length;
  },
  profileLayers: (root, profiles, startId) => profileLayers(text(root), loaderOf(profiles), numeric(startId)),
  "profileLayers.layerField": (root, profiles, startId, field) => profileLayers(text(root), loaderOf(profiles), numeric(startId)).layers.map((layer) => at(layer, text(field))),
  "profileLayers.firstLayer": (root, profiles, startId) => profileLayers(text(root), loaderOf(profiles), numeric(startId)).layers[0],

  // walk
  walkDirectoryAncestors: (cwd, options) => {
    const { home, limit, unreadable, allUnreadable } = WalkOptionsSchema.parse(options);
    const hidden = new Set(unreadable);
    return walkDirectoryAncestors(text(cwd), { home, ...(limit === undefined ? {} : { limit }), ...(unreadable === undefined && allUnreadable !== true ? {} : { isReadable: (dir: string) => allUnreadable !== true && !hidden.has(dir) }) });
  },
  "walkDirectoryAncestors.last": (cwd, options) => walkDirectoryAncestors(text(cwd), { home: WalkOptionsSchema.parse(options).home }).at(-1),
  assembleCascade: (input) => assembleCascade(cascadeOf(input)),
  "assembleCascade.layerField": (input, field) => assembleCascade(cascadeOf(input)).layers.map((layer) => at(layer, text(field))),
  "assembleCascade.diagnosticCodes": (input) => assembleCascade(cascadeOf(input)).diagnostics.map((diagnostic) => diagnostic.code),
  "assembleCascade.lastLayer": (input) => assembleCascade(cascadeOf(input)).layers.at(-1),
  "assembleCascade.firstLayerHolds": (input, expected) => holds(assembleCascade(cascadeOf(input)).layers[0], expected),

  // flatten
  flattenLayers: (layers, home) => flattenedView(flattened(layers, home)),
  "flattenLayers.category": (layers, home, name) => flattened(layers, home).categories.get(overridable(name)),
  "flattenLayers.hasCategory": (layers, home, name) => flattened(layers, home).categories.has(overridable(name)),
  "flattenLayers.ruleCount": (layers, home) => flattened(layers, home).rules.size,
  "flattenLayers.rule": (layers, home, pattern) => {
    const rule = flattened(layers, home).rules.get(text(pattern));
    return rule === undefined ? undefined : ruleView(rule);
  },
  "flattenLayers.diagnosticCodes": (layers, home) => flattened(layers, home).diagnostics.map((diagnostic) => diagnostic.code),
  "flattenLayers.diagnosticsOfCode": (layers, home, code) => flattened(layers, home).diagnostics.filter((diagnostic) => diagnostic.code === code),
  "flattenLayers.diagnostic": (layers, home, code) => flattened(layers, home).diagnostics.find((diagnostic) => diagnostic.code === code),
  "flattenLayers.hasLaunchField": (layers, home, name) => Object.hasOwn(flattened(layers, home).launch, text(name)),
  "flattenLayers.launchStatuslineHolds": (layers, home, expected) => holds(flattened(layers, home).launch.statusline, expected),
  matchingRules: (layers, home, relPath) => matchingRules(flattened(layers, home), text(relPath)).map((rule) => rule.canonicalPattern),

  // decide
  resolveEntry: (relPath, layers, facts) => {
    const result = entryOf(relPath, layers, facts);
    return { decision: decisionView(result.decision), diagnostics: result.diagnostics };
  },
  "resolveEntry.hasDiagnostic": (relPath, layers, facts, code) => entryOf(relPath, layers, facts).diagnostics.some((diagnostic) => diagnostic.code === code),
  selectRule: (relPath, layers, home, context) => {
    const selection = selectRule(text(relPath), flattened(layers, home), SelectContextSchema.parse(context));
    return { ...(selection.rule === undefined ? {} : { rule: ruleView(selection.rule) }), eliminated: selection.eliminated.map((entry) => ({ rule: ruleView(entry.rule), failed: entry.failed })) };
  },
  "resolveAll.decisionKeys": (layers, facts) => [...allOf(layers, facts).decisions.keys()].sort(),
  "resolveAll.hasDiagnostic": (layers, facts, code) => allOf(layers, facts).diagnostics.some((diagnostic) => diagnostic.code === code),
  "resolveAll.countOf": (layers, facts, code) => allOf(layers, facts).diagnostics.filter((diagnostic) => diagnostic.code === code).length,

  // plan
  planFarm: (layers, facts) => {
    const result = farmOf(layers, facts);
    return { entries: result.entries, materialised: result.materialised, links: result.links, dangling: result.dangling };
  },
  "planFarm.kindOf": (layers, facts, rel) => farmOf(layers, facts).entries.find((entry) => entry.rel === rel)?.kind,
  "planFarm.reasonOf": (layers, facts, rel) => {
    const entry = farmOf(layers, facts).entries.find((candidate) => candidate.rel === rel);
    return entry?.kind === "materialise" ? entry.reason : undefined;
  },
  "planFarm.hasEntryUnder": (layers, facts, prefix) => farmOf(layers, facts).entries.some((entry) => entry.rel.startsWith(text(prefix))),
  "planFarm.noneOmittedUnder": (layers, facts, prefix) => farmOf(layers, facts).entries.filter((entry) => entry.rel.startsWith(text(prefix))).every((entry) => entry.kind !== "omit"),
  "planFarm.linkRels": (layers, facts) => farmOf(layers, facts).links.map((link) => link.rel),
  "planFarm.hasLink": (layers, facts, link) => farmOf(layers, facts).links.some((candidate) => holds(candidate, link) && holds(link, candidate)),
  "planFarm.linkTargetsAreCanonical": (layers, facts, claudeHome) => farmOf(layers, facts).links.every((link) => link.target.startsWith(text(claudeHome)) && !link.target.includes("..")),
  "planFarm.precedes": (layers, facts, first, second) => {
    const rels = farmOf(layers, facts).entries.map((entry) => entry.rel);
    return rels.indexOf(text(first)) < rels.indexOf(text(second));
  },
  "buildChildIndex.get": (facts, key) => buildChildIndex(factsOf(facts)).get(text(key)),

  // reconcile
  planReconciliation: (params) => planReconciliation(plain<ReconcileParams>().parse(params)),
  "planReconciliation.actionFor": (params, rel) => planReconciliation(ReconcileSchema.parse(params)).actions.find((action) => action.rel === rel),
  "planReconciliation.actionsOfKind": (params, kind) => planReconciliation(ReconcileSchema.parse(params)).actions.filter((action) => action.kind === kind),
  "planReconciliation.hasDiagnostic": (params, code) => planReconciliation(ReconcileSchema.parse(params)).diagnostics.some((diagnostic) => diagnostic.code === code),

  // pipeline
  topLevelNames: (facts) => topLevelNames(factsOf(facts)),
  resolveDecisions: (cascade, facts) => {
    const state = stateOf(cascade, facts);
    return { assembled: state.assembled, flattened: flattenedView(state.flattened), decisions: [...state.decisions].map(([rel, decision]) => [rel, decisionView(decision)]), farm: state.farm, diagnostics: state.diagnostics };
  },
  "resolveDecisions.shared": (cascade, facts, rel) => stateOf(cascade, facts).decisions.get(text(rel))?.shared,
  "resolveDecisions.decision": (cascade, facts, rel) => decisionView(stateOf(cascade, facts).decisions.get(text(rel))),
  "resolveDecisions.hasDecision": (cascade, facts, rel) => stateOf(cascade, facts).decisions.has(text(rel)),
  "resolveDecisions.decisionsStartingWith": (cascade, facts, prefix) => [...stateOf(cascade, facts).decisions.keys()].filter((rel) => rel.startsWith(text(prefix))),
  "resolveDecisions.hasDiagnostic": (cascade, facts, code) => stateOf(cascade, facts).diagnostics.some((diagnostic) => diagnostic.code === code),
  "resolveDecisions.layerSources": (cascade, facts) => stateOf(cascade, facts).assembled.layers.map((layer) => layer.source),
  "resolveDecisions.rulePatternsContaining": (cascade, facts, fragment) => [...stateOf(cascade, facts).flattened.rules.keys()].filter((pattern) => pattern.includes(text(fragment))),
  "resolveDecisions.farmKind": (cascade, facts, rel) => stateOf(cascade, facts).farm.entries.find((entry) => entry.rel === rel)?.kind,
  "resolveDecisions.farmMaterialises": (cascade, facts, rel) => stateOf(cascade, facts).farm.materialised.includes(text(rel)),
  "resolveDecisions.hasLinkStartingWith": (cascade, facts, prefix) => stateOf(cascade, facts).farm.links.some((link) => link.rel.startsWith(text(prefix))),
  "resolveDecisions.hasLinkTo": (cascade, facts, rel) => stateOf(cascade, facts).farm.links.some((link) => link.rel === rel),
  "resolveDecisions.linkTargetsUnder": (cascade, facts, prefix) => stateOf(cascade, facts).farm.links.every((link) => link.target.startsWith(text(prefix))),
};

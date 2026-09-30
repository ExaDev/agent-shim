import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import * as clack from "@clack/prompts";

import { loadClassification } from "./config/classify";
import { cosmiconfigReader } from "./config/load";
import {
  OVERRIDABLE_CATEGORIES,
  PortableConfigSchema,
  SHIPPED_CATEGORY_DEFAULTS,
  type CategoryMap,
  type CategoryName,
  type Entries,
  type OverridableCategory,
} from "./config/schema";
import { applyPatch, readJson } from "./config/store";
import { withExamples, type CommandDeps } from "./cli/commandDeps";
import { CliError, UsageError } from "./cliError";
import { IdentityNotFoundError, readActiveIdentity, readIdentity } from "./identityManager";
import { readGlobalConfig, listProfiles, readProfile, setProfileCategories, setProfileEntries, createProfile } from "./configProfiles";
import { readDirectoryRules, writeDirectoryRules } from "./directoryRules";
import { loadCascadeInput, readDirectorySelections, PORTABLE_CONFIG_FILENAME, PORTABLE_LOCAL_CONFIG_FILENAME } from "./launcher/cascade";
import { buildEntryFacts } from "./launcher/farm";
import { decideConfigProfile, decideIdentity } from "./launcher/identity";
import type { LogPort } from "./launcher/ports";
import { expandTilde, isAncestorOrSelf, normaliseRulePath } from "./pathNorm";
import { resolveClaudeHome, type LayoutPaths } from "./paths";
import { realFarmFs, realRunPort, resolveGitBranch } from "./realPorts";
import { resolveDecisions } from "./resolve/pipeline";
import { walkDirectoryAncestors } from "./resolve/walk";
import type { Decision } from "./resolve/types";

/** Raised by `configure` when no configuration profile resolves for the identity at the working directory, so there is no tier-three file for a toggle to land in. */
export class NoConfigProfileResolvedError extends CliError {
  constructor(readonly identityName: string, readonly cwd: string) {
    super(
      `No configuration profile resolves for identity "${identityName}" at "${cwd}". Create one with ` +
        `\`claude-use profile add <name>\` and make it this identity's default with ` +
        `\`claude-use identity set ${identityName} --default-profile <name>\` before running \`configure\`.`,
    );
    this.name = "NoConfigProfileResolvedError";
  }
}

/** Raised by `configure` when standard input is not a terminal: every step of it is a prompt, so there is no non-interactive form to fall back to. */
export class ConfigureNeedsTerminalError extends UsageError {
  constructor() {
    super("`claude-use configure` is interactive and needs a terminal. From a script, use `claude-use profile set` or edit the files it writes.");
    this.name = "ConfigureNeedsTerminalError";
  }
}

/** Raised by `configure` when no `--identity` was given and nothing else (the environment, a directory pin, the active identity) resolves one. */
export class NoIdentityResolvedError extends UsageError {
  constructor(readonly cwd: string) {
    super(`No identity resolves in "${cwd}": pass --identity <name>, or select one with \`claude-use identity use <name>\`.`);
    this.name = "NoIdentityResolvedError";
  }
}

/* -------------------------------------------------------------------------------------------------- */
/* PromptsPort: the injectable abstraction around @clack/prompts.                                     */
/* -------------------------------------------------------------------------------------------------- */

/** One selectable option, shared by `select` and `multiselect`. */
interface PromptOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly hint?: string;
  /** Visible but not selectable — used for the `secret` category, which no configuration layer may ever toggle. */
  readonly disabled?: boolean;
}

/** Parameters shared by a single-select prompt. */
export interface SelectParams<Value extends string> {
  readonly message: string;
  readonly options: readonly PromptOption<Value>[];
  /** Which option the cursor starts on. Omit to let the prompt library fall back to its own default (the first option) — pass this explicitly whenever the safest or most common answer isn't the first one listed, so the on-screen reading order and the default-on-Enter answer can differ deliberately rather than being forced to match. */
  readonly initialValue?: Value;
}

/** Parameters for a multi-select prompt. */
export interface MultiselectParams<Value extends string> {
  readonly message: string;
  readonly options: readonly PromptOption<Value>[];
  readonly initialValues?: readonly Value[];
}

/** Parameters for a free-text prompt. */
export interface TextParams {
  readonly message: string;
  readonly placeholder?: string;
  /** Returns an error string to reject the value and re-prompt, or `undefined` to accept it. */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * The interactive-prompt surface `runConfigure` needs, abstracted so it can be driven by a scripted sequence of pre-programmed answers in tests instead of a real TTY — the same injected-ports pattern `src/launcher/ports.ts` already uses for the filesystem, spawn, and clock.
 *
 * `select`/`multiselect`/`text` resolve to a `symbol` when the user cancels (Ctrl-C), mirroring `@clack/prompts`' own cancellation contract exactly, so `isCancel` is the one place that distinguishes a real answer from a cancellation.
 */
export interface PromptsPort {
  readonly select: <Value extends string>(params: SelectParams<Value>) => Promise<Value | symbol>;
  readonly multiselect: <Value extends string>(params: MultiselectParams<Value>) => Promise<readonly Value[] | symbol>;
  readonly text: (params: TextParams) => Promise<string | symbol>;
  /** A type guard, mirroring `@clack/prompts`' own `isCancel` exactly, so a passing check narrows `Value | symbol` down to `Value` at every call site without a further cast. */
  readonly isCancel: (value: unknown) => value is symbol;
  readonly cancel: (message?: string) => void;
  readonly intro: (message?: string) => void;
  readonly outro: (message?: string) => void;
}

/**
 * Widens a `PromptOption<Value>[]` to plain `PromptOption<string>[]` (a legitimate widening — `Value extends string`, so every field already fits) before handing it to `@clack/prompts`. `Option<Value>` in `@clack/prompts`' own types is a conditional type keyed on whether `Value extends Primitive`, which TypeScript can only reduce once `Value` is a concrete type — calling `clack.select`/`clack.multiselect` with `string` (rather than our still-generic `Value`) gives it exactly that.
 */
function toClackOptions(options: readonly PromptOption<string>[]): { value: string; label: string; hint?: string; disabled?: boolean }[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.hint === undefined ? {} : { hint: option.hint }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
  }));
}

/** True when `value` is one of `options`' own literal values — every value `@clack/prompts` can possibly return came from the `options` array it was given, so this is a real, checkable narrowing back to `Value` rather than an assumed one. */
function isKnownOptionValue<Value extends string>(value: string, options: readonly PromptOption<Value>[]): value is Value {
  return options.some((option) => option.value === value);
}

export const realPromptsPort: PromptsPort = {
  select: async <Value extends string>(params: SelectParams<Value>) =>
    clack
      .select({
        message: params.message,
        options: toClackOptions(params.options),
        ...(params.initialValue === undefined ? {} : { initialValue: params.initialValue }),
      })
      .then((value): Value | symbol => {
        if (typeof value === "symbol" || isKnownOptionValue(value, params.options)) {
          return value;
        }
        throw new Error(`@clack/prompts select() returned a value not present in the given options: ${value}`);
      }),
  multiselect: async <Value extends string>(params: MultiselectParams<Value>) =>
    clack
      .multiselect({
        message: params.message,
        options: toClackOptions(params.options),
        ...(params.initialValues === undefined ? {} : { initialValues: [...params.initialValues] }),
      })
      .then((value): readonly Value[] | symbol => {
        if (typeof value === "symbol" || value.every((item) => isKnownOptionValue(item, params.options))) {
          return value;
        }
        throw new Error(`@clack/prompts multiselect() returned a value not present in the given options: ${value.join(", ")}`);
      }),
  text: async (params: TextParams) =>
    clack.text({
      message: params.message,
      ...(params.placeholder === undefined ? {} : { placeholder: params.placeholder }),
      ...(params.validate === undefined
        ? {}
        : {
            validate: (value: string | undefined) => params.validate?.(value ?? ""),
          }),
    }),
  isCancel: clack.isCancel,
  cancel: clack.cancel,
  intro: clack.intro,
  outro: clack.outro,
};

/* -------------------------------------------------------------------------------------------------- */
/* chooseWriteTarget: the 3-tier write-target precedence, pure and directly testable.                 */
/* -------------------------------------------------------------------------------------------------- */

/** Where one toggle should be written, per the README's "claude-use configure: which file it writes to" precedence. */
export type WriteTarget =
  | { readonly tier: "portable-local"; readonly localConfigPath: string }
  | { readonly tier: "directory-rule"; readonly rulePath: string }
  | { readonly tier: "config-profile"; readonly profileName: string };

/** One directory level's portable-config presence, shallowest-first — as produced by `walkDirectoryAncestors` plus a filesystem existence check at each level. */
export interface DirectoryLevelPresence {
  readonly dir: string;
  /** Whether a committed `.claude-use.json` already exists at this level. */
  readonly hasPortable: boolean;
  /** Whether a gitignored `.claude-use.local.json` already exists at this level, independent of whether a committed sibling does — this is what makes tier one apply even when only a personal local override was ever created, with no committed file alongside it. */
  readonly hasPortableLocal: boolean;
}

/** Inputs to `chooseWriteTarget`. */
export interface ChooseWriteTargetParams {
  readonly cwd: string;
  readonly home: string;
  /** `cwd`'s ancestor levels, shallowest-first, each flagged with whether a portable/portable-local file already exists there. */
  readonly levels: readonly DirectoryLevelPresence[];
  /** Every directory rule's own `path` field, exactly as written in `~/.claude-use/directory-rules.json` (not yet normalised). */
  readonly directoryRulePaths: readonly string[];
  /** The identity's resolved active configuration profile — the tier-three fallback. */
  readonly activeConfigProfile: string;
}

/**
 * Decides which file a `configure` toggle should be written into, in the exact three-tier precedence the README documents:
 *
 * 1. If `$PWD` is inside a directory covered by a committed `.claude-use.json`, or a `.claude-use.local.json` already exists there (even without a committed sibling), the toggle goes into `.claude-use.local.json` in that same directory — the deepest such directory, when more than one ancestor qualifies.
 * 2. Otherwise, if an existing directory rule in the user's own `directory-rules.json` already applies to `$PWD` (its `path`, once resolved, is an ancestor of or equal to `$PWD`), the toggle is written into that rule — the most specific (longest-resolved-path) matching rule, when more than one applies.
 * 3. Otherwise, the toggle is written into the identity's own active configuration profile.
 *
 * Never touches a filesystem or a config file itself — every input is already gathered by the caller, which is what makes this function directly unit-testable with synthetic levels and rule paths.
 */
export function chooseWriteTarget(params: ChooseWriteTargetParams): WriteTarget {
  for (let index = params.levels.length - 1; index >= 0; index -= 1) {
    const level = params.levels[index];
    if (level !== undefined && (level.hasPortable || level.hasPortableLocal)) {
      return { tier: "portable-local", localConfigPath: path.join(level.dir, PORTABLE_LOCAL_CONFIG_FILENAME) };
    }
  }

  const normalisedCwd = normaliseRulePath(params.cwd, params.home);
  let bestRulePath: string | undefined;
  let bestRuleNormalised: string | undefined;
  for (const rulePath of params.directoryRulePaths) {
    const normalisedRule = normaliseRulePath(rulePath, params.home);
    if (!isAncestorOrSelf(normalisedRule, normalisedCwd)) {
      continue;
    }
    if (bestRuleNormalised === undefined || normalisedRule.length > bestRuleNormalised.length) {
      bestRulePath = rulePath;
      bestRuleNormalised = normalisedRule;
    }
  }
  if (bestRulePath !== undefined) {
    return { tier: "directory-rule", rulePath: bestRulePath };
  }

  return { tier: "config-profile", profileName: params.activeConfigProfile };
}

/** Renders a `WriteTarget` as a short, human-readable description for `configure`'s own confirmation output. */
export function describeWriteTarget(target: WriteTarget): string {
  switch (target.tier) {
    case "portable-local":
      return `local override file "${target.localConfigPath}"`;
    case "directory-rule":
      return `directory rule for "${target.rulePath}"`;
    case "config-profile":
      return `configuration profile "${target.profileName}"`;
    default:
      return target satisfies never;
  }
}

/* -------------------------------------------------------------------------------------------------- */
/* Writing a resolved patch to whichever target chooseWriteTarget picked.                              */
/* -------------------------------------------------------------------------------------------------- */

function writeCategoryPatch(paths: LayoutPaths, target: WriteTarget, patch: Readonly<CategoryMap>): void {
  switch (target.tier) {
    case "portable-local": {
      const existing = readJson(target.localConfigPath, PortableConfigSchema) ?? {};
      const merged: CategoryMap = { ...existing.categories, ...patch };
      applyPatch(target.localConfigPath, PortableConfigSchema, { categories: merged }, { defaults: {} });
      return;
    }
    case "directory-rule": {
      const rules = readDirectoryRules(paths);
      const index = rules.rules.findIndex((rule) => rule.path === target.rulePath);
      const existingRule = index === -1 ? undefined : rules.rules[index];
      if (existingRule === undefined) {
        throw new Error(`Directory rule for "${target.rulePath}" no longer exists.`);
      }
      const merged: CategoryMap = { ...existingRule.categories, ...patch };
      const nextRules = [...rules.rules];
      nextRules[index] = { ...existingRule, categories: merged };
      writeDirectoryRules(paths, { ...rules, rules: nextRules });
      return;
    }
    case "config-profile":
      setProfileCategories(paths, target.profileName, patch);
      return;
  }
}

function writeEntriesPatch(paths: LayoutPaths, target: WriteTarget, patch: Readonly<Record<string, boolean>>): void {
  switch (target.tier) {
    case "portable-local": {
      const existing = readJson(target.localConfigPath, PortableConfigSchema) ?? {};
      const merged: Entries = { ...existing.entries, ...patch };
      applyPatch(target.localConfigPath, PortableConfigSchema, { entries: merged }, { defaults: {} });
      return;
    }
    case "directory-rule": {
      const rules = readDirectoryRules(paths);
      const index = rules.rules.findIndex((rule) => rule.path === target.rulePath);
      const existingRule = index === -1 ? undefined : rules.rules[index];
      if (existingRule === undefined) {
        throw new Error(`Directory rule for "${target.rulePath}" no longer exists.`);
      }
      const merged: Entries = { ...existingRule.entries, ...patch };
      const nextRules = [...rules.rules];
      nextRules[index] = { ...existingRule, entries: merged };
      writeDirectoryRules(paths, { ...rules, rules: nextRules });
      return;
    }
    case "config-profile":
      setProfileEntries(paths, target.profileName, patch);
      return;
  }
}

/* -------------------------------------------------------------------------------------------------- */
/* runConfigure: the two interactive modes.                                                            */
/* -------------------------------------------------------------------------------------------------- */

/** Everything `runConfigure` needs beyond the identity/path the user typed. */
export interface RunConfigureDeps {
  readonly paths: LayoutPaths;
  readonly prompts: PromptsPort;
  readonly log: Pick<LogPort, "info">;
}

/** Inputs to `runConfigure` beyond its injected dependencies. */
export interface RunConfigureParams {
  readonly identityName: string;
  /** A real `~/.claude`-relative path (never category-prefixed — that prefix is an entries-*key* convention, not a filesystem path). Given: entries mode. Omitted: categories mode. */
  readonly path?: string;
  readonly cwd: string;
  readonly home: string;
  readonly claudeHome: string;
}

function parentOf(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}

function buildWriteTargetLevels(cwd: string, home: string, walkUpLimit: string | undefined): readonly DirectoryLevelPresence[] {
  const limit = walkUpLimit === undefined ? undefined : expandTilde(walkUpLimit, home);
  const dirs = walkDirectoryAncestors(cwd, { home, ...(limit === undefined ? {} : { limit }) });
  return dirs.map((dir) => ({
    dir,
    hasPortable: fs.existsSync(path.join(dir, PORTABLE_CONFIG_FILENAME)),
    hasPortableLocal: fs.existsSync(path.join(dir, PORTABLE_LOCAL_CONFIG_FILENAME)),
  }));
}

/** Everything real-world resolution needs to drive either of `runConfigure`'s two modes — assembled once so both modes share the same resolved cascade and write-target computation. */
interface ConfigureContext {
  readonly deps: RunConfigureDeps;
  readonly params: RunConfigureParams;
  readonly activeConfigProfile: string;
  readonly categoryOverrides: ReadonlyMap<OverridableCategory, boolean>;
  readonly decisions: ReadonlyMap<string, Decision>;
  readonly levels: readonly DirectoryLevelPresence[];
  readonly directoryRulePaths: readonly string[];
}

function resolveWriteTarget(context: ConfigureContext): WriteTarget {
  return chooseWriteTarget({
    cwd: context.params.cwd,
    home: context.params.home,
    levels: context.levels,
    directoryRulePaths: context.directoryRulePaths,
    activeConfigProfile: context.activeConfigProfile,
  });
}

/** Builds a complete `Record<OverridableCategory, boolean>` in one literal shot from a partial lookup plus shipped defaults — never an incrementally-filled object, so there is no need to assert its shape before every key lands. */
function resolveCategoryState(get: (name: OverridableCategory) => boolean | undefined): Record<OverridableCategory, boolean> {
  return {
    runtime: get("runtime") ?? SHIPPED_CATEGORY_DEFAULTS.runtime,
    history: get("history") ?? SHIPPED_CATEGORY_DEFAULTS.history,
    knowledge: get("knowledge") ?? SHIPPED_CATEGORY_DEFAULTS.knowledge,
    settings: get("settings") ?? SHIPPED_CATEGORY_DEFAULTS.settings,
  };
}

function currentCategoryState(context: ConfigureContext): Record<OverridableCategory, boolean> {
  return resolveCategoryState((name) => context.categoryOverrides.get(name));
}

/**
 * Builds the real-world `ConfigureContext` `runConfigure` drives its two modes from: the identity's own file, the configuration profile that resolves for it at `cwd`, the resolved cascade for `cwd`, and everything `chooseWriteTarget` needs to decide where a toggle should land.
 *
 * This is the one function in this module that performs real I/O (reading identities, profiles, directory rules, the real `~/.claude` tree via `realFarmFs`, and `git`/environment facts) — everything downstream of it (the two mode functions, `chooseWriteTarget` itself) is either pure or driven purely by the injected `PromptsPort`.
 */
function buildConfigureContext(deps: RunConfigureDeps, params: RunConfigureParams): ConfigureContext {
  const identity = readIdentity(deps.paths, params.identityName);
  if (identity === undefined) {
    throw new IdentityNotFoundError(params.identityName);
  }

  const read = cosmiconfigReader();
  const classification = loadClassification(deps.paths);

  const globalConfig = readGlobalConfig(deps.paths);
  const preliminary = loadCascadeInput({ paths: deps.paths, home: params.home, cwd: params.cwd, read });
  const selections = readDirectorySelections(preliminary);

  const configProfileDecision = decideConfigProfile({
    env: process.env,
    directoryRuleConfigProfile: selections.configProfile,
    identityDefaultConfigProfile: identity.defaultConfigProfile,
    globalDefaultConfigProfile: globalConfig?.defaultConfigProfile,
  });

  if (configProfileDecision.name === undefined) {
    throw new NoConfigProfileResolvedError(params.identityName, params.cwd);
  }
  const activeConfigProfile = configProfileDecision.name;

  const cascade = loadCascadeInput({
    paths: deps.paths,
    home: params.home,
    cwd: params.cwd,
    read,
    baseConfigProfile: activeConfigProfile,
  }).input;

  const git = resolveGitBranch(realRunPort, params.cwd);
  const facts = buildEntryFacts({
    fs: realFarmFs,
    claudeHome: params.claudeHome,
    home: params.home,
    cwd: params.cwd,
    nowMs: Date.now(),
    env: process.env,
    ...(git.branch === undefined ? {} : { branch: git.branch }),
    ...(git.branchDetached === undefined ? {} : { branchDetached: git.branchDetached }),
  });

  const resolved = resolveDecisions({ facts, cascade, classification });

  const levels = buildWriteTargetLevels(params.cwd, params.home, globalConfig?.walkUpLimit);
  const directoryRulePaths = readDirectoryRules(deps.paths).rules.map((rule) => rule.path);

  return {
    deps,
    params,
    activeConfigProfile,
    categoryOverrides: resolved.flattened.categories,
    decisions: resolved.decisions,
    levels,
    directoryRulePaths,
  };
}

/** One entries-mode candidate: a direct child of the given path, with its own resolved sharing state. */
interface ChildEntry {
  readonly relPath: string;
  readonly name: string;
  readonly category: CategoryName;
  readonly shared: boolean;
}

function childEntriesOf(decisions: ReadonlyMap<string, Decision>, parentPath: string): readonly ChildEntry[] {
  const children: ChildEntry[] = [];
  for (const [relPath, decision] of decisions) {
    if (parentOf(relPath) !== parentPath || decision.category === null) {
      continue;
    }
    children.push({
      relPath,
      name: relPath.slice(parentPath.length + 1),
      category: decision.category,
      shared: decision.shared,
    });
  }
  return children.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

const CATEGORY_LABELS: Record<"secret" | OverridableCategory, string> = {
  secret: "secret",
  runtime: "runtime",
  history: "history",
  knowledge: "knowledge",
  settings: "settings",
};

/* -------------------------------------------------------------------------------------------------- */
/* runProfileWizard: the unified create-or-edit flow.                                                  */
/* -------------------------------------------------------------------------------------------------- */

/** A profile name must match the same shape as an identity name (`IdentitySchema`): start alphanumeric, then alphanumerics/dots/dashes/underscores/at signs. The `@` allowance moves in lockstep with the identity schema because `runIdentityWizard` offers the identity's own name as the default profile name — an email-shaped identity would otherwise suggest a profile name its own validator rejects. */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/** Validates a candidate profile name for the wizard's text prompt: non-empty, matches the allowed shape, and (only when `existingNames` is given) not already taken. */
export function validateProfileName(value: string, existingNames?: readonly string[]): string | undefined {
  if (value.length === 0) {
    return "A name is required.";
  }
  if (!PROFILE_NAME_RE.test(value)) {
    return "Names must start with a letter or digit, and contain only letters, digits, dots, dashes, underscores, and at signs.";
  }
  if (existingNames?.includes(value) ?? false) {
    return `A configuration profile named "${value}" already exists.`;
  }
  return undefined;
}

/**
 * Inputs to `runProfileWizard` beyond the injected prompt/log ports. Split out so the launch path (which only has a `LayoutPaths`, not a full `ConfigureContext`) can call the wizard too.
 *
 * A discriminated union over three modes:
 * - `{ existingName }`: edit an existing profile's categories.
 * - `{ createName }`: create a new profile with this exact name (no name prompt), then choose categories. Used by the launch path, where the name is already decided.
 * - `{ defaultNewName? }`: create a new profile, prompting for a name first (with an optional pre-filled default). Used by the manual commands.
 */
export type RunProfileWizardParams =
  | { readonly paths: LayoutPaths; readonly existingName: string }
  | { readonly paths: LayoutPaths; readonly createName: string }
  | { readonly paths: LayoutPaths; readonly defaultNewName?: string };

/** What `runProfileWizard` produced. */
export interface ProfileWizardResult {
  readonly name: string;
  readonly created: boolean;
}

/**
 * The unified create-or-edit flow for a configuration profile: one guided prompt sequence covering both cases that would otherwise split across a bare `profile add` (empty, no categories) and `configure`'s "edit a profile directly" branch (categories only, profile must already exist).
 *
 * Given an `existingName`: edits that profile's categories in place via a multiselect, seeded from its current values. Given a `createName`: creates the empty file with that exact name, no name prompt, then runs the category multiselect. Given neither: prompts for a name first (validated against the allowed shape and against every existing profile name), creates the empty file, then runs the same multiselect. Either way, a cancel at any prompt writes nothing and returns `undefined` — the caller decides what to do (e.g. the launch path proceeds without the profile, the manual command just stops).
 *
 * Driven entirely by the injected `PromptsPort` so the whole flow is unit-testable with a scripted sequence of answers, the same way `runConfigure` already is.
 */
export async function runProfileWizard(
  prompts: PromptsPort,
  params: RunProfileWizardParams,
): Promise<ProfileWizardResult | undefined> {
  let name: string;
  let created: boolean;

  if ("existingName" in params) {
    name = params.existingName;
    created = false;
  } else if ("createName" in params) {
    name = params.createName;
    createProfile(params.paths, name);
    created = true;
  } else {
    const existing = listProfiles(params.paths).map((entry) => entry.name);
    const entered = await prompts.text({
      message: "Name for the new configuration profile:",
      ...(params.defaultNewName === undefined ? {} : { placeholder: params.defaultNewName }),
      validate: (value) => validateProfileName(value, existing),
    });
    if (prompts.isCancel(entered)) {
      prompts.cancel("Cancelled.");
      return undefined;
    }
    name = entered;
    createProfile(params.paths, name);
    created = true;
  }

  const profile = readProfile(params.paths, name) ?? {};
  const current = resolveCategoryState((categoryName) => profile.categories?.[categoryName]);

  const selected = await prompts.multiselect({
    message: `Which categories should configuration profile "${name}" share?`,
    options: OVERRIDABLE_CATEGORIES.map((categoryName) => ({
      value: categoryName,
      label: CATEGORY_LABELS[categoryName],
      hint: current[categoryName] ? "currently shared" : "currently hidden",
    })),
    initialValues: OVERRIDABLE_CATEGORIES.filter((categoryName) => current[categoryName]),
  });
  if (prompts.isCancel(selected)) {
    prompts.cancel("Cancelled.");
    return undefined;
  }

  const patch: CategoryMap = {};
  for (const categoryName of OVERRIDABLE_CATEGORIES) {
    const nowShared = selected.includes(categoryName);
    if (nowShared !== current[categoryName]) {
      patch[categoryName] = nowShared;
    }
  }
  if (Object.keys(patch).length > 0) {
    setProfileCategories(params.paths, name, patch);
  }
  return { name, created };
}

async function runProfileDirectMode(context: ConfigureContext): Promise<void> {
  const { deps } = context;
  const profiles = listProfiles(deps.paths);
  if (profiles.length === 0) {
    deps.log.info("No configuration profiles exist yet. Run `claude-use profile add <name>` first.");
    return;
  }

  const chosen = await deps.prompts.select({
    message: "Which configuration profile do you want to edit directly?",
    options: profiles.map((entry) => ({ value: entry.name, label: entry.name })),
  });
  if (deps.prompts.isCancel(chosen)) {
    deps.prompts.cancel("Cancelled.");
    return;
  }

  const profile = readProfile(deps.paths, chosen) ?? {};
  const current = resolveCategoryState((name) => profile.categories?.[name]);

  const selected = await deps.prompts.multiselect({
    message: `Which categories should configuration profile "${chosen}" share?`,
    options: OVERRIDABLE_CATEGORIES.map((name) => ({
      value: name,
      label: CATEGORY_LABELS[name],
      hint: current[name] ? "currently shared" : "currently hidden",
    })),
    initialValues: OVERRIDABLE_CATEGORIES.filter((name) => current[name]),
  });
  if (deps.prompts.isCancel(selected)) {
    deps.prompts.cancel("Cancelled.");
    return;
  }

  const patch: CategoryMap = {};
  for (const name of OVERRIDABLE_CATEGORIES) {
    const nowShared = selected.includes(name);
    if (nowShared !== current[name]) {
      patch[name] = nowShared;
    }
  }
  if (Object.keys(patch).length === 0) {
    deps.log.info("No changes.");
    return;
  }
  setProfileCategories(deps.paths, chosen, patch);
  deps.log.info(`Updated configuration profile "${chosen}".`);
}

async function runCategoriesMode(context: ConfigureContext): Promise<void> {
  const { deps } = context;

  const action = await deps.prompts.select({
    message: `Configure identity "${context.params.identityName}"`,
    options: [
      { value: "toggle" as const, label: "Toggle top-level categories for the resolved state" },
      { value: "profile" as const, label: "Edit a specific configuration profile directly" },
    ],
  });
  if (deps.prompts.isCancel(action)) {
    deps.prompts.cancel("Cancelled.");
    return;
  }
  if (action === "profile") {
    await runProfileDirectMode(context);
    return;
  }

  const current = currentCategoryState(context);
  const selected = await deps.prompts.multiselect({
    message: "Which categories should be shared?",
    options: [
      { value: "secret" as const, label: CATEGORY_LABELS.secret, hint: "never shared, cannot be toggled", disabled: true },
      ...OVERRIDABLE_CATEGORIES.map((name) => ({
        value: name,
        label: CATEGORY_LABELS[name],
        hint: current[name] ? "currently shared" : "currently hidden",
      })),
    ],
    initialValues: OVERRIDABLE_CATEGORIES.filter((name) => current[name]),
  });
  if (deps.prompts.isCancel(selected)) {
    deps.prompts.cancel("Cancelled.");
    return;
  }

  const patch: CategoryMap = {};
  for (const name of OVERRIDABLE_CATEGORIES) {
    const nowShared = selected.includes(name);
    if (nowShared !== current[name]) {
      patch[name] = nowShared;
    }
  }
  if (Object.keys(patch).length === 0) {
    deps.log.info("No changes.");
    return;
  }

  const target = resolveWriteTarget(context);
  writeCategoryPatch(deps.paths, target, patch);
  deps.log.info(`Updated categories via ${describeWriteTarget(target)}.`);
}

async function runEntriesMode(context: ConfigureContext, entriesPath: string): Promise<void> {
  const { deps } = context;
  const children = childEntriesOf(context.decisions, entriesPath);
  if (children.length === 0) {
    deps.log.info(`No entries found under "${entriesPath}".`);
    return;
  }

  const selected = await deps.prompts.multiselect({
    message: `Which entries under "${entriesPath}" should be shared?`,
    options: children.map((child) => ({
      value: child.relPath,
      label: child.name,
      hint: child.shared ? "currently shared" : "currently hidden",
    })),
    initialValues: children.filter((child) => child.shared).map((child) => child.relPath),
  });
  if (deps.prompts.isCancel(selected)) {
    deps.prompts.cancel("Cancelled.");
    return;
  }

  const patch: Record<string, boolean> = {};
  for (const child of children) {
    const nowShared = selected.includes(child.relPath);
    if (nowShared !== child.shared) {
      patch[`${child.category}/${child.relPath}`] = nowShared;
    }
  }
  if (Object.keys(patch).length === 0) {
    deps.log.info("No changes.");
    return;
  }

  const target = resolveWriteTarget(context);
  writeEntriesPatch(deps.paths, target, patch);
  deps.log.info(`Updated entries via ${describeWriteTarget(target)}.`);
}

/**
 * Runs `claude-use configure [path] --identity <name>`'s interactive flow.
 *
 * Two modes, exactly per the README's "claude-use configure: which file it writes to" section:
 *
 * - No `path`: shows the identity's resolved top-level categories (the only mode that ever touches categories), plus an option to edit a named configuration profile's own stored values directly instead.
 * - Given a `path` (a real `~/.claude`-relative path, never category-prefixed): shows that path's direct children with their resolved sharing state, for fine-grained entries overrides. Never shows or edits categories.
 *
 * Every actual toggle (in either mode, other than the "edit a profile directly" branch, which is an explicit target the user chose) is written via `chooseWriteTarget`'s three-tier precedence.
 */
export async function runConfigure(deps: RunConfigureDeps, params: RunConfigureParams): Promise<void> {
  const context = buildConfigureContext(deps, params);
  if (params.path === undefined) {
    await runCategoriesMode(context);
  } else {
    await runEntriesMode(context, params.path);
  }
}

/** Registers `claude-use configure [path] [--identity <name>]` onto `program`. */
export function registerConfigureCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const command = program
    .command("configure [path]")
    .description(
      "Interactively toggle an identity's shared categories, or the entries under one ~/.claude-relative path, writing to whichever file the 3-tier precedence selects.",
    )
    .option("--identity <name>", "Identity to configure (defaults to the identity a launch here would resolve).")
    .action(async (pathArg: string | undefined, options: Readonly<{ identity?: string }>) => {
      const cwd = process.cwd();
      if (!deps.isInteractive()) {
        throw new ConfigureNeedsTerminalError();
      }
      const identityName = options.identity ?? resolveLaunchIdentity(paths, cwd);
      if (identityName === undefined) {
        throw new NoIdentityResolvedError(cwd);
      }
      await runConfigure(
        { paths, prompts: deps.prompts, log: { info: (message: string) => { console.log(message); } } },
        {
          identityName,
          ...(pathArg === undefined ? {} : { path: pathArg }),
          cwd,
          home: os.homedir(),
          claudeHome: resolveClaudeHome(),
        },
      );
    });
  withExamples(command, ["claude-use configure", "claude-use configure --identity work", "claude-use configure projects --identity work"]);
}

/** The identity a launch in `cwd` would resolve with no `@name` or `--identity`: `CLAUDE_USE_IDENTITY`, then a directory pin, then the active identity. Undefined when none applies, or when `CLAUDE_CONFIG_DIR` bypasses identity resolution. */
function resolveLaunchIdentity(paths: LayoutPaths, cwd: string): string | undefined {
  const loaded = loadCascadeInput({ paths, home: os.homedir(), cwd, read: cosmiconfigReader() });
  return decideIdentity({
    env: process.env,
    directoryPinnedIdentity: readDirectorySelections(loaded).identity,
    readActiveIdentityFile: () => readActiveIdentity(paths),
  }).name;
}

import { readJson, writeJsonAtomic } from "./config/store";
import { ConfigValidationError } from "./config/load";
import { DirectoryRulesSchema, POOL_SELECTOR_PREFIX, type DirectoryRule, type DirectoryRules } from "./config/schema";
import { CliError } from "./cliError";
import { IdentityNotFoundError, readIdentity } from "./identityStore";
import { PoolNotFoundError, readPools } from "./poolStore";
import type { LayoutPaths } from "./paths";

/** Raised by `removeDirectoryRule`, `updateDirectoryRule` and `rule show` when no rule matches the given path exactly. */
export class DirectoryRuleNotFoundError extends CliError {
  constructor(readonly rulePath: string) {
    super(`No directory rule found for path "${rulePath}".`);
    this.name = "DirectoryRuleNotFoundError";
  }
}

/** Raised by `addDirectoryRule` when neither `--config-profile` nor `--identity` is given, and by `updateDirectoryRule` when an update would leave a rule that sets nothing at all: a rule that pins and overrides nothing would do nothing. */
export class DirectoryRuleMissingTargetError extends CliError {
  constructor() {
    super("A directory rule must set at least one of --config-profile or --identity.");
    this.name = "DirectoryRuleMissingTargetError";
  }
}

/** Raised by `addDirectoryRule` when a rule for the exact path already exists: `rule add` creates, `rule set` updates. */
export class DirectoryRuleAlreadyExistsError extends CliError {
  constructor(readonly rulePath: string) {
    super(`A directory rule for path "${rulePath}" already exists. Use \`agent-shim rule set\` to change it.`);
    this.name = "DirectoryRuleAlreadyExistsError";
  }
}

/** Reads `~/.agent-shim/directory-rules.json`, or an empty rule set when the file does not exist yet. */
export function readDirectoryRules(paths: LayoutPaths): DirectoryRules {
  return readJson(paths.directoryRulesFile, DirectoryRulesSchema) ?? { rules: [] };
}

/** Validates and writes the whole `~/.agent-shim/directory-rules.json` file. Exported so `src/configure.ts` can update a single rule's `categories`/`entries` in place without duplicating this validate-then-write step. Throws `ConfigValidationError` when `rules` fails `DirectoryRulesSchema`, rather than letting the underlying `ZodError` escape as an unhandled crash. */
export function writeDirectoryRules(paths: LayoutPaths, rules: DirectoryRules): void {
  const parsed = DirectoryRulesSchema.safeParse(rules);
  if (!parsed.success) {
    throw new ConfigValidationError(paths.directoryRulesFile, parsed.error.issues);
  }
  writeJsonAtomic(paths.directoryRulesFile, parsed.data);
}

/** Lists every directory rule, in file order. */
export function listDirectoryRules(paths: LayoutPaths): readonly DirectoryRule[] {
  return readDirectoryRules(paths).rules;
}

/** Inputs to `addDirectoryRule` beyond the path itself. */
export interface AddDirectoryRuleOptions {
  readonly configProfile?: string;
  readonly identity?: string;
}

/**
 * Adds a new directory rule for `rulePath`. Throws `DirectoryRuleAlreadyExistsError` when a rule for that exact path already exists (`updateDirectoryRule` changes one), and `DirectoryRuleMissingTargetError` when neither `configProfile` nor `identity` is given, since a rule that pins neither would do nothing.
 */
export function addDirectoryRule(paths: LayoutPaths, rulePath: string, options: AddDirectoryRuleOptions): DirectoryRule {
  if (options.configProfile === undefined && options.identity === undefined) {
    throw new DirectoryRuleMissingTargetError();
  }
  const current = readDirectoryRules(paths);
  if (current.rules.some((rule) => rule.path === rulePath)) {
    throw new DirectoryRuleAlreadyExistsError(rulePath);
  }
  const created = buildNewRule(rulePath, options);
  writeDirectoryRules(paths, { ...current, rules: [...current.rules, created] });
  return created;
}

/** The fields `updateDirectoryRule` changes. A value of `false` removes that field from the rule. */
export interface UpdateDirectoryRuleOptions {
  readonly configProfile?: string | false;
  readonly identity?: string | false;
}

/** Whether `rule` still does anything: pins a profile or identity, or carries its own categories, entries or launch settings (which `agent-shim configure` writes). */
function ruleHasEffect(rule: DirectoryRule): boolean {
  return (
    rule.configProfile !== undefined ||
    rule.identity !== undefined ||
    rule.categories !== undefined ||
    rule.entries !== undefined ||
    rule.launch !== undefined
  );
}

/**
 * Updates the existing directory rule for `rulePath` in place, keeping its position in the file and every field not named. Throws `DirectoryRuleNotFoundError` when no rule matches that exact path, and `DirectoryRuleMissingTargetError` when the update would leave a rule that does nothing (remove it with `removeDirectoryRule` instead).
 */
export function updateDirectoryRule(paths: LayoutPaths, rulePath: string, options: UpdateDirectoryRuleOptions): DirectoryRule {
  const current = readDirectoryRules(paths);
  const index = current.rules.findIndex((rule) => rule.path === rulePath);
  const existing = index === -1 ? undefined : current.rules[index];
  if (existing === undefined) {
    throw new DirectoryRuleNotFoundError(rulePath);
  }
  const { configProfile, identity, ...rest } = existing;
  const nextConfigProfile = options.configProfile === undefined ? configProfile : options.configProfile === false ? undefined : options.configProfile;
  const nextIdentity = options.identity === undefined ? identity : options.identity === false ? undefined : options.identity;
  const updated: DirectoryRule = {
    ...rest,
    ...(nextConfigProfile === undefined ? {} : { configProfile: nextConfigProfile }),
    ...(nextIdentity === undefined ? {} : { identity: nextIdentity }),
  };
  if (!ruleHasEffect(updated)) {
    throw new DirectoryRuleMissingTargetError();
  }
  const nextRules = [...current.rules];
  nextRules[index] = updated;
  writeDirectoryRules(paths, { ...current, rules: nextRules });
  return updated;
}

function buildNewRule(rulePath: string, options: AddDirectoryRuleOptions): DirectoryRule {
  return {
    path: rulePath,
    ...(options.configProfile !== undefined ? { configProfile: options.configProfile } : {}),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
  };
}

/** Removes the directory rule for `rulePath`. Throws `DirectoryRuleNotFoundError` when no rule matches that exact path. */
export function removeDirectoryRule(paths: LayoutPaths, rulePath: string): void {
  const current = readDirectoryRules(paths);
  const nextRules = current.rules.filter((rule) => rule.path !== rulePath);
  if (nextRules.length === current.rules.length) {
    throw new DirectoryRuleNotFoundError(rulePath);
  }
  writeDirectoryRules(paths, { ...current, rules: nextRules });
}

/** Throws when `selector` names an identity or pool that does not exist, since pinning a path to a selector nothing can load would only fail at the next launch there. A `pool:<name>` selector is checked against the pool table, anything else against the identities. */
export function requireRuleSelector(paths: LayoutPaths, selector: string): void {
  if (selector.startsWith(POOL_SELECTOR_PREFIX)) {
    const poolName = selector.slice(POOL_SELECTOR_PREFIX.length);
    if (readPools(paths)[poolName] === undefined) {
      throw new PoolNotFoundError(poolName);
    }
  } else if (readIdentity(paths, selector) === undefined) {
    throw new IdentityNotFoundError(selector);
  }
}

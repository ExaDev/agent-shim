import fs from "node:fs";
import path from "node:path";
import { applyPatch, readJson, writeJsonAtomic } from "./config/store";
import { ConfigProfileSchema, expandAllCategoryKey, GlobalConfigSchema, isOverridableCategory, type CategoryMap, type ConfigProfile, type Entries, type GlobalConfig, type LaunchFlags } from "./config/schema";
import { CliError } from "./cliError";
import { ConfigValidationError } from "./config/load";
import type { LayoutPaths } from "./paths";

/** Raised by any operation that requires a configuration profile to already exist, when it does not. */
export class ProfileNotFoundError extends CliError {
  constructor(readonly profileName: string) {
    super(`No configuration profile named "${profileName}". Run \`agent-shim profile add ${profileName}\` first.`);
    this.name = "ProfileNotFoundError";
  }
}

/** Raised by `createProfile` (`profile add`) when a profile with the given name already has a file. */
export class ProfileAlreadyExistsError extends CliError {
  constructor(readonly profileName: string) {
    super(`A configuration profile named "${profileName}" already exists.`);
    this.name = "ProfileAlreadyExistsError";
  }
}

/** Raised when a `--category` patch names something other than one of the four overridable categories (e.g. `secret`, or a typo). */
export class InvalidCategoryNameError extends CliError {
  constructor(readonly categoryName: string) {
    super(`"${categoryName}" is not a category a configuration profile may toggle (runtime, history, knowledge, settings).`);
    this.name = "InvalidCategoryNameError";
  }
}

function profileJsonPath(paths: LayoutPaths, name: string): string {
  return path.join(paths.configProfilesDir, `${name}.json`);
}

/** True when a profile file exists for `name`, regardless of whether it validates. */
export function profileExists(paths: LayoutPaths, name: string): boolean {
  return fs.existsSync(profileJsonPath(paths, name));
}

export function requireProfileExists(paths: LayoutPaths, name: string): void {
  if (!profileExists(paths, name)) {
    throw new ProfileNotFoundError(name);
  }
}

/** Reads and validates one configuration profile, or undefined when it does not exist. */
export function readProfile(paths: LayoutPaths, name: string): ConfigProfile | undefined {
  return readJson(profileJsonPath(paths, name), ConfigProfileSchema);
}

/**
 * Creates a new configuration profile, empty apart from the optional `extends` list and description. Throws `ProfileAlreadyExistsError` if a profile with this name already has a file, and `ConfigValidationError` when the result fails `ConfigProfileSchema` (e.g. an empty `--extends ""` name), rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function createProfile(
  paths: LayoutPaths,
  name: string,
  extendsList?: readonly string[],
  description?: string,
): ConfigProfile {
  if (profileExists(paths, name)) {
    throw new ProfileAlreadyExistsError(name);
  }
  const filePath = profileJsonPath(paths, name);
  const parsed = ConfigProfileSchema.safeParse({
    ...(description === undefined ? {} : { description }),
    ...(extendsList !== undefined && extendsList.length > 0 ? { extends: [...extendsList] } : {}),
  });
  if (!parsed.success) {
    throw new ConfigValidationError(filePath, parsed.error.issues);
  }
  writeJsonAtomic(filePath, parsed.data);
  return parsed.data;
}

/** One profile as reported by `listProfiles`. */
export interface ProfileListEntry {
  readonly name: string;
  readonly profile: ConfigProfile;
}

/** Lists every configuration profile under `configProfilesDir` that has a valid `<name>.json`. */
export function listProfiles(paths: LayoutPaths): readonly ProfileListEntry[] {
  if (!fs.existsSync(paths.configProfilesDir)) {
    return [];
  }
  const names = fs
    .readdirSync(paths.configProfilesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort();

  const result: ProfileListEntry[] = [];
  for (const name of names) {
    const profile = readProfile(paths, name);
    if (profile !== undefined) {
      result.push({ name, profile });
    }
  }
  return result;
}

function globalConfigPath(paths: LayoutPaths): string {
  return paths.globalConfigFile;
}

/** Reads the user-global `~/.agent-shim/config.json`, or undefined when it does not exist. */
export function readGlobalConfig(paths: LayoutPaths): GlobalConfig | undefined {
  return readJson(globalConfigPath(paths), GlobalConfigSchema);
}

/** Sets the user-global default configuration profile in `~/.agent-shim/config.json`, creating the file if it doesn't exist yet. Whether the profile exists is the caller's concern: `profile use` checks it first. */
export function setGlobalDefaultProfile(paths: LayoutPaths, name: string): GlobalConfig {
  return applyPatch(
    globalConfigPath(paths),
    GlobalConfigSchema,
    { defaultConfigProfile: name },
    { defaults: {} },
  );
}

function validateCategoryNames(patch: Readonly<Record<string, boolean>>): void {
  for (const key of Object.keys(patch)) {
    if (!isOverridableCategory(key)) {
      throw new InvalidCategoryNameError(key);
    }
  }
}

/**
 * Merges `patch` (from one or more `--category cat=bool` flags) into `profile`'s own `categories` object and writes it back.
 *
 * Throws `InvalidCategoryNameError` for any key that isn't one of the four overridable categories — `secret` can never be toggled by any configuration layer, this included.
 */
export function setProfileCategories(
  paths: LayoutPaths,
  name: string,
  patch: Readonly<Record<string, boolean>>,
): ConfigProfile {
  requireProfileExists(paths, name);
  const expandedPatch = expandAllCategoryKey(patch);
  validateCategoryNames(expandedPatch);
  const existing = readProfile(paths, name) ?? {};
  const mergedCategories: CategoryMap = { ...existing.categories, ...expandedPatch };
  return applyPatch(profileJsonPath(paths, name), ConfigProfileSchema, { categories: mergedCategories });
}

/**
 * Merges `patch` (from one or more `--entry "path"=bool` flags) into `profile`'s own `entries` object and writes it back.
 *
 * Key validity (the `<category>/<real-relative-path>` prefix requirement) is enforced by `ConfigProfileSchema`'s own `EntriesSchema` at write time — an invalid key surfaces as the usual `ConfigValidationError`.
 */
export function setProfileEntries(paths: LayoutPaths, name: string, patch: Readonly<Record<string, boolean>>): ConfigProfile {
  requireProfileExists(paths, name);
  const existing = readProfile(paths, name) ?? {};
  const mergedEntries: Entries = { ...existing.entries, ...patch };
  return applyPatch(profileJsonPath(paths, name), ConfigProfileSchema, { entries: mergedEntries });
}

/**
 * Merges `patch` into `profile`'s own `launch` object and writes it back. A key present in `patch` with the value `undefined` removes that setting outright (a `--no-launch-provider`, say) rather than overwriting it, and a `launch` object left with no settings is removed too.
 */
export function setProfileLaunchFlags(paths: LayoutPaths, name: string, patch: Readonly<LaunchFlags>): ConfigProfile {
  requireProfileExists(paths, name);
  const existing = readProfile(paths, name) ?? {};
  const mergedLaunch: LaunchFlags = { ...existing.launch, ...patch };
  return applyPatch(profileJsonPath(paths, name), ConfigProfileSchema, {
    // Read as `unknown` so the check sees the `undefined` a cleared key holds, which LaunchFlags' optional properties hide from the value type.
    launch: Object.values<unknown>(mergedLaunch).every((value) => value === undefined) ? undefined : mergedLaunch,
  });
}

/** Replaces `profile`'s own `extends` list and/or description; an empty list or an undefined description removes the field. */
export function setProfileMetadata(
  paths: LayoutPaths,
  name: string,
  patch: Readonly<{ extends?: readonly string[]; description?: string | false }>,
): ConfigProfile {
  requireProfileExists(paths, name);
  return applyPatch(profileJsonPath(paths, name), ConfigProfileSchema, {
    ...(patch.extends === undefined ? {} : { extends: patch.extends.length === 0 ? undefined : [...patch.extends] }),
    ...(patch.description === undefined ? {} : { description: patch.description === false ? undefined : patch.description }),
  });
}

/** Deletes a configuration profile's file. Throws `ProfileNotFoundError` when it does not exist. Nothing that references it by name is rewritten; `agent-shim doctor` reports any identity default, directory rule or `extends` left pointing at it. */
export function removeProfile(paths: LayoutPaths, name: string): void {
  requireProfileExists(paths, name);
  fs.rmSync(profileJsonPath(paths, name));
}

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { applyPatch, readJson, writeJsonAtomic } from "./config/store";
import {
  ConfigProfileSchema,
  expandAllCategoryKey,
  GlobalConfigSchema,
  isOverridableCategory,
  type CategoryMap,
  type ConfigProfile,
  type Entries,
  type GlobalConfig,
  type LaunchFlags,
} from "./config/schema";
import { collectBoolPairs } from "./cli/parsers";
import { CliError } from "./cliError";
import { ConfigValidationError } from "./config/load";
import { realPromptsPort, runProfileWizard } from "./configure";
import type { LayoutPaths } from "./paths";

/** Raised by any operation that requires a configuration profile to already exist, when it does not. */
export class ProfileNotFoundError extends CliError {
  constructor(readonly profileName: string) {
    super(`No configuration profile named "${profileName}" — run \`claude-use profile create ${profileName}\` first.`);
    this.name = "ProfileNotFoundError";
  }
}

/** Raised by `createProfile` when a profile with the given name already has a file. */
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

function requireProfileExists(paths: LayoutPaths, name: string): void {
  if (!profileExists(paths, name)) {
    throw new ProfileNotFoundError(name);
  }
}

/** Reads and validates one configuration profile, or undefined when it does not exist. */
export function readProfile(paths: LayoutPaths, name: string): ConfigProfile | undefined {
  return readJson(profileJsonPath(paths, name), ConfigProfileSchema);
}

/**
 * Creates a new, empty configuration profile (optionally extending others). Throws `ProfileAlreadyExistsError` if a profile with this name already has a file, and `ConfigValidationError` when `extendsList` fails `ConfigProfileSchema` (e.g. contains an empty name from a stray `,,` in `--extends`), rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function createProfile(paths: LayoutPaths, name: string, extendsList?: readonly string[]): ConfigProfile {
  if (profileExists(paths, name)) {
    throw new ProfileAlreadyExistsError(name);
  }
  const filePath = profileJsonPath(paths, name);
  const parsed = ConfigProfileSchema.safeParse(
    extendsList !== undefined && extendsList.length > 0 ? { extends: [...extendsList] } : {},
  );
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

/** Reads the user-global `~/.claude-use/config.json`, or undefined when it does not exist. */
export function readGlobalConfig(paths: LayoutPaths): GlobalConfig | undefined {
  return readJson(globalConfigPath(paths), GlobalConfigSchema);
}

/** Sets the user-global default configuration profile in `~/.claude-use/config.json`, creating the file if it doesn't exist yet. */
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

/** Merges `patch` into `profile`'s own `launch` object and writes it back. */
export function setProfileLaunchFlags(paths: LayoutPaths, name: string, patch: Readonly<LaunchFlags>): ConfigProfile {
  requireProfileExists(paths, name);
  const existing = readProfile(paths, name) ?? {};
  const mergedLaunch: LaunchFlags = { ...existing.launch, ...patch };
  return applyPatch(profileJsonPath(paths, name), ConfigProfileSchema, { launch: mergedLaunch });
}

interface ProfileSetOptions {
  readonly category?: Record<string, boolean>;
  readonly entry?: Record<string, boolean>;
  readonly skipPermissions?: boolean;
  readonly remoteControl?: boolean;
  readonly headroom?: boolean;
}

/** Registers the `claude-use profile` subcommand tree onto `program`. */
export function registerProfileCommand(program: Command, paths: LayoutPaths): void {
  const profile = program.command("profile").description("Manage claude-use configuration profiles.");

  profile
    .command("create <name>")
    .description("Create a new, empty configuration profile.")
    .option("--extends <names>", "Comma-separated list of profile names this one extends.")
    .action((name: string, options: Readonly<{ extends?: string }>) => {
      const extendsList = options.extends !== undefined && options.extends !== "" ? options.extends.split(",") : undefined;
      createProfile(paths, name, extendsList);
      console.log(`Created configuration profile "${name}".`);
    });

  profile
    .command("wizard [name]")
    .description(
      "Interactively create a new configuration profile and choose its categories, or edit an existing one's categories.",
    )
    .action(async (name: string | undefined) => {
      const result = await runProfileWizard(
        realPromptsPort,
        name === undefined
          ? { paths }
          : profileExists(paths, name)
            ? { paths, existingName: name }
            : { paths, createName: name },
      );
      if (result === undefined) {
        return;
      }
      console.log(
        result.created
          ? `Created configuration profile "${result.name}".`
          : `Updated configuration profile "${result.name}".`,
      );
    });

  profile
    .command("list")
    .description("List every configuration profile.")
    .action(() => {
      const entries = listProfiles(paths);
      if (entries.length === 0) {
        console.log("No configuration profiles yet. Run `claude-use profile create <name>` to create one.");
        return;
      }
      for (const entry of entries) {
        const extendsSuffix =
          entry.profile.extends !== undefined && entry.profile.extends.length > 0
            ? ` (extends ${entry.profile.extends.join(", ")})`
            : "";
        console.log(`  ${entry.name}${extendsSuffix}`);
      }
    });

  profile
    .command("set-default <name>")
    .description("Set the user-global default configuration profile.")
    .action((name: string) => {
      setGlobalDefaultProfile(paths, name);
      console.log(`Global default configuration profile is now "${name}".`);
    });

  profile
    .command("set <name>")
    .description("Update a configuration profile's categories, entries, or launch flags.")
    .option(
      "--category <pairs>",
      "Comma-separated <category>=<bool> pairs (repeatable).",
      collectBoolPairs,
    )
    .option("--entry <pairs>", "Comma-separated <path>=<bool> pairs (repeatable).", collectBoolPairs)
    .option("--skip-permissions", "Set this profile's skipPermissions launch flag to true.")
    .option("--no-skip-permissions", "Set this profile's skipPermissions launch flag to false.")
    .option("--remote-control", "Set this profile's remoteControl launch flag to true.")
    .option("--no-remote-control", "Set this profile's remoteControl launch flag to false.")
    .option("--headroom", "Set this profile's headroom launch flag to true.")
    .option("--no-headroom", "Set this profile's headroom launch flag to false.")
    .action((name: string, options: ProfileSetOptions) => {
      requireProfileExists(paths, name);
      let touched = false;
      if (options.category !== undefined) {
        setProfileCategories(paths, name, options.category);
        touched = true;
      }
      if (options.entry !== undefined) {
        setProfileEntries(paths, name, options.entry);
        touched = true;
      }
      const launchPatch: LaunchFlags = {};
      if (options.skipPermissions !== undefined) {
        launchPatch.skipPermissions = options.skipPermissions;
      }
      if (options.remoteControl !== undefined) {
        launchPatch.remoteControl = options.remoteControl;
      }
      if (options.headroom !== undefined) {
        launchPatch.headroom = options.headroom;
      }
      if (Object.keys(launchPatch).length > 0) {
        setProfileLaunchFlags(paths, name, launchPatch);
        touched = true;
      }
      if (!touched) {
        console.log("Nothing to change: pass --category, --entry, --skip-permissions, --remote-control, or --headroom.");
        return;
      }
      console.log(`Updated configuration profile "${name}".`);
    });
}

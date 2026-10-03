import path from "node:path";

import { loadConfigFile, type ConfigFileReader } from "../config/load";
import {
  ConfigProfileSchema,
  DirectoryRulesSchema,
  GlobalConfigSchema,
  PortableConfigSchema,
  type GlobalConfig,
} from "../config/schema";
import { expandTilde, normaliseRulePath } from "../pathNorm";
import { walkDirectoryAncestors, type CascadeInput, type DirectoryLevelSources, type ReadablePredicate } from "../resolve/walk";
import type { ProfileSource } from "../resolve/extends";
import { LEGACY_PORTABLE_CONFIG_FILENAME, LEGACY_PORTABLE_LOCAL_CONFIG_FILENAME } from "../legacy";
import type { LayoutPaths } from "../paths";

/** The committed, team-shared portable config file name. A level with none falls back to the former `.claude-use.json`, and likewise for the local file, see `src/legacy.ts`. */
export const PORTABLE_CONFIG_FILENAME = ".agent-shim.json";
/** Its gitignored, per-clone personal sibling. */
export const PORTABLE_LOCAL_CONFIG_FILENAME = ".agent-shim.local.json";

/** Inputs to `loadCascadeInput`. */
export interface LoadCascadeInputParams {
  readonly paths: LayoutPaths;
  readonly home: string;
  /** The directory the cascade is being resolved for — already a real path, since resolving symlinks is the caller's job. */
  readonly cwd: string;
  readonly read: ConfigFileReader;
  readonly isReadable?: ReadablePredicate;
  /** The configuration profile the launcher's own precedence rules chose. */
  readonly baseConfigProfile?: string;
  readonly cliOverride?: CascadeInput["cliOverride"];
}

/** An assembled cascade input plus the global config it was built from, which the caller also needs for its own defaults. */
export interface LoadedCascade {
  readonly input: CascadeInput;
  readonly globalConfig?: GlobalConfig;
}

/**
 * Loads every configuration file one launch's cascade is built from, and assembles them into the `CascadeInput` the pure resolver consumes.
 *
 * This is the only place file reading and cascade composition meet. Everything it produces is already-loaded data: `src/resolve/` never opens a file, and this module never decides what any of it means.
 *
 * Files are read with `loadConfigFile`, which wraps cosmiconfig's `load(filepath)` — never its `search()`, which stops at the first config found while walking upward. This design needs the exact opposite: every ancestor collected, shallowest-first, each one composing on top of the last.
 */
export function loadCascadeInput(params: LoadCascadeInputParams): LoadedCascade {
  const globalConfig = loadConfigFile(params.paths.globalConfigFile, GlobalConfigSchema, params.read);
  const directoryRules = loadConfigFile(params.paths.directoryRulesFile, DirectoryRulesSchema, params.read);

  const loadProfile = (name: string): ProfileSource | undefined => {
    const filepath = path.join(params.paths.configProfilesDir, `${name}.json`);
    const loaded = loadConfigFile(filepath, ConfigProfileSchema, params.read);
    if (loaded === undefined) {
      return undefined;
    }
    return { name, profile: loaded.config, entryOrder: loaded.entryOrder, filepath: loaded.filepath };
  };

  const limit = globalConfig?.config.walkUpLimit;
  const dirs = walkDirectoryAncestors(params.cwd, {
    home: params.home,
    ...(limit === undefined ? {} : { limit: expandTilde(limit, params.home) }),
    ...(params.isReadable === undefined ? {} : { isReadable: params.isReadable }),
  });

  const levels: DirectoryLevelSources[] = [];
  for (const dir of dirs) {
    const portable = loadConfigFile(path.join(dir, PORTABLE_CONFIG_FILENAME), PortableConfigSchema, params.read) ?? loadConfigFile(path.join(dir, LEGACY_PORTABLE_CONFIG_FILENAME), PortableConfigSchema, params.read);
    const portableLocal = loadConfigFile(path.join(dir, PORTABLE_LOCAL_CONFIG_FILENAME), PortableConfigSchema, params.read) ?? loadConfigFile(path.join(dir, LEGACY_PORTABLE_LOCAL_CONFIG_FILENAME), PortableConfigSchema, params.read);
    const rules = (directoryRules?.config.rules ?? [])
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => normaliseRulePath(rule.path, params.home) === dir)
      .map(({ rule, index }) => {
        const entryOrder = directoryRules?.ruleEntryOrders[index];
        return {
          rule,
          ...(entryOrder === undefined ? {} : { entryOrder }),
          filepath: params.paths.directoryRulesFile,
        };
      });

    if (portable === undefined && portableLocal === undefined && rules.length === 0) {
      continue;
    }
    levels.push({
      dir,
      ...(portable === undefined ? {} : { portable: { config: portable.config, entryOrder: portable.entryOrder, filepath: portable.filepath } }),
      ...(rules.length === 0 ? {} : { rules }),
      ...(portableLocal === undefined
        ? {}
        : { portableLocal: { config: portableLocal.config, entryOrder: portableLocal.entryOrder, filepath: portableLocal.filepath } }),
    });
  }

  const input: CascadeInput = {
    home: params.home,
    ...(globalConfig === undefined
      ? {}
      : { globalConfig: { config: globalConfig.config, entryOrder: globalConfig.entryOrder, filepath: globalConfig.filepath } }),
    ...(params.baseConfigProfile === undefined ? {} : { baseConfigProfile: params.baseConfigProfile }),
    loadProfile,
    levels,
    ...(params.cliOverride === undefined ? {} : { cliOverride: params.cliOverride }),
  };

  return { input, ...(globalConfig === undefined ? {} : { globalConfig: globalConfig.config }) };
}

/**
 * Reads the deepest directory-level `identity` pin and `configProfile` selection that apply to a directory, without resolving the cascade.
 *
 * The launcher needs both *before* it can resync a farm — which identity a directory pins decides which farm there is to resync, and which profile it selects is an input to resolving that farm's contents — so they cannot come out of the resolved cascade itself.
 */
export function readDirectorySelections(loaded: LoadedCascade): { identity?: string; configProfile?: string } {
  let identity: string | undefined;
  let configProfile: string | undefined;
  for (const level of loaded.input.levels ?? []) {
    for (const source of [level.portable?.config, ...(level.rules ?? []).map((entry) => entry.rule), level.portableLocal?.config]) {
      if (source === undefined) {
        continue;
      }
      if (source.identity !== undefined) {
        identity = source.identity;
      }
      if (source.configProfile !== undefined) {
        configProfile = source.configProfile;
      }
    }
  }
  return { ...(identity === undefined ? {} : { identity }), ...(configProfile === undefined ? {} : { configProfile }) };
}

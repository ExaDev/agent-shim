import os from "node:os";

import { cosmiconfigReader } from "./config/load";
import { loadCascadeInput, readDirectorySelections, type LoadedCascade } from "./launcher/cascade";
import { memberProviderResolver } from "./launcher/memberProvider";
import type { LayoutPaths } from "./paths";
import { realFsPort } from "./realPorts";
import type { ProviderOf } from "./usage/poolPick";

/** What the provider of each pool member's launch from a directory is decided from, on this machine. */
export interface RealMemberProviderParams {
  readonly paths: LayoutPaths;
  /** The directory the launch would run in: its cascade selects the provider and the configuration profile. */
  readonly cwd: string;
  /** The environment the launch inherits, which can name a configuration profile. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The launch's `--provider` flag: a provider name, `false` for `--no-provider`, undefined when neither was given. */
  readonly cliProvider?: string | false;
  /** The configuration profile the launch's flag names. */
  readonly cliFlagConfigProfile?: string;
  /** The cascade of `cwd`, when the caller has already loaded it. */
  readonly loaded?: LoadedCascade;
}

/**
 * `memberProviderResolver` over this machine's real files: the cascade of `params.cwd` is read once for its directory selections and again, per configuration profile, as a launch reads it for the identity it runs as. Used by every read-only report of what a pool launch would pick, so each ranks the pool on the quota the launch itself would spend.
 */
export function realMemberProviderResolver(params: Readonly<RealMemberProviderParams>): ProviderOf {
  const home = os.homedir();
  const read = cosmiconfigReader();
  const loaded = params.loaded ?? loadCascadeInput({ paths: params.paths, home, cwd: params.cwd, read });
  const selections = readDirectorySelections(loaded);
  return memberProviderResolver({
    paths: params.paths,
    fs: realFsPort,
    env: params.env,
    cliProvider: params.cliProvider,
    ...(params.cliFlagConfigProfile === undefined ? {} : { cliFlagConfigProfile: params.cliFlagConfigProfile }),
    ...(selections.configProfile === undefined ? {} : { directoryRuleConfigProfile: selections.configProfile }),
    ...(loaded.globalConfig?.defaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: loaded.globalConfig.defaultConfigProfile }),
    loadCascade: (baseConfigProfile) => loadCascadeInput({ paths: params.paths, home, cwd: params.cwd, read, ...(baseConfigProfile === undefined ? {} : { baseConfigProfile }) }).input,
  });
}

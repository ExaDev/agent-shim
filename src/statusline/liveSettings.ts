import { STATUSLINE_ENV, type StatuslineSettings } from "../config/statusline";
import { assembleCascade } from "../resolve/walk";
import { flattenLayers } from "../resolve/flatten";
import { loadCascadeInput, readDirectorySelections } from "../launcher/cascade";
import { decideConfigProfile, loadIdentity } from "../launcher/identity";
import type { FsPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { identityOf } from "./enrich";
import { checkedStatusline, statuslineSettingsFromEnv } from "./settings";

/** What `statuslineSettingsForRender` needs from the process that draws one line. */
export interface StatuslineRenderInputs {
  /** The session's environment, as the client passed it down: the launch's variables are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The session's working directory, which is the project path the cascade is resolved for. A real path, as a launch's is. */
  readonly cwd: string;
  readonly home: string;
  readonly paths: LayoutPaths;
  /** Reads the config files, and the identity file among them. The statusline gives each render a reader of its own, since a shared one caches every file it loads. */
  readonly fs: FsPort;
}

/** The settings one render draws with. */
export interface StatuslineRenderSettings {
  /** Absent when nothing sets any, or when the config could not be used, in which case the statusline draws with its defaults. */
  readonly settings: StatuslineSettings | undefined;
  /** Why the config could not be used, when it could not. */
  readonly problem?: string;
}

/**
 * The settings one statusline render draws with: `AGENT_SHIM_STATUSLINE` (an empty one counts as unset) when the launch exported one, which keeps its priority and its strictness (a value that is not valid settings throws), and otherwise the `launch.statusline` the cascade resolves now, so an edit to a config file shows on the next render and not only in sessions launched afterwards.
 *
 * The cascade is the one a launch in this session would use. The identity is the one the launch pinned, read from the session's environment (`identityOf`), because the client runs the statusline with the session's environment and not the launcher's; a session that names none uses no identity's default configuration profile. The project path is `cwd`, which the client sets to the session's working directory. The configuration profile is decided in the launcher's own order, from `AGENT_SHIM_CONFIG_PROFILE`, the directory rules, that identity's default and the global default; a `--config-profile` flag typed on the launch's command line is not in the session's environment, so a launch that used one draws with the profile the other sources choose.
 *
 * The line is redrawn on every message and must always draw, so a config that cannot be loaded or does not validate is returned as `problem`, with no settings, and never thrown.
 */
export function statuslineSettingsForRender(inputs: StatuslineRenderInputs): StatuslineRenderSettings {
  const fromEnv = inputs.env[STATUSLINE_ENV] === "" ? undefined : inputs.env[STATUSLINE_ENV];
  if (fromEnv !== undefined) {
    return { settings: statuslineSettingsFromEnv(fromEnv, STATUSLINE_ENV) };
  }
  try {
    return { settings: statuslineSettingsFromCascade(inputs) };
  } catch (error) {
    return { settings: undefined, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The checked `launch.statusline` of the cascade a launch in this session would assemble, or undefined when no layer sets any. */
function statuslineSettingsFromCascade(inputs: StatuslineRenderInputs): StatuslineSettings | undefined {
  const { env, cwd, home, paths, fs } = inputs;
  const loaded = loadCascadeInput({ paths, home, cwd, read: fs.readConfigFile });
  const identity = identityOf(env);
  const identityConfig = identity === undefined ? undefined : loadIdentity(paths.identitiesDir, identity, fs);
  const configProfile = decideConfigProfile({
    env,
    directoryRuleConfigProfile: readDirectorySelections(loaded).configProfile,
    identityDefaultConfigProfile: identityConfig?.config.defaultConfigProfile,
    globalDefaultConfigProfile: loaded.globalConfig?.defaultConfigProfile,
  });
  // The files are read again only when a profile joins the cascade: without one, the cascade just loaded is the whole of it.
  const cascade = configProfile.name === undefined ? loaded.input : loadCascadeInput({ paths, home, cwd, read: fs.readConfigFile, baseConfigProfile: configProfile.name }).input;
  const assembled = assembleCascade(cascade);
  // A launch refuses a cascade whose profile chain is broken (a profile that is missing, or that extends itself), so a line drawn from the layers that did load would show settings no launch would run with.
  const broken = assembled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (broken.length > 0) {
    throw new Error(broken.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; "));
  }
  const statusline = flattenLayers(assembled.layers, { home }).launch.statusline;
  return statusline === undefined ? undefined : checkedStatusline(statusline, "launch.statusline");
}

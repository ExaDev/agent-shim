import type { IncomingHttpHeaders } from "node:http";

/**
 * Everything agent-shim still honours from its former name, `claude-use`, so an installation, a committed project config or an exported environment written for the old name keeps working. Nothing here is consulted when the current name's equivalent is present: a current name always wins, and the legacy form is only a fallback that `agent-shim doctor` reports so it can be retired.
 */

/** Prefix of every environment variable agent-shim reads. */
export const ENV_PREFIX = "AGENT_SHIM_";
/** The former prefix, still accepted wherever `ENV_PREFIX` is. */
export const LEGACY_ENV_PREFIX = "CLAUDE_USE_";

/** The state root directory name under the home directory. */
export const HOME_DIRNAME = ".agent-shim";
/**
 * The former state root directory name. It is adopted in place rather than moved: macOS Claude Code keys each identity's Keychain login on the exact `CLAUDE_CONFIG_DIR` string (`<root>/identities/<name>`), so relocating the root would sign every identity out.
 */
export const LEGACY_HOME_DIRNAME = ".claude-use";

/** Former committed and per-clone portable config file names. */
export const LEGACY_PORTABLE_CONFIG_FILENAME = ".claude-use.json";
export const LEGACY_PORTABLE_LOCAL_CONFIG_FILENAME = ".claude-use.local.json";

/** The former farm manifest file name, read when a farm built by an older release has no current one. */
export const LEGACY_FARM_MANIFEST_FILENAME = ".claude-use-farm.json";

/** The former executable name, still installed beside the current one and still dispatched to the same program. */
export const LEGACY_COMMAND_NAME = "claude-use";

/**
 * Copies every `CLAUDE_USE_*` variable in `env` to its `AGENT_SHIM_*` name unless that name is already set, mutating `env`. Returns the legacy names that supplied a value, in sorted order. An empty current value counts as set, so exporting `AGENT_SHIM_X=` still overrides a stale `CLAUDE_USE_X`.
 */
export function aliasLegacyEnv(env: NodeJS.ProcessEnv): string[] {
  const aliased: string[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(LEGACY_ENV_PREFIX)) {
      continue;
    }
    const value = env[name];
    const current = `${ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`;
    if (value === undefined || env[current] !== undefined) {
      continue;
    }
    env[current] = value;
    aliased.push(name);
  }
  return aliased;
}

/** Prefix of the internal `x-agent-shim-*` headers a launch's child sends to the front door. */
export const WIRE_HEADER_PREFIX = "x-agent-shim-";
/**
 * The former prefix. A child launched by a release that used the old name carries its capability and identity under these names in its frozen environment for the life of the session, so a front door of a newer release must keep recognising them.
 */
export const LEGACY_WIRE_HEADER_PREFIX = "x-claude-use-";

/**
 * Returns `headers` with every `x-claude-use-*` header renamed to its `x-agent-shim-*` name, and no legacy name left in the result, so everything downstream (admission, the identity strip that keeps internal headers from reaching an upstream) sees only the current names. A current-name header that is also present wins and the legacy copy is dropped. Header names arrive lowercased from Node's HTTP parser.
 */
export function aliasLegacyWireHeaders(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith(LEGACY_WIRE_HEADER_PREFIX)) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(LEGACY_WIRE_HEADER_PREFIX)) {
      const current = `${WIRE_HEADER_PREFIX}${name.slice(LEGACY_WIRE_HEADER_PREFIX.length)}`;
      result[current] ??= value;
    }
  }
  return result;
}

import path from "node:path";

import type { DirectoryRule, GlobalConfig, PortableConfig } from "../config/schema";
import { profileLayers, type ProfileLoader } from "./extends";
import type { Diagnostic, Layer, LayerId } from "./types";

/** Injected predicate answering whether a directory can be read, so the walk stays pure. */
export type ReadablePredicate = (dir: string) => boolean;

/** Options for the upward directory walk. */
export interface WalkOptions {
  /** The user's home directory, the walk's default stopping point. */
  readonly home: string;
  /** Where to stop walking upward, inclusive. Defaults to `home`, and is what `walkUpLimit` in the global config sets. */
  readonly limit?: string;
  /** Answers whether a directory is readable. A directory that is not stops the walk there rather than failing the launch. */
  readonly isReadable?: ReadablePredicate;
}

/**
 * Collects `cwd` and every ancestor of it, shallowest-first, the way Claude Code itself resolves nested `CLAUDE.md` files.
 *
 * The walk stops at (and includes) the limit directory — `$HOME` by default — or at the filesystem root when `cwd` is not beneath the limit at all. An ancestor that cannot be read stops the walk there rather than failing the launch: a directory you cannot read cannot carry a config file you were meant to obey.
 *
 * `cwd` is expected to already be a real path; resolving symlinks is the caller's job, so this stays free of filesystem access.
 */
export function walkDirectoryAncestors(cwd: string, options: WalkOptions): string[] {
  const limit = path.resolve(options.limit ?? options.home);
  const isReadable = options.isReadable ?? (() => true);
  const collected: string[] = [];

  let current = path.resolve(cwd);
  for (;;) {
    if (!isReadable(current)) {
      break;
    }
    collected.push(current);
    if (current === limit) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return collected.reverse();
}

/** The up-to-three configuration sources that can apply at one directory level. */
export interface DirectoryLevelSources {
  readonly dir: string;
  /** The committed, team-shared `.agent-shim.json` at this level. */
  readonly portable?: { readonly config: PortableConfig; readonly entryOrder?: readonly string[]; readonly filepath: string };
  /** Every rule in this user's own `~/.agent-shim/directory-rules.json` whose path is exactly this level, in file order. */
  readonly rules?: readonly { readonly rule: DirectoryRule; readonly entryOrder?: readonly string[]; readonly filepath: string }[];
  /** The gitignored `.agent-shim.local.json` at this level. */
  readonly portableLocal?: { readonly config: PortableConfig; readonly entryOrder?: readonly string[]; readonly filepath: string };
}

/** Everything needed to assemble the full ordered layer sequence, all of it already loaded by the caller. */
export interface CascadeInput {
  readonly home: string;
  /** The user-global `~/.agent-shim/config.json`, the least-specific layer above the shipped defaults. */
  readonly globalConfig?: { readonly config: GlobalConfig; readonly entryOrder?: readonly string[]; readonly filepath: string };
  /** The configuration profile chosen by the caller's own precedence rules: explicit flag, then the active identity's default, then the global default. */
  readonly baseConfigProfile?: string;
  readonly loadProfile: ProfileLoader;
  /** Directory levels, shallowest-first, as produced by `walkDirectoryAncestors`. */
  readonly levels?: readonly DirectoryLevelSources[];
  /** One-off overrides from the command line or environment, composed last so they beat everything. */
  readonly cliOverride?: {
    readonly categories?: Layer["categories"];
    readonly entries?: Layer["entries"];
    readonly entryOrder?: readonly string[];
    readonly launch?: Layer["launch"];
  };
}

/** The assembled cascade: an ordered layer sequence plus what the walk itself decided. */
export interface AssembledCascade {
  readonly layers: readonly Layer[];
  readonly diagnostics: readonly Diagnostic[];
  /** The deepest directory-level `identity` pin encountered, which the launcher uses as a safety net beneath an explicit `@name`. */
  readonly identityPin?: string;
  /** The deepest directory-level `configProfile` selection encountered, which is what `agent-shim configure` treats as the active profile for a path. */
  readonly directoryConfigProfile?: string;
}

/**
 * Assembles the full ordered layer sequence.
 *
 * Order is: the user-global config, then the base configuration profile's own `extends` chain, then every directory level shallowest-to-deepest, then one-off command-line overrides.
 *
 * Within one directory level, up to three sources fold most-personal-last: the committed `.agent-shim.json` (team-shared), then this user's own `directory-rules.json` entries for that exact path, then `.agent-shim.local.json` (this clone, this user, never committed). That three-source fold happens once per level, and the whole shallowest-to-deepest walk is one continuous sequence through those folded levels — a deeper level's three-source result composes on top of a shallower level's, never gathered per-source across the whole tree first.
 *
 * A level source that names a `configProfile` composes that profile's whole chain in *before* its own inline overrides, so the source reads as "everything that profile says, plus what is additionally true this far down the tree" rather than swapping the base profile out wholesale.
 */
export function assembleCascade(input: CascadeInput): AssembledCascade {
  const layers: Layer[] = [];
  const diagnostics: Diagnostic[] = [];
  let nextId: LayerId = 0;
  let identityPin: string | undefined;
  let directoryConfigProfile: string | undefined;

  if (input.globalConfig !== undefined) {
    const { config, entryOrder, filepath } = input.globalConfig;
    layers.push({
      id: nextId,
      kind: "global-config",
      source: filepath,
      ...(config.categories === undefined ? {} : { categories: config.categories }),
      ...(config.entries === undefined ? {} : { entries: config.entries }),
      ...(entryOrder === undefined ? {} : { entryOrder }),
      ...(config.launch === undefined ? {} : { launch: config.launch }),
    });
    nextId += 1;
  }

  if (input.baseConfigProfile !== undefined) {
    const resolved = profileLayers(input.baseConfigProfile, input.loadProfile, nextId);
    layers.push(...resolved.layers);
    diagnostics.push(...resolved.diagnostics);
    nextId = resolved.nextId;
  }

  for (const level of input.levels ?? []) {
    const sources: { kind: Layer["kind"]; config: PortableConfig | DirectoryRule; entryOrder?: readonly string[]; filepath: string }[] = [];
    if (level.portable !== undefined) {
      sources.push({ kind: "portable", config: level.portable.config, ...(level.portable.entryOrder === undefined ? {} : { entryOrder: level.portable.entryOrder }), filepath: level.portable.filepath });
    }
    for (const entry of level.rules ?? []) {
      sources.push({ kind: "directory-rule", config: entry.rule, ...(entry.entryOrder === undefined ? {} : { entryOrder: entry.entryOrder }), filepath: entry.filepath });
    }
    if (level.portableLocal !== undefined) {
      sources.push({ kind: "portable-local", config: level.portableLocal.config, ...(level.portableLocal.entryOrder === undefined ? {} : { entryOrder: level.portableLocal.entryOrder }), filepath: level.portableLocal.filepath });
    }

    for (const source of sources) {
      if (source.config.identity !== undefined) {
        identityPin = source.config.identity;
      }
      if (source.config.configProfile !== undefined) {
        directoryConfigProfile = source.config.configProfile;
        const resolved = profileLayers(source.config.configProfile, input.loadProfile, nextId);
        layers.push(...resolved.layers);
        diagnostics.push(...resolved.diagnostics);
        nextId = resolved.nextId;
      }
      layers.push({
        id: nextId,
        kind: source.kind,
        source: source.filepath,
        ...(source.config.categories === undefined ? {} : { categories: source.config.categories }),
        ...(source.config.entries === undefined ? {} : { entries: source.config.entries }),
        ...(source.entryOrder === undefined ? {} : { entryOrder: source.entryOrder }),
        ...(source.config.launch === undefined ? {} : { launch: source.config.launch }),
      });
      nextId += 1;
    }
  }

  if (input.cliOverride !== undefined) {
    layers.push({
      id: nextId,
      kind: "cli-override",
      source: "command line",
      ...(input.cliOverride.categories === undefined ? {} : { categories: input.cliOverride.categories }),
      ...(input.cliOverride.entries === undefined ? {} : { entries: input.cliOverride.entries }),
      ...(input.cliOverride.entryOrder === undefined ? {} : { entryOrder: input.cliOverride.entryOrder }),
      ...(input.cliOverride.launch === undefined ? {} : { launch: input.cliOverride.launch }),
    });
  }

  return {
    layers,
    diagnostics,
    ...(identityPin === undefined ? {} : { identityPin }),
    ...(directoryConfigProfile === undefined ? {} : { directoryConfigProfile }),
  };
}

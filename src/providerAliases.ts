import fs from "node:fs";
import { z } from "zod";
import { CliError } from "./cliError";
import { ConfigValidationError } from "./config/load";
import { readJson, writeJsonAtomic } from "./config/store";
import type { FsPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";

/**
 * The former names of renamed providers, by the old name: `{ "z": "zai" }` means a request or a launch that names `z` is served by the provider now called `zai`.
 *
 * A running session has its provider's name fixed at launch, and the front door resolves that name against the providers directory on every request, so renaming a provider file alone strands every session launched before the rename. An alias is what keeps those sessions served until they end. Targets are always current provider names: renaming a provider repoints every alias that targeted it, so a lookup is one step and never a chain.
 */
const ProviderAliasesSchema = z.record(z.string().min(1), z.string().min(1));
export type ProviderAliases = z.infer<typeof ProviderAliasesSchema>;

/** Parses the aliases file's JSON, naming the file in the failure. */
function parseAliases(file: string, raw: unknown): ProviderAliases {
  const parsed = ProviderAliasesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(file, parsed.error.issues);
  }
  return parsed.data;
}

/** The aliases recorded under `paths`, or none when no provider was ever renamed. */
export function readProviderAliases(paths: LayoutPaths): ProviderAliases {
  return readJson(paths.providerAliasesFile, ProviderAliasesSchema) ?? {};
}

/** The aliases recorded in `file`, read through the launcher's filesystem port, or none when the file does not exist. */
export function loadProviderAliases(file: string, port: FsPort): ProviderAliases {
  const raw = port.readConfigFile(file);
  return raw === undefined ? {} : parseAliases(file, raw);
}

/** Records `aliases` as the whole file, or removes the file when none remain, so a tree that never renamed a provider carries no trace of the feature. */
export function writeProviderAliases(paths: LayoutPaths, aliases: Readonly<ProviderAliases>): void {
  if (Object.keys(aliases).length === 0) {
    fs.rmSync(paths.providerAliasesFile, { force: true });
    return;
  }
  writeJsonAtomic(paths.providerAliasesFile, aliases);
}

/**
 * The provider a name stands for: the name itself when a provider file defines it, else the provider it is an alias of, else the name unchanged (an unknown name stays unknown, for the caller to refuse). A provider file always wins over an alias of the same name, so adding a provider can never be shadowed by a stale alias.
 *
 * `aliases` is read lazily, only for a name no provider file defines, so the common request pays no read of the aliases file.
 */
export function canonicalProviderName(name: string, defined: (name: string) => boolean, aliases: () => ProviderAliases): string {
  if (defined(name)) {
    return name;
  }
  return aliases()[name] ?? name;
}

/**
 * The aliases after `from` is renamed to `to`: `from` becomes an alias of `to`, every alias that targeted `from` now targets `to`, and an alias named `to` is dropped, since `to` is now a provider file and the file wins.
 */
export function aliasesAfterRename(aliases: Readonly<ProviderAliases>, from: string, to: string): ProviderAliases {
  const next: Record<string, string> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias !== to) {
      next[alias] = target === from ? to : target;
    }
  }
  next[from] = to;
  return next;
}

/** Raised by `provider unalias` when the name is not a recorded former name. */
export class ProviderAliasNotFoundError extends CliError {
  constructor(readonly alias: string) {
    super(`"${alias}" is not a former provider name. \`agent-shim provider list\` shows the ones recorded.`);
    this.name = "ProviderAliasNotFoundError";
  }
}

/** The former names recorded for provider `name`, sorted. */
export function aliasesOf(aliases: Readonly<ProviderAliases>, name: string): readonly string[] {
  return Object.entries(aliases).filter(([, target]) => target === name).map(([alias]) => alias).sort();
}

/** Forgets the former name `alias`, so a session still launched under it stops being served. Throws `ProviderAliasNotFoundError` when it is not recorded. */
export function removeProviderAlias(paths: LayoutPaths, alias: string): void {
  const aliases = readProviderAliases(paths);
  if (!(alias in aliases)) {
    throw new ProviderAliasNotFoundError(alias);
  }
  writeProviderAliases(paths, Object.fromEntries(Object.entries(aliases).filter(([name]) => name !== alias)));
}

/** One thing `doctor` reports about a recorded former name. */
export interface AliasFinding {
  readonly level: "pass" | "warn" | "fail";
  readonly alias: string;
  readonly message: string;
}

/**
 * What is wrong, or worth knowing, about each recorded former name given the providers that exist: an alias whose target is gone serves nothing and fails; one a provider file now shares its name with is dead weight, since the file wins, and warns; any other is a name still honoured, reported so the aliases a rename left behind are visible until they are forgotten.
 */
export function aliasFindings(aliases: Readonly<ProviderAliases>, providerNames: ReadonlySet<string>): readonly AliasFinding[] {
  return Object.entries(aliases).map(([alias, target]): AliasFinding => {
    if (!providerNames.has(target)) {
      return { level: "fail", alias, message: `${alias} is recorded as a former name of ${target}, which is not a provider. Run \`agent-shim provider unalias ${alias}\`.` };
    }
    if (providerNames.has(alias)) {
      return { level: "warn", alias, message: `${alias} is both a provider and a recorded former name of ${target}; the provider wins. Run \`agent-shim provider unalias ${alias}\`.` };
    }
    return { level: "pass", alias, message: `${alias} is a former name of ${target}, still honoured for sessions launched under it. Run \`agent-shim provider unalias ${alias}\` once none is running.` };
  });
}

/**
 * The door's name resolver: `canonicalProviderName` over the live providers and aliases, with the two things a long-running process adds. An unreadable aliases file is logged and treated as none rather than failing every provider request, so a damaged file costs the aliases and not the door; and each former name is reported once, since one in use means a session launched before a rename is still running.
 */
export function createProviderCanonicaliser(params: { readonly defined: (name: string) => boolean; readonly aliases: () => ProviderAliases; readonly log: (line: string) => void }): (name: string) => string {
  const reported = new Set<string>();
  return (name) => {
    const current = canonicalProviderName(name, params.defined, () => {
      try {
        return params.aliases();
      } catch (error) {
        params.log(`provider aliases ignored, the aliases file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
        return {};
      }
    });
    if (current !== name && !reported.has(name)) {
      reported.add(name);
      params.log(`provider ${name} is a former name of ${current}; a session launched under it is still running`);
    }
    return current;
  };
}

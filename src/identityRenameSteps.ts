import path from "node:path";
import type { z } from "zod";

import { ConfigValidationError } from "./config/load";
import { ConfigProfileSchema, DirectoryRulesSchema, GlobalConfigSchema, type CredentialCacheStore } from "./config/schema";
import type { CachedCredential, CredentialCachePort } from "./credentialCache";
import { nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { listProfiles } from "./configProfilesStore";
import { renameIdentityInRules } from "./directoryRulesStore";
import { readActiveIdentity } from "./identityStore";
import { renameIdentityInJobs } from "./jobStore";
import type { FarmFs } from "./launcher/ports";
import { renameAccountModelRefs } from "./modelRefs";
import type { LayoutPaths } from "./paths";
import { renameIdentityInPools } from "./poolStore";
import { stampsWithKeyRenamed } from "./usage/handledStamps";
import { picksWithIdentityRenamed } from "./usage/poolPick";

/** What the steps here reach the machine through: the filesystem the usage files are written with, and the one an undo checks a directory is still there with. */
export interface StepPorts {
  readonly fs: FarmFs;
}

/** One thing the rename does. `apply` may fail part way, so `undo` must be safe to call after any prefix of `apply`, and after all of it. */
export interface Step {
  readonly description: string;
  readonly apply: () => void;
  readonly undo: () => void;
}

/** `count` and `noun`, pluralised. */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** The result of rewriting one parsed value: the value, and what changed in it, for the step's description. */
export interface Rewrite<T> {
  readonly value: T;
  readonly changes: readonly string[];
}

/** `value` checked against `schema`, so a rewrite that would leave an invalid file fails in the plan (and so in a dry run), before anything is written. */
function validated<S extends z.ZodType>(file: string, schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigValidationError(file, result.error.issues);
  }
  return result.data;
}

/**
 * A step that rewrites one JSON configuration file, or undefined when the file is absent or `rewrite` finds nothing in it to change. It reads and writes through the same store as every other command, so keys this release does not know survive. The rewrite runs again when the step is applied, on what is on disk by then, and the file's exact bytes are kept to put back.
 */
export function jsonRewriteStep<S extends z.ZodType>(paths: LayoutPaths, ports: StepPorts, file: string, schema: S, rewrite: (value: z.infer<S>) => Rewrite<z.infer<S>> | undefined): Step | undefined {
  const current: z.infer<S> | undefined = readJson(file, schema);
  const planned = current === undefined ? undefined : rewrite(current);
  if (planned === undefined) {
    return undefined;
  }
  validated(file, schema, planned.value);
  let original: string | undefined;
  return {
    description: `rewrite ${path.relative(paths.root, file)}: ${planned.changes.join(", ")}`,
    apply: () => {
      original = nodeStoreFs.readFileUtf8(file);
      const latest: z.infer<S> | undefined = readJson(file, schema);
      const outcome = latest === undefined ? undefined : rewrite(latest);
      if (outcome !== undefined) {
        writeJsonAtomic(file, validated(file, schema, outcome.value));
      }
    },
    undo: () => {
      // A file that moved with its directory has no place to be put back: writing here would make a stray directory under the old name, and the moved copy already holds what a resume expects.
      if (original !== undefined && ports.fs.lstat(path.dirname(file)) !== undefined) {
        writeTextAtomic(file, original);
      }
    },
  };
}

/** How a text file is written back. */
export type TextWriter = (file: string, text: string) => void;

/**
 * A step that rewrites one text file through `transform`, which returns the new text and a summary for the description, or undefined when the file holds nothing to change. Like `jsonRewriteStep` it recomputes on what is on disk when applied and keeps the original text to put back.
 */
export function textRewriteStep(paths: LayoutPaths, ports: StepPorts, file: string, write: TextWriter, transform: (raw: string) => { readonly text: string; readonly summary?: string } | undefined): Step | undefined {
  const raw = ports.fs.readFileUtf8(file);
  const planned = raw === undefined ? undefined : transform(raw);
  if (planned === undefined) {
    return undefined;
  }
  let original: string | undefined;
  return {
    description: `rewrite ${path.relative(paths.root, file)}${planned.summary === undefined ? "" : `: ${planned.summary}`}`,
    apply: () => {
      original = ports.fs.readFileUtf8(file);
      const latest = original === undefined ? undefined : transform(original);
      if (latest !== undefined) {
        write(file, latest.text);
      }
    },
    undo: () => {
      if (original !== undefined && ports.fs.lstat(path.dirname(file)) !== undefined) {
        write(file, original);
      }
    },
  };
}

/** The steps that rewrite the name where the configuration refers to it: the pools, jobs and account model refs of the global configuration, and the account model refs of every configuration profile. Shared by both renames, since the name is what these hold. */
export function configReferenceSteps(paths: LayoutPaths, ports: StepPorts, from: string, to: string): readonly (Step | undefined)[] {
  return [
    jsonRewriteStep(paths, ports, paths.globalConfigFile, GlobalConfigSchema, (config) => {
      const pools = config.pools === undefined ? undefined : renameIdentityInPools(config.pools, from, to);
      const jobs = config.jobs === undefined ? undefined : renameIdentityInJobs(config.jobs, from, to);
      const models = config.models === undefined ? undefined : renameAccountModelRefs(config.models, from, to);
      const changes = [...(pools?.renamedIn.map((name) => `pool ${name}`) ?? []), ...(jobs?.renamed.map((name) => `job ${name}`) ?? []), ...(models === undefined ? [] : ["models"])];
      return changes.length === 0
        ? undefined
        : { value: { ...config, ...(pools === undefined ? {} : { pools: pools.pools }), ...(jobs === undefined ? {} : { jobs: jobs.jobs }), ...(models === undefined ? {} : { models }) }, changes };
    }),
    ...listProfiles(paths).map(({ name }) =>
      jsonRewriteStep(paths, ports, path.join(paths.configProfilesDir, `${name}.json`), ConfigProfileSchema, (profile) => {
        const models = profile.models === undefined ? undefined : renameAccountModelRefs(profile.models, from, to);
        return models === undefined ? undefined : { value: { ...profile, models }, changes: ["models"] };
      }),
    ),
  ];
}

/** The steps that rewrite the name where a choice of identity is recorded by name: the directory rules and the active selection. Shared by both renames. */
export function selectionReferenceSteps(paths: LayoutPaths, ports: StepPorts, from: string, to: string): readonly (Step | undefined)[] {
  return [
    jsonRewriteStep(paths, ports, paths.directoryRulesFile, DirectoryRulesSchema, (rules) => {
      const renamed = renameIdentityInRules(rules, from, to);
      return renamed === undefined ? undefined : { value: renamed.rules, changes: renamed.renamedAt.map((rulePath) => `rule ${rulePath}`) };
    }),
    readActiveIdentity(paths) === from ? textRewriteStep(paths, ports, paths.activeIdentityFile, (file, text) => { writeTextAtomic(file, text); }, (raw) => raw.trim() === from ? { text: `${to}\n` } : undefined) : undefined,
  ];
}

/** The step that rewrites the name in the pool picks recorded per directory, which name the picked member. Shared by both renames. */
export function usageReferenceSteps(paths: LayoutPaths, ports: StepPorts, from: string, to: string): readonly (Step | undefined)[] {
  return [
    textRewriteStep(paths, ports, paths.usagePicksFile, (file, text) => { ports.fs.writeFilePrivate(file, text); }, (raw) => {
      const renamed = picksWithIdentityRenamed(raw, from, to);
      return renamed === undefined ? undefined : { text: renamed.text, summary: counted(renamed.renamed, "pick") };
    }),
  ];
}

/** The step that rekeys the window keeper's anchor stamp, which is filed under the identity's id: only `--move` changes the id, from `from` to `to`. */
export function anchorStampStep(paths: LayoutPaths, ports: StepPorts, from: string, to: string): Step | undefined {
  return textRewriteStep(paths, ports, paths.usageAnchorsFile, (file, text) => { ports.fs.writeFilePrivate(file, text); }, (raw) => {
    const text = stampsWithKeyRenamed(raw, from, to);
    return text === undefined ? undefined : { text, summary: counted(1, "stamp") };
  });
}

/** One store's cached credential of the identity being renamed, as read before the steps ran: `cached` is the entry, or undefined when none is stored there (or, in a dry run, not read). */
interface CachedInStore {
  readonly store: CredentialCacheStore;
  readonly cached: CachedCredential | undefined;
}

/**
 * The step that moves the cached credential from the old owner to the new in each of `entries`' stores: the store the identity's credential block turns caching on in, and the file store as well when an entry is left there while caching is off or in the Keychain, so a rename never strands a credential under the old owner. `cached` is each entry read before the locks were taken, because reading one can wait on a person; the store reads back only an entry that is the old owner's own or was cached before owners were recorded, so one cached for another identity whose id names the same file (ids such as `a@b` and `a_b`) is never moved. The plan names the step whether or not one is stored, and applying it moves nothing in a store with none. Writing for the new owner records it as the entry's owner, and removing the old owner's then leaves that entry alone when both ids name one file, so the step holds whether the two ids name one file or two, and on a resumed run.
 */
export function credentialCacheStep(port: CredentialCachePort, from: string, to: string, entries: readonly CachedInStore[]): Step {
  return {
    description: `move the cached credential of identity ${from} to identity ${to}, if one is stored`,
    apply: () => {
      for (const { store, cached } of entries) {
        if (cached !== undefined) {
          port.write(store, `identity ${to}`, cached);
          port.remove(store, `identity ${from}`);
        }
      }
    },
    undo: () => {
      for (const { store, cached } of entries) {
        if (cached !== undefined) {
          port.write(store, `identity ${from}`, cached);
          port.remove(store, `identity ${to}`);
        }
      }
    },
  };
}

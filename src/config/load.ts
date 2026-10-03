import { cosmiconfigSync, type PublicExplorerSync } from "cosmiconfig";
import type { z } from "zod";

import { CliError } from "../cliError";

/**
 * A configuration file that has been read, parsed, and validated.
 *
 * `entryOrder` and `ruleEntryOrders` capture each `entries` object's own key insertion order as an explicit ordinal array, taken from the *raw* parsed value before Zod ever sees it. This is not paranoia about JSON key ordering: `schema.parse()` returns a fresh deep clone, and relying on key order implicitly surviving that clone would make the resolver's same-layer source-order tie-break depend on an implementation detail of a third-party library. Capturing it explicitly at load time makes it data.
 */
export interface LoadedFile<T> {
  readonly filepath: string;
  readonly config: T;
  /** Key insertion order of the file's own top-level `entries` object; empty when the file has none. */
  readonly entryOrder: readonly string[];
  /** For a directory-rules file: the key insertion order of each rule's `entries` object, indexed the same as `rules[]`. Empty for every other file shape. */
  readonly ruleEntryOrders: readonly (readonly string[])[];
}

/**
 * Builds the cosmiconfig explorer used for every read.
 *
 * Only `load(filepath)` is ever called on it — never `search()`. `search()` stops at the first config file found while walking upward, and this design needs the exact opposite: every ancestor collected, shallowest-first. `src/resolve/walk.ts` does its own directory walk and this module loads each level it visits, so cosmiconfig contributes its format flexibility (JSON, YAML, JS) without its traversal semantics.
 */
export function createExplorer(moduleName = "agent-shim"): PublicExplorerSync {
  return cosmiconfigSync(moduleName, { searchPlaces: [] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the key insertion order of `value.entries`, when `value` is an object carrying an `entries` object. */
export function captureEntryOrder(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  const entries = value.entries;
  if (!isRecord(entries)) {
    return [];
  }
  return Object.keys(entries);
}

/** Reads the per-rule key insertion order of a directory-rules file's `rules[].entries` objects. */
export function captureRuleEntryOrders(value: unknown): readonly (readonly string[])[] {
  if (!isRecord(value)) {
    return [];
  }
  const rules = value.rules;
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.map((rule) => captureEntryOrder(rule));
}

/** Raised when a config file exists but fails Zod validation, so the caller can report the offending path alongside the issue list. */
export class ConfigValidationError extends CliError {
  constructor(
    readonly filepath: string,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    const detail = issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
    super(`Invalid configuration in ${filepath}:\n${detail}`);
    this.name = "ConfigValidationError";
  }
}

/** Injected reader for a single config file, so tests never touch a real filesystem. Returns undefined when the file does not exist. */
export type ConfigFileReader = (filepath: string) => unknown;

/** A cosmiconfig-backed reader: loads and parses one file by path, returning undefined when it is missing or empty. */
export function cosmiconfigReader(explorer: Readonly<PublicExplorerSync> = createExplorer()): ConfigFileReader {
  return (filepath: string): unknown => {
    let result;
    try {
      result = explorer.load(filepath);
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (result === null || result.isEmpty === true) {
      return undefined;
    }
    return result.config;
  };
}

/**
 * Loads one config file by exact path, validates it against `schema`, and captures its entries key order.
 *
 * Returns undefined when the file does not exist or is empty. Throws ConfigValidationError when it exists but does not validate — a malformed config is never silently ignored or half-applied.
 */
export function loadConfigFile<S extends z.ZodType>(
  filepath: string,
  schema: S,
  read: ConfigFileReader = cosmiconfigReader(),
): LoadedFile<z.infer<S>> | undefined {
  const raw = read(filepath);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(filepath, parsed.error.issues);
  }
  return {
    filepath,
    config: parsed.data,
    entryOrder: captureEntryOrder(raw),
    ruleEntryOrders: captureRuleEntryOrders(raw),
  };
}

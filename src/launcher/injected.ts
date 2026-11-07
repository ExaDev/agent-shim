import { createHash } from "node:crypto";

import { z } from "zod";

import { parseAnthropicCustomHeaders, withoutAnthropicCustomHeaders } from "../headroom/headers";

/**
 * The environment variable a launcher leaves in its child's environment, naming what it wrote there itself: a JSON object from each variable to the SHA-256 of the value written, with two kinds of entry for variables whose value the person's own settings share (`ANTHROPIC_CUSTOM_HEADERS:<lowercased header name>` for one custom header, `<NO_PROXY or no_proxy>,<lowercased host>` for one host the launcher appended to a bypass list). A launch started from inside that child reads it to tell what its parent launcher injected, which it must not inherit, from what the person set, which it must treat as theirs. The only things written to the environment and not recorded are `CLAUDE_CONFIG_DIR` (the child's own directory, replaced by every launch that resolves an identity) and the variables a launch unsets.
 */
export const INJECTED_ENV = "AGENT_SHIM_INJECTED";

/** The environment variable that carries custom request headers; its entries are recorded one by one, since a parent's own headers share the value. */
export const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/** Prefix of the marker key of one custom header. A variable name never contains a colon. */
const HEADER_KEY_PREFIX = `${CUSTOM_HEADERS_ENV}:`;

/** The comma-separated host lists a launcher appends to, under both spellings clients read. */
const BYPASS_LISTS = ["NO_PROXY", "no_proxy"] as const;

/** The marker key of one host appended to `list`. A host can contain a colon (`::1`), so the list name ends at the first comma, which a variable name never contains. */
function listKey(list: string, host: string): string {
  return `${list},${host.toLowerCase()}`;
}

const InjectedSchema = z.record(z.string(), z.string());

type Environment = Record<string, string | undefined>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The digests `env` records, or none when the marker is absent or not the object a launcher writes: a marker nobody trustworthy wrote vouches for nothing. */
function recordedDigests(env: Readonly<Environment>): Record<string, string> {
  const raw = env[INJECTED_ENV];
  if (raw === undefined || raw === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = InjectedSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

/** What a launcher writes into a child's environment, recording each value as it goes so the child's own launcher can tell it from the person's. */
export interface InjectionRecorder {
  /** The environment being built: a copy of the one the recorder started from, which the methods below write into. */
  readonly env: Environment;
  /** Sets `name` to `value` in the environment and records it as written by the launcher. */
  readonly set: (name: string, value: string) => void;
  /** Removes `name` from the child's environment, and its record: a value the launcher deliberately withheld must not leave a fingerprint behind. */
  readonly unset: (name: string) => void;
  /** Records the entries of the environment's `ANTHROPIC_CUSTOM_HEADERS` named `names` as written by the launcher. Call it once the variable holds its final value. */
  readonly recordHeaders: (names: readonly string[]) => void;
  /** Records `hosts` as appended by the launcher to the comma-separated list in the environment variable `list` (`NO_PROXY` or `no_proxy`), leaving the person's own entries unrecorded. */
  readonly recordBypassHosts: (list: (typeof BYPASS_LISTS)[number], hosts: readonly string[]) => void;
  /** Writes the marker, when anything was recorded. */
  readonly finish: () => void;
}

/**
 * Starts an environment from a copy of `base` and records what the launcher writes to it. It starts from the marker `base` already carries (a launch that kept its parent's environment, under the `CLAUDE_CONFIG_DIR` escape hatch, still holds what that parent injected), so the marker always names everything injected anywhere up the chain that is still in the environment.
 */
export function recordInjections(base: Readonly<Environment>): InjectionRecorder {
  const env: Environment = { ...base };
  const digests = new Map(Object.entries(recordedDigests(env)));
  return {
    env,
    set: (name, value) => {
      env[name] = value;
      digests.set(name, digest(value));
    },
    unset: (name) => {
      env[name] = undefined;
      digests.delete(name);
    },
    recordHeaders: (names) => {
      const block = env[CUSTOM_HEADERS_ENV];
      for (const entry of block === undefined ? [] : parseAnthropicCustomHeaders(block)) {
        if (names.includes(entry.name)) {
          digests.set(`${HEADER_KEY_PREFIX}${entry.name.toLowerCase()}`, digest(entry.value));
        }
      }
    },
    recordBypassHosts: (list, hosts) => {
      for (const host of hosts) {
        digests.set(listKey(list, host), digest(host.toLowerCase()));
      }
    },
    finish: () => {
      if (digests.size > 0) {
        env[INJECTED_ENV] = JSON.stringify(Object.fromEntries(digests));
      }
    },
  };
}

/** `value` (a comma-separated host list) without the hosts the marker records as appended to `list`; `value` itself when none is. */
function withoutRecordedHosts(list: string, value: string, digests: Readonly<Record<string, string>>): string {
  const entries = value.split(",");
  const kept = entries.filter((entry) => digests[listKey(list, entry.trim())] === undefined);
  return kept.length === entries.length ? value : kept.join(",");
}

/**
 * The environment a launch inherits: `env` as it is when the `CLAUDE_CONFIG_DIR` escape hatch applies (the child is the parent's session), and `env` without what a parent launcher injected (`withoutInjected`) otherwise. The launcher, `check` and `doctor` all judge the ambient-credential guard over this, so they cannot disagree.
 */
export function launchEnvironment(env: Readonly<Environment>, configDirEscapeHatch: boolean): Readonly<Environment> {
  return configDirEscapeHatch ? env : withoutInjected(env);
}

/**
 * `env` without what a parent launcher injected: every variable the marker names that still holds the value the parent wrote, every custom header and bypass host it records, and the marker itself. A variable the person set to something else, or set where the parent left none, stays, so the ambient-credential guard still refuses it. A custom header block or host list from which nothing is removed is left exactly as it is.
 */
export function withoutInjected(env: Readonly<Environment>): Environment {
  const digests = recordedDigests(env);
  const entries = Object.entries(env).flatMap(([name, value]): [string, string | undefined][] => {
    if (name === INJECTED_ENV) {
      return [];
    }
    if (value === undefined) {
      return [[name, value]];
    }
    if (name === CUSTOM_HEADERS_ENV) {
      const remaining = withoutAnthropicCustomHeaders(value, (entry) => digests[`${HEADER_KEY_PREFIX}${entry.name.toLowerCase()}`] === digest(entry.value));
      return remaining.trim() === "" ? [] : [[name, remaining]];
    }
    if (name === "NO_PROXY" || name === "no_proxy") {
      const remaining = withoutRecordedHosts(name, value, digests);
      return remaining.split(",").every((entry) => entry.trim() === "") ? [] : [[name, remaining]];
    }
    return digests[name] === digest(value) ? [] : [[name, value]];
  });
  return Object.fromEntries(entries);
}

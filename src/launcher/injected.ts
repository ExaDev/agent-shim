import { createHash } from "node:crypto";

import { z } from "zod";

import { filterAnthropicCustomHeaders, parseAnthropicCustomHeaders } from "../headroom/headers";

/**
 * The environment variable a launcher leaves in its child's environment, naming everything it wrote there itself: a JSON object from each variable (or custom header, as `ANTHROPIC_CUSTOM_HEADERS:<name>`) to the SHA-256 of the value written. A launch started from inside that child reads it to tell what its parent launcher injected, which it must not inherit, from what the person set, which it must treat as theirs.
 */
export const INJECTED_ENV = "AGENT_SHIM_INJECTED";

/** The environment variable that carries custom request headers; its entries are recorded one by one, since a parent's own headers share the value. */
export const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/** Prefix of the marker key of one custom header. A variable name never contains a colon. */
const HEADER_KEY_PREFIX = `${CUSTOM_HEADERS_ENV}:`;

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
  /** Records the entries of the environment's `ANTHROPIC_CUSTOM_HEADERS` named `names` as written by the launcher. Call it once the variable holds its final value. */
  readonly recordHeaders: (names: readonly string[]) => void;
  /** Writes the marker, when anything was recorded. */
  readonly finish: () => void;
}

/**
 * Starts an environment from a copy of `base` and records what the launcher writes to it. It starts from the marker `base` already carries (a launch that kept its parent's environment, under the `CLAUDE_CONFIG_DIR` escape hatch, still holds what that parent injected), so the marker always names everything injected anywhere up the chain that is still in the environment.
 */
export function recordInjections(base: Readonly<Environment>): InjectionRecorder {
  const env: Environment = { ...base };
  const digests = recordedDigests(env);
  return {
    env,
    set: (name, value) => {
      env[name] = value;
      digests[name] = digest(value);
    },
    recordHeaders: (names) => {
      const block = env[CUSTOM_HEADERS_ENV];
      for (const entry of block === undefined ? [] : parseAnthropicCustomHeaders(block)) {
        if (names.includes(entry.name)) {
          digests[`${HEADER_KEY_PREFIX}${entry.name}`] = digest(entry.value);
        }
      }
    },
    finish: () => {
      if (Object.keys(digests).length > 0) {
        env[INJECTED_ENV] = JSON.stringify(digests);
      }
    },
  };
}

/**
 * `env` without what a parent launcher injected: every variable and custom header the marker names that still holds the value the parent wrote, and the marker itself. A variable the person set to something else, or set where the parent left none, stays, so the ambient-credential guard still refuses it.
 */
export function withoutInjected(env: Readonly<Environment>): Environment {
  const digests = recordedDigests(env);
  const recordedHeaders = Object.keys(digests).some((name) => name.startsWith(HEADER_KEY_PREFIX));
  const entries = Object.entries(env).flatMap(([name, value]): [string, string | undefined][] => {
    if (name === INJECTED_ENV) {
      return [];
    }
    if (value === undefined) {
      return [[name, value]];
    }
    if (name === CUSTOM_HEADERS_ENV && recordedHeaders) {
      const remaining = filterAnthropicCustomHeaders(value, (entry) => digests[`${HEADER_KEY_PREFIX}${entry.name}`] !== digest(entry.value));
      return remaining === "" ? [] : [[name, remaining]];
    }
    return digests[name] === digest(value) ? [] : [[name, value]];
  });
  return Object.fromEntries(entries);
}

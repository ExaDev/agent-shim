import { UsageError } from "../cliError";

/** The result of parsing the launcher's own argv: the identity selection, any one-off `agent-shim` flags, and everything left to forward. */
export interface ParsedLauncherArgv {
  /** The identity named by a leading `@name` positional at argv[0] or by `--identity <name>`, when either was present. */
  readonly identity?: string;
  /** An explicit `--config-profile <name>` flag, when one was present. */
  readonly configProfile?: string;
  /** The last `--provider <name>` or `--no-provider` occurrence: a provider name, or `false` when `--no-provider` opted this launch out of any provider the cascade selects. Undefined when neither was given. */
  readonly provider?: string | false;
  /** The last `--headroom`/`--no-headroom` occurrence, when either was given. */
  readonly headroom?: boolean;
  /** The last `--track-usage`/`--no-track-usage` occurrence, when either was given. */
  readonly trackUsage?: boolean;
  /** The last `--wait`/`--no-wait` occurrence, when either was given: with a pool selected and every member refused, sleep until the earliest returns instead of refusing the launch. */
  readonly wait?: boolean;
  /** True when `--native` was given: run the real `claude` with nothing from agent-shim applied. It has no `--no-` form and cannot be combined with any other launch flag. */
  readonly native?: true;
  /** The last `--skip-permissions`/`--no-skip-permissions` occurrence, when either was given. */
  readonly skipPermissions?: boolean;
  /** The last `--remote-control`/`--no-remote-control` occurrence, when either was given. */
  readonly remoteControl?: boolean;
  /** Every `--category <cat>=<bool>` flag's raw value, in the order given: later values win on key collision when merged. */
  readonly categoryFlags: readonly string[];
  /** Every `--share <path>` flag's value, in the order given. */
  readonly shareFlags: readonly string[];
  /** Every `--hide <path>` flag's value, in the order given. */
  readonly hideFlags: readonly string[];
  /** Everything else, unchanged and in order: every token from a `--` terminator onwards (the `--` included), and any `@`-prefixed token that appears anywhere other than argv[0]. */
  readonly rest: readonly string[];
}

/** Raised when a launch names its identity twice, through both a leading `@name` and `--identity`, with different names. */
export class ConflictingIdentityError extends UsageError {
  constructor(readonly positional: string, readonly flag: string) {
    super(`The launch names two identities: "@${positional}" and "--identity ${flag}". Pass only one.`);
    this.name = "ConflictingIdentityError";
  }
}

const VALUED_FLAGS = ["--identity", "--config-profile", "--provider", "--category", "--share", "--hide"] as const;
type ValuedFlag = (typeof VALUED_FLAGS)[number];

/** The boolean launch flags, each with a `--no-` form; the key names the field of `ParsedLauncherArgv` it sets. */
const BOOLEAN_FLAGS = [
  { flag: "--headroom", key: "headroom" },
  { flag: "--track-usage", key: "trackUsage" },
  { flag: "--skip-permissions", key: "skipPermissions" },
  { flag: "--remote-control", key: "remoteControl" },
  { flag: "--wait", key: "wait" },
] as const;
type BooleanFlagKey = (typeof BOOLEAN_FLAGS)[number]["key"];

/** Every flag `parseLauncherArgv` consumes, both forms of each boolean included: what `agent-shim completion` offers after `run`. */
export const LAUNCHER_FLAG_NAMES: readonly string[] = [
  ...VALUED_FLAGS,
  "--native",
  "--no-provider",
  ...BOOLEAN_FLAGS.flatMap(({ flag }) => [flag, `--no-${flag.slice(2)}`]),
];

/** The launch flag that runs the real `claude` untouched. Not `--bare`, which is Claude Code's own minimal-mode flag and must keep reaching it. */
const NATIVE_FLAG = "--native";

/** The token that ends agent-shim's own flag recognition: everything from it onwards belongs to claude, or to a command claude runs. */
const TERMINATOR = "--";

function matchValuedFlag(token: string): { flag: ValuedFlag; inlineValue?: string } | undefined {
  for (const flag of VALUED_FLAGS) {
    if (token === flag) {
      return { flag };
    }
    if (token.startsWith(`${flag}=`)) {
      return { flag, inlineValue: token.slice(flag.length + 1) };
    }
  }
  return undefined;
}

function matchBooleanFlag(token: string): { key: BooleanFlagKey; value: boolean } | undefined {
  for (const { flag, key } of BOOLEAN_FLAGS) {
    if (token === flag) {
      return { key, value: true };
    }
    if (token === `--no-${flag.slice(2)}`) {
      return { key, value: false };
    }
  }
  return undefined;
}

/**
 * Parses the launcher's own argv for its identity selection and the one-off `agent-shim` launch flags (`--identity`, `--config-profile`, `--provider`/`--no-provider`, `--category`, `--share`, `--hide`, and the `--[no-]headroom`, `--[no-]track-usage`, `--[no-]skip-permissions`, `--[no-]remote-control`, `--[no-]wait` booleans, and `--native`). None of these are real Claude Code flags, so all are consumed here and never forwarded.
 *
 * `name` in `@name` and `--identity <name>` may also be `pool:<pool>`, which the launcher resolves to a member of that pool. The `@name` form is consumed ONLY at argv[0], never mid-argument-list; `--identity <name>` is its explicit form, and naming two different identities through both throws `ConflictingIdentityError`. The flags are recognised only before a `--` terminator: from `--` onwards every token is forwarded verbatim, so `claude mcp add n -- cmd --provider x` keeps `--provider x` for `cmd`. Valued flags accept both `--flag value` and `--flag=value` and take exactly one value per occurrence; `--category`, `--share` and `--hide` repeat to supply several, and every other flag's later occurrence wins. A valued flag with no value after it (the last token, or directly before `--`) is left in place, untouched, since there is nothing to pair it with.
 */
export function parseLauncherArgv(argv: readonly string[]): ParsedLauncherArgv {
  const first = argv[0];
  const positionalIdentity = first !== undefined && first.startsWith("@") && first.length > 1 ? first.slice(1) : undefined;
  const remaining = positionalIdentity === undefined ? argv : argv.slice(1);

  let native = false;
  let flagIdentity: string | undefined;
  let configProfile: string | undefined;
  let provider: string | false | undefined;
  const booleans: Partial<Record<BooleanFlagKey, boolean>> = {};
  const categoryFlags: string[] = [];
  const shareFlags: string[] = [];
  const hideFlags: string[] = [];
  const rest: string[] = [];

  for (let index = 0; index < remaining.length; index += 1) {
    const token = remaining[index];
    if (token === undefined) {
      continue;
    }
    if (token === TERMINATOR) {
      rest.push(...remaining.slice(index));
      break;
    }
    if (token === "--no-provider") {
      provider = false;
      continue;
    }
    if (token === NATIVE_FLAG) {
      native = true;
      continue;
    }
    const booleanFlag = matchBooleanFlag(token);
    if (booleanFlag !== undefined) {
      booleans[booleanFlag.key] = booleanFlag.value;
      continue;
    }

    const matched = matchValuedFlag(token);
    if (matched === undefined) {
      rest.push(token);
      continue;
    }

    let value: string;
    if (matched.inlineValue !== undefined) {
      value = matched.inlineValue;
    } else {
      const next = remaining[index + 1];
      if (next === undefined || next === TERMINATOR) {
        // No value to pair with: leave the flag untouched rather than silently swallowing it (or the terminator).
        rest.push(token);
        continue;
      }
      value = next;
      index += 1;
    }

    switch (matched.flag) {
      case "--identity":
        flagIdentity = value;
        break;
      case "--config-profile":
        configProfile = value;
        break;
      case "--provider":
        provider = value;
        break;
      case "--category":
        categoryFlags.push(value);
        break;
      case "--share":
        shareFlags.push(value);
        break;
      case "--hide":
        hideFlags.push(value);
        break;
      default:
        matched.flag satisfies never;
    }
  }

  if (positionalIdentity !== undefined && flagIdentity !== undefined && positionalIdentity !== flagIdentity) {
    throw new ConflictingIdentityError(positionalIdentity, flagIdentity);
  }
  const identity = flagIdentity ?? positionalIdentity;

  return {
    ...(identity === undefined ? {} : { identity }),
    ...(configProfile === undefined ? {} : { configProfile }),
    ...(provider === undefined ? {} : { provider }),
    ...(native ? { native: true as const } : {}),
    ...booleans,
    categoryFlags,
    shareFlags,
    hideFlags,
    rest,
  };
}

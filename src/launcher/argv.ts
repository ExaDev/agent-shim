/** The result of parsing the launcher's own argv: a leading `@name` identity token, any one-off `claude-use` flags, and everything left to forward. */
export interface ParsedLauncherArgv {
  /** The identity name from a leading `@name` positional, when one was present at argv[0]. */
  readonly identity?: string;
  /** An explicit `--config-profile <name>` flag, when one was present. */
  readonly configProfile?: string;
  /** An explicit `--provider <name>` flag, when one was present. */
  readonly provider?: string;
  /** Every `--category <cat>=<bool>[,...]` flag's raw value, in the order given — later values win on key collision when merged. */
  readonly categoryFlags: readonly string[];
  /** Every `--share <path>[,...]` flag's raw value, in the order given. */
  readonly shareFlags: readonly string[];
  /** Every `--hide <path>[,...]` flag's raw value, in the order given. */
  readonly hideFlags: readonly string[];
  /** Everything else, unchanged and in order — including any `@`-prefixed token that appears anywhere other than argv[0], which is never treated specially. */
  readonly rest: readonly string[];
}

const VALUED_FLAGS = ["--config-profile", "--provider", "--category", "--share", "--hide"] as const;
type ValuedFlag = (typeof VALUED_FLAGS)[number];

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

/**
 * Parses the launcher's own argv for a leading `@name` identity selector and the one-off `claude-use` flags documented in the README's CLI reference table (`--config-profile`, `--provider`, `--category`, `--share`, `--hide`) — none of which are real Claude Code flags, so all are consumed here and never forwarded.
 *
 * The `@name` form is consumed ONLY at argv[0] — never mid-argument-list. The four flags above are recognised anywhere in argv (accepting both `--flag value` and `--flag=value`), consuming their value token too, and are repeatable: each occurrence's raw value is collected in order so the caller can merge them (later occurrence wins on key collision, matching `claude-use profile set`'s own repeatable-flag convention). A flag given with no value at all (the last token in argv) is left in place, untouched and unconsumed, since there is nothing to pair it with.
 */
export function parseLauncherArgv(argv: readonly string[]): ParsedLauncherArgv {
  const first = argv[0];
  const hasIdentity = first !== undefined && first.startsWith("@") && first.length > 1;
  const remaining = hasIdentity ? argv.slice(1) : argv;

  let configProfile: string | undefined;
  let provider: string | undefined;
  const categoryFlags: string[] = [];
  const shareFlags: string[] = [];
  const hideFlags: string[] = [];
  const rest: string[] = [];

  for (let index = 0; index < remaining.length; index += 1) {
    const token = remaining[index];
    if (token === undefined) {
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
      if (next === undefined) {
        // No value to pair with — leave the flag untouched rather than silently swallowing it.
        rest.push(token);
        continue;
      }
      value = next;
      index += 1;
    }

    if (matched.flag === "--config-profile") {
      configProfile = value;
    } else if (matched.flag === "--provider") {
      provider = value;
    } else if (matched.flag === "--category") {
      categoryFlags.push(value);
    } else if (matched.flag === "--share") {
      shareFlags.push(value);
    } else {
      hideFlags.push(value);
    }
  }

  return {
    ...(hasIdentity ? { identity: first.slice(1) } : {}),
    ...(configProfile === undefined ? {} : { configProfile }),
    ...(provider === undefined ? {} : { provider }),
    categoryFlags,
    shareFlags,
    hideFlags,
    rest,
  };
}

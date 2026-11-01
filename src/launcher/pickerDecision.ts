import { isClaudeSubcommand } from "./claudeSubcommand";

/** What a pool pick means for the account a directory's launches run as. */
type PoolPickOutcome =
  /** The pick runs as the account (and organisation) the directory last ran as, or nothing says otherwise. */
  | "keeps-account"
  /** The pick runs as a different account or organisation from the one the directory last ran as. */
  | "changes-account"
  /** Every member is refused right now, so there is no pick. */
  | "none-eligible";

/** What the launch resolved to before any question is asked. */
export type PickerSelection =
  /** No `@name`, directory rule or active selection names an identity. */
  | { readonly kind: "none" }
  /** An identity is named, and `limited` says its recorded usage has it refused right now. */
  | { readonly kind: "identity"; readonly limited: boolean }
  /** A pool is named, and `outcome` says what its pick would do. */
  | { readonly kind: "pool"; readonly outcome: PoolPickOutcome };

/** Everything the decision to ask reads, as plain facts, so it is decided without a terminal, a filesystem or a clock. */
export interface PickerFacts {
  /** Standard input and standard output are both terminals. */
  readonly interactive: boolean;
  /** The launch runs unattended by its arguments: a print run, a background launch or a claude subcommand. */
  readonly unattended: boolean;
  /** `--pick` (true) or `--no-pick` (false), when either was given. */
  readonly pick: boolean | undefined;
  /** `CLAUDE_CONFIG_DIR` already names the configuration directory, so there is no identity to choose. */
  readonly configDirEscapeHatch: boolean;
  /** `--wait` was given, so a pool whose members are all refused is slept on, not asked about. */
  readonly waiting: boolean;
  readonly selection: PickerSelection;
}

/** Why the picker is shown: it was asked for, nothing resolved, the pool pick moves the account, or the identity cannot be used now. */
export type PickerReason = "requested" | "no-identity" | "account-change" | "no-eligible-identity";

/**
 * Decides whether a launch asks the person which identity to run as, and why. Pure over its facts.
 *
 * A launch without a terminal, or one that names its own `CLAUDE_CONFIG_DIR`, never asks, and `--no-pick` turns the question off. `--pick` asks whenever there is a terminal, even for a launch the arguments make unattended, since the person typed it. Otherwise only a real choice asks: nothing resolved, a pool pick that changes account, or an identity (or every pool member) that is refused right now and not waited for. An unattended launch never asks for those reasons.
 */
export function decidePicker(facts: Readonly<PickerFacts>): PickerReason | undefined {
  if (!facts.interactive || facts.configDirEscapeHatch || facts.pick === false) {
    return undefined;
  }
  if (facts.pick === true) {
    return "requested";
  }
  if (facts.unattended) {
    return undefined;
  }
  const { selection } = facts;
  switch (selection.kind) {
    case "none":
      return "no-identity";
    case "identity":
      return selection.limited ? "no-eligible-identity" : undefined;
    case "pool":
      if (selection.outcome === "none-eligible") {
        return facts.waiting ? undefined : "no-eligible-identity";
      }
      return selection.outcome === "changes-account" ? "account-change" : undefined;
    default:
      return selection satisfies never;
  }
}

/** The token that ends the arguments claude itself reads: what follows belongs to a command claude runs. */
const TERMINATOR = "--";

/** The flags that make claude run without a person at the terminal: a print run ends by itself, a background launch detaches. */
const UNATTENDED_FLAGS: ReadonlySet<string> = new Set(["-p", "--print", "--bg"]);

/**
 * Whether the arguments claude will receive make the launch unattended: a print run (`-p`, `--print`), a background launch (`--bg`) or a claude subcommand, which starts no session. Only tokens before a `--` terminator count.
 */
export function isUnattendedLaunch(passthrough: readonly string[]): boolean {
  const end = passthrough.indexOf(TERMINATOR);
  const head = end === -1 ? passthrough : passthrough.slice(0, end);
  return head.some((token) => UNATTENDED_FLAGS.has(token)) || isClaudeSubcommand(passthrough);
}

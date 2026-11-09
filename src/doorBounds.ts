import { CREDENTIAL_COMMAND_TIMEOUT_MS, CREDENTIAL_INTERACTIVE_TIMEOUT_MS } from "./credential";

/**
 * The timeout of every blocking step a front door worker task can reach (the check and doctor reports and the catalogue refresh), by what the step is. Each synchronous spawn names one of these (`spawnSyncBlocking` requires a `timeout`), so the longest of them is known, and the worker's stall limit is derived above it.
 */
export const BLOCKING_STEP_TIMEOUTS_MS = {
  /** `ps` over a handful of pids answers far inside this; a slower one counts as unreadable. */
  processTable: 2_000,
  /** `launchctl managername`: a lookup the operating system answers from memory. */
  desktopSession: 2_000,
  /** The auxiliary commands a report reads (git branch of a directory, the Keychain item of a login). */
  auxiliaryCommand: 10_000,
  /** One `security` call: it reads a local keychain and never prompts here (its standard error is ignored and nothing is attached). */
  keychain: 10_000,
  /** `mise which`: resolving a shim names the tool it dispatches to. */
  miseLookup: 5_000,
  /** `codex --version`, run to see which version a catalogue is fetched for. */
  codexVersion: 5_000,
  /** A credential command that needs no person. */
  credentialCommand: CREDENTIAL_COMMAND_TIMEOUT_MS,
  /** A credential command that waits for a person to approve a prompt. */
  credentialInteractive: CREDENTIAL_INTERACTIVE_TIMEOUT_MS,
} as const;

/**
 * The bound `realRunPort.run` applies when a caller names none, which is `auxiliaryCommand`: every caller reachable from the door's reports (a git lookup, a `ps` read, a Keychain attribute lookup) takes it. A caller that can wait on a person names a person-sized bound of its own instead (`keychainLogin.ts`'s reads, adds and deletes, `usage/signIn.ts`'s `claude auth status`), which only the command line reaches, so it is never inside a door worker's stall limit.
 */
export const RUN_PORT_DEFAULT_TIMEOUT_MS = BLOCKING_STEP_TIMEOUTS_MS.auxiliaryCommand;

/** The longest single blocking step a door worker task can take. */
export const LONGEST_BLOCKING_STEP_MS = Math.max(...Object.values(BLOCKING_STEP_TIMEOUTS_MS));

/** How long a worker thread may take to start and evaluate the bundle before its task begins: the allowance a loaded machine needs to parse and run the whole command line bundle, the same allowance a probe thread gets to start. */
export const DOOR_WORKER_START_ALLOWANCE_MS = 10_000;

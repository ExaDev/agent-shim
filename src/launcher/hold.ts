import type { LogPort } from "./ports";

/** What a launch does between its own last line of output and starting claude, as the resolved launch flags say. */
export interface LaunchHold {
  /** How long to wait, in milliseconds; zero for none. Ignored when `pause` is set. */
  readonly delayMs: number;
  /** Whether to wait for a key press instead of for a time. */
  readonly pause: boolean;
}

/** The effects a hold needs, so it runs against fakes in tests. */
export interface HoldPort {
  /** Whether a person is watching: standard input and standard output are both terminals. A launch nobody watches is never held. */
  readonly attended: () => boolean;
  /** Blocks for `ms` milliseconds. */
  readonly sleep: (ms: number) => void;
  /** Blocks until one key is pressed, and says whether it was the interrupt key (Ctrl-C), which a terminal in the mode this reads in delivers as a byte and not as a signal. */
  readonly waitForKey: () => "key" | "interrupt";
}

/** What a hold decided: carry on with the launch, or the person cancelled it. */
export type HoldOutcome = "go" | "cancelled";

/** The exit status of a launch the person cancelled at its pause: the shell's convention for an interrupt, 128 plus the interrupt signal's number. */
export const LAUNCH_CANCELLED_EXIT = 130;

const MS_PER_SECOND = 1000;

/** `ms` as the launch names it: whole seconds as `5s`, anything else in milliseconds. */
function describeDelay(ms: number): string {
  return ms % MS_PER_SECOND === 0 ? `${String(ms / MS_PER_SECOND)}s` : `${String(ms)}ms`;
}

/**
 * Holds the launch as `hold` says, after telling the person why nothing has happened: a pause waits for a key press and a delay for its time. Nothing is held when no port was given or nobody is watching, so a script, a pipe or a scheduled run is never slowed by a setting meant for a person reading a terminal. A pause takes the place of a delay.
 */
export function holdBeforeLaunch(hold: Readonly<LaunchHold>, port: HoldPort | undefined, log: Pick<LogPort, "info">): HoldOutcome {
  if (port === undefined || !port.attended() || (!hold.pause && hold.delayMs <= 0)) {
    return "go";
  }
  if (hold.pause) {
    log.info("agent-shim: paused before launch; press any key to start, or Ctrl-C to cancel");
    return port.waitForKey() === "interrupt" ? "cancelled" : "go";
  }
  log.info(`agent-shim: starting in ${describeDelay(hold.delayMs)}`);
  port.sleep(hold.delayMs);
  return "go";
}

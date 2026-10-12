import { CliError } from "./cliError";

/** What a process serves other processes as, which decides what it may block on. */
export type ProcessRole = "frontdoor-supervisor";

/** The role this process has entered, if any. Module state because a process has exactly one event loop and one role. */
let currentRole: ProcessRole | undefined;

/** Raised when code that blocks the calling thread runs in a process whose event loop serves other processes. */
export class BlockingInEventLoopError extends CliError {
  constructor(operation: string, role: ProcessRole) {
    super(
      `${operation} blocks the calling thread, which in the ${role} is the event loop that answers every session; ` +
        `it must not run there (a launch planned inside the door reaches it through its own addresses, never through the launcher's synchronous coordination)`,
    );
    this.name = "BlockingInEventLoopError";
  }
}

/**
 * Records that this process serves others as `role` from now on, and returns what puts the previous state back (tests use it; a real process never leaves its role). Entered by `runFrontDoorSupervisor` before it binds anything, so a library host running the door in process is covered as well as the `__frontdoor-supervisor` entry.
 */
export function enterProcessRole(role: ProcessRole): () => void {
  const previous = currentRole;
  currentRole = role;
  return () => {
    currentRole = previous;
  };
}

/**
 * Throws `BlockingInEventLoopError` when this process serves other processes. Called first by every primitive that blocks the calling thread (`Atomics.wait` sleeps and the synchronous probe), so a path that would stall the door fails loudly at its first step instead of freezing every session for the length of its wait.
 */
export function refuseToBlockInRole(operation: string): void {
  if (currentRole !== undefined) {
    throw new BlockingInEventLoopError(operation, currentRole);
  }
}

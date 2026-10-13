/**
 * Whether this process is the serving front door, declared by the supervisor when it starts and never read from `ps`.
 *
 * A door runs launches of its own (the usage probe, the window opener, jobs), and each one asks `ensureFrontDoor` whether the door it plans to use is alive. Asked about itself, the question has a known answer, and finding it out the other way costs a synchronous `ps` and a synchronous probe, both of which hold the door's own event loop: on a loaded machine they take seconds, every stream the door carries stalls for that long, and a probe that cannot be answered because the loop is held reads as a dead door, which the same launch then retires.
 */
let declaredPid: number | undefined;

/** Called once by the front-door supervisor, before it serves anything. */
export function declareThisProcessTheFrontDoor(): void {
  declaredPid = process.pid;
}

/**
 * Whether `pid` is a front-door supervisor: this process when it has declared itself one (no `ps`), otherwise whatever `identify` finds out about another process.
 */
export function isFrontDoorSupervisorPid(pid: number, identify: (pid: number) => boolean): boolean {
  return (declaredPid !== undefined && pid === declaredPid && pid === process.pid) || identify(pid);
}

/** Clears the declaration. For tests, which run in one process and must not leak a declaration into each other. */
export function resetFrontDoorDeclarationForTests(): void {
  declaredPid = undefined;
}

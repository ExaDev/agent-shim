/** What a process that wants to know about its blocking steps registers: `begin` is told how long a step may take at most, `end` that it has finished, `localWork` that a loop over local data has done another unit of its work, and `unboundedStepLimitMs` is the limit a step gets when its caller names none. */
export interface BlockingStepObserver {
  readonly begin: (boundMs: number) => void;
  readonly end: () => void;
  readonly localWork: () => void;
  readonly unboundedStepLimitMs: number;
}

/** The observer of this process, if one is registered. Module state because a process has one thread of blocking steps. */
let observer: BlockingStepObserver | undefined;

/** Registers `registered` as this process's observer and returns what removes it again. */
export function observeBlockingSteps(registered: BlockingStepObserver): () => void {
  const previous = observer;
  observer = registered;
  return () => {
    observer = previous;
  };
}

/**
 * Runs one step that blocks the calling thread (an external command, a wait on a probe worker) and tells the registered observer how long it may take: `declaredBoundMs` when the caller has one, else the observer's `unboundedStepLimitMs`, which `run` receives as the limit to apply, so that with an observer registered no blocking step is without a limit. Without an observer `run` receives `declaredBoundMs` as it was given (undefined, or zero, meaning no limit) and nothing is announced. The step is announced as ended however `run` ends.
 */
export function withBlockingStep<T>(declaredBoundMs: number | undefined, run: (boundMs: number | undefined) => T): T {
  if (observer === undefined) {
    return run(declaredBoundMs);
  }
  const bound = declaredBoundMs === undefined || declaredBoundMs <= 0 ? observer.unboundedStepLimitMs : declaredBoundMs;
  observer.begin(bound);
  try {
    return run(bound);
  } finally {
    observer.end();
  }
}

/**
 * Tells the registered observer that a loop over local data (the entries of a directory tree, the files of a directory) has done another unit of its work. The loop calls it once per unit, at the edge where the unit's filesystem call is made, so a loop that grows with the user's data reports progress for as long as it makes any, instead of looking like a stall. A no-op without an observer.
 */
export function noteLocalWork(): void {
  observer?.localWork();
}

/** The suffix every synchronous function of `node:fs` carries. */
const SYNC_SUFFIX = "Sync";

/**
 * Makes every synchronous function of `fsModule` (every export whose name ends in `Sync`) note a unit of local work before it runs, which is the one place a loop over the user's files can be seen from: a loop written later is counted without naming this module. Returns what puts the originals back. Meant for a process that reports progress (a report child) and applied to the one module object every importer shares, so an import written as a property access at the call site (as a bundler emits it) is wrapped as well.
 */
export function noteFileSystemWork(fsModule: object): () => void {
  const originals = new Map<string, unknown>();
  for (const name of Object.keys(fsModule).filter((candidate) => candidate.endsWith(SYNC_SUFFIX))) {
    const original: unknown = Reflect.get(fsModule, name);
    if (typeof original !== "function") {
      continue;
    }
    const wrapped = function (this: unknown, ...args: readonly unknown[]): unknown {
      noteLocalWork();
      return Reflect.apply(original, this, args);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    originals.set(name, original);
    Reflect.set(fsModule, name, wrapped);
  }
  return () => {
    for (const [name, original] of originals) {
      Reflect.set(fsModule, name, original);
    }
  };
}

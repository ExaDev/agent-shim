import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { acquireIdentityLock, identityLockPath, IdentityLockBusyError, IdentityLockLostError } from "./lock";

const IDENTITIES_DIR = "/home/testuser/.agent-shim/identities";

// A fixed sequence of fixture timestamps (ms), each test picking whichever of these represents "when this call happens" relative to the others.
const T0 = 1_000;
const T0_PLUS_100_MS = 1_100;
const T0_PLUS_200_MS = 1_200;
const T0_PLUS_1_MS = 1_001;
// Comfortably past acquireIdentityLock's own staleness window, so a lock acquired at T0 reads as stale by this time regardless of its holder's liveness.
const PAST_STALENESS_WINDOW_MS = 200_000;

const RETRY_DELAY_MS = 5;
const MAX_ATTEMPTS = 3;

// Fixture PIDs -- the exact values carry no meaning beyond "a" vs "a different" process; PID_HOLDER_VERBOSE is deliberately a different digit count so the "names the blocking process" test can assert on it unambiguously.
const PID_HOLDER = 42;
const PID_WAITER = 43;
const PID_HOLDER_VERBOSE = 4242;

function fakeSleep(): { sleep: (ms: number) => void; calls: number[] } {
  const calls: number[] = [];
  return { sleep: (ms: number) => { calls.push(ms); }, calls };
}

describe("acquireIdentityLock", () => {
  it("takes a free lock, records the holder, and removes the file on release", () => {
    const fs = createFakeFarmFs();
    const sleeper = fakeSleep();

    const lock = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_HOLDER,
      isRunning: () => true,
      sleep: sleeper.sleep,
    });

    expect(lock.path).toBe(identityLockPath(IDENTITIES_DIR, "work"));
    const record: unknown = JSON.parse(fs.readFileUtf8(lock.path) ?? "null");
    expect(record).toMatchObject({ identity: "work", pid: PID_HOLDER, acquiredAtMs: T0 });
    expect(sleeper.calls).toHaveLength(0);

    lock.release();
    expect(fs.readFileUtf8(lock.path)).toBeUndefined();
  });

  it("waits and then refuses when another live process holds the lock", () => {
    const fs = createFakeFarmFs();
    const sleeper = fakeSleep();
    const held = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_HOLDER,
      isRunning: () => true,
      sleep: sleeper.sleep,
    });

    expect(() =>
      acquireIdentityLock({
        identity: "work",
        dir: IDENTITIES_DIR,
        fs,
        nowMs: () => T0_PLUS_100_MS,
        pid: PID_WAITER,
        isRunning: () => true,
        sleep: sleeper.sleep,
        maxAttempts: MAX_ATTEMPTS,
        retryDelayMs: RETRY_DELAY_MS,
      }),
    ).toThrow(IdentityLockBusyError);
    expect(sleeper.calls).toEqual([RETRY_DELAY_MS, RETRY_DELAY_MS, RETRY_DELAY_MS]);

    // Serialisation, not exclusion: once the holder is done, the same waiter succeeds.
    held.release();
    const second = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0_PLUS_200_MS,
      pid: PID_WAITER,
      isRunning: () => true,
      sleep: sleeper.sleep,
      maxAttempts: MAX_ATTEMPTS,
    });
    expect(JSON.parse(fs.readFileUtf8(second.path) ?? "null")).toMatchObject({ pid: PID_WAITER });
  });

  it("names the blocking process in the error so a wedged lock is diagnosable", () => {
    const fs = createFakeFarmFs();
    acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_HOLDER_VERBOSE,
      isRunning: () => true,
      sleep: fakeSleep().sleep,
    });

    expect(() =>
      acquireIdentityLock({
        identity: "work",
        dir: IDENTITIES_DIR,
        fs,
        nowMs: () => T0,
        pid: PID_WAITER,
        isRunning: () => true,
        sleep: fakeSleep().sleep,
        maxAttempts: 1,
      }),
    ).toThrow(/pid 4242/);
  });

  it("steals a lock whose holder is no longer running", () => {
    const fs = createFakeFarmFs();
    acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_HOLDER,
      isRunning: () => true,
      sleep: fakeSleep().sleep,
    });

    const sleeper = fakeSleep();
    const stolen = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0_PLUS_1_MS,
      pid: PID_WAITER,
      isRunning: (pid) => pid === PID_WAITER,
      sleep: sleeper.sleep,
      maxAttempts: MAX_ATTEMPTS,
    });

    expect(JSON.parse(fs.readFileUtf8(stolen.path) ?? "null")).toMatchObject({ pid: PID_WAITER });
    expect(sleeper.calls).toHaveLength(0);
  });

  it("steals a lock older than the staleness window even when its holder is still alive", () => {
    const fs = createFakeFarmFs();
    acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_HOLDER,
      isRunning: () => true,
      sleep: fakeSleep().sleep,
    });

    const stolen = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0 + PAST_STALENESS_WINDOW_MS,
      pid: PID_WAITER,
      isRunning: () => true,
      sleep: fakeSleep().sleep,
      maxAttempts: MAX_ATTEMPTS,
    });

    expect(JSON.parse(fs.readFileUtf8(stolen.path) ?? "null")).toMatchObject({ pid: PID_WAITER });
  });

  it("steals a lock whose contents are unparseable, rather than waiting out a truncated write", () => {
    const fs = createFakeFarmFs();
    fs.mkdirp(IDENTITIES_DIR);
    fs.writeFileUtf8(identityLockPath(IDENTITIES_DIR, "work"), '{"identity":"wo');

    const lock = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_WAITER,
      isRunning: () => true,
      sleep: fakeSleep().sleep,
      maxAttempts: MAX_ATTEMPTS,
    });

    expect(JSON.parse(fs.readFileUtf8(lock.path) ?? "null")).toMatchObject({ pid: PID_WAITER });
  });

  it("does not release a lock another process has since taken", () => {
    const fs = createFakeFarmFs();
    const first = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0,
      pid: PID_HOLDER,
      isRunning: () => true,
      sleep: fakeSleep().sleep,
    });

    // The holder is presumed dead and its lock is taken by someone else; the original's own release must then be a no-op rather than unlocking the new holder.
    const second = acquireIdentityLock({
      identity: "work",
      dir: IDENTITIES_DIR,
      fs,
      nowMs: () => T0_PLUS_1_MS,
      pid: PID_WAITER,
      isRunning: (pid) => pid === PID_WAITER,
      sleep: fakeSleep().sleep,
    });
    first.release();

    expect(JSON.parse(fs.readFileUtf8(second.path) ?? "null")).toMatchObject({ pid: PID_WAITER, token: second.token });
  });
});

describe("IdentityLock.refresh", () => {
  /** The staleness window the lock uses when no override is given, which these tests stay inside or outside of on purpose. */
  const WITHIN_WINDOW_MS = 100_000;
  const NEARLY_A_WINDOW_LATER_MS = 150_000;

  function acquire(fs: ReturnType<typeof createFakeFarmFs>, clock: Readonly<{ now: number }>, pid: number) {
    return acquireIdentityLock({ identity: "work", dir: IDENTITIES_DIR, fs, nowMs: () => clock.now, pid, isRunning: () => true, sleep: () => undefined, maxAttempts: 2 });
  }

  it("restarts the staleness clock, so a holder that is alive and working is not taken for a crashed one", () => {
    const fs = createFakeFarmFs();
    const clock = { now: T0 };
    const lock = acquire(fs, clock, PID_HOLDER);
    clock.now = T0 + WITHIN_WINDOW_MS;
    lock.refresh();
    clock.now = T0 + NEARLY_A_WINDOW_LATER_MS;
    expect(() => acquire(fs, clock, PID_WAITER)).toThrow(IdentityLockBusyError);
    expect(fs.readFileUtf8(lock.path)).toContain(`"token":"${lock.token}"`);
  });

  it("does not, without a refresh, keep a lock past the staleness window: the control for the case above", () => {
    const fs = createFakeFarmFs();
    const clock = { now: T0 };
    acquire(fs, clock, PID_HOLDER);
    clock.now = T0 + NEARLY_A_WINDOW_LATER_MS;
    expect(() => acquire(fs, clock, PID_WAITER)).not.toThrow();
  });

  it("throws once another process has taken the lock, because the exclusion it stood for is gone", () => {
    const fs = createFakeFarmFs();
    const clock = { now: T0 };
    const lock = acquire(fs, clock, PID_HOLDER);
    clock.now = T0 + NEARLY_A_WINDOW_LATER_MS;
    acquire(fs, clock, PID_WAITER);
    expect(() => {
      lock.refresh();
    }).toThrow(IdentityLockLostError);
  });
});

describe("a waiter reading the lock while its holder refreshes it", () => {
  const CLOCK_MS = 1_000;
  const LATER_MS = 2_000;
  const BUDGET = 2;

  function holdWith(fs: ReturnType<typeof createFakeFarmFs>) {
    return acquireIdentityLock({ identity: "work", dir: IDENTITIES_DIR, fs, nowMs: () => CLOCK_MS, pid: PID_HOLDER, isRunning: () => true, sleep: () => undefined, maxAttempts: BUDGET });
  }

  function waitFor(fs: ReturnType<typeof createFakeFarmFs>): () => void {
    return () => {
      acquireIdentityLock({ identity: "work", dir: IDENTITIES_DIR, fs, nowMs: () => LATER_MS, pid: PID_WAITER, isRunning: () => true, sleep: () => undefined, maxAttempts: BUDGET });
    };
  }

  it("never sees a half-written record, because the refreshed record replaces the file whole instead of truncating it first", () => {
    const base = createFakeFarmFs();
    let truncations = 0;
    let waiterStole = false;
    // A truncating write: the file is empty for a moment, which is when a waiter polling every few milliseconds can read it.
    const truncating = {
      ...base,
      writeFileUtf8: (filePath: string, contents: string): void => {
        truncations += 1;
        base.writeFileUtf8(filePath, "");
        try {
          waitFor(base)();
          waiterStole = true;
        } catch (error) {
          if (!(error instanceof IdentityLockBusyError)) {
            throw error;
          }
        }
        base.writeFileUtf8(filePath, contents);
      },
    };
    const lock = holdWith(truncating);
    lock.refresh();
    expect(truncations).toBe(0);
    expect(waiterStole).toBe(false);
    expect(base.readFileUtf8(lock.path)).toContain(`"token":"${lock.token}"`);
    expect(() => {
      waitFor(base)();
    }).toThrow(IdentityLockBusyError);
  });

  it("does not take a lock for abandoned on one empty read, which a second read of the same file contradicts", () => {
    const base = createFakeFarmFs();
    const lock = holdWith(base);
    let reads = 0;
    const torn = {
      ...base,
      readFileUtf8: (filePath: string): string | undefined => {
        reads += 1;
        return reads === 1 ? "" : base.readFileUtf8(filePath);
      },
    };
    expect(() => {
      waitFor(torn)();
    }).toThrow(IdentityLockBusyError);
    expect(base.readFileUtf8(lock.path)).toContain(`"token":"${lock.token}"`);
  });

  it("leaves alone a lock that is released between the failed create and the read, rather than deleting whatever has been put there since", () => {
    const base = createFakeFarmFs();
    holdWith(base);
    let released = false;
    const racing = {
      ...base,
      readFileUtf8: (filePath: string): string | undefined => {
        if (!released) {
          released = true;
          // The holder lets go and a third process takes the lock, between this waiter's failed create and its read.
          base.removeRecursive(filePath);
          base.writeFileUtf8(filePath, `${JSON.stringify({ identity: "work", pid: PID_HOLDER_VERBOSE, token: "third", acquiredAtMs: CLOCK_MS })}\n`);
          return undefined;
        }
        return base.readFileUtf8(filePath);
      },
    };
    expect(() => {
      waitFor(racing)();
    }).toThrow(IdentityLockBusyError);
    expect(base.readFileUtf8(identityLockPath(IDENTITIES_DIR, "work"))).toContain('"token":"third"');
  });
});

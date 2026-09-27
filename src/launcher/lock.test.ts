import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { acquireIdentityLock, identityLockPath, IdentityLockBusyError } from "./lock";

const IDENTITIES_DIR = "/home/testuser/.claude-use/identities";

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

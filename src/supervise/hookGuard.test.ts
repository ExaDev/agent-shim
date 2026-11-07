import { describe, expect, it } from "vitest";

import { createFakeFarmFs, FAKE_NOW_MS, paths } from "../test-helpers";
import { announceHook, currentConversation, hooksPending } from "./hookGuard";
import { writeSessionState } from "./registry";

const POOL = "pool";
const SESSION = "88888888-8888-4888-8888-888888888888";
const FIRST = 4001;
const SECOND = 4002;

describe("hook guards", () => {
  it("announces a hook without taking the state lock while its input is pending", () => {
    const fs = createFakeFarmFs({});
    const deps = { fs, paths, now: () => FAKE_NOW_MS, isRunning: () => true, sleep: () => undefined, maxAttempts: 1 };
    const waiting = announceHook({ ...deps, pid: FIRST }, POOL, SESSION);
    const other = announceHook({ ...deps, pid: SECOND }, POOL, SESSION).acquire();
    expect(hooksPending(fs, paths, POOL, SESSION)).toBe(true);
    other.finish(true, false);
    const acquired = waiting.acquire();
    acquired.finish(true, false);
    expect(hooksPending(fs, paths, POOL, SESSION)).toBe(false);
  });
  it("does not expose a conversation while any hook is pending or its last observation failed", () => {
    const fs = createFakeFarmFs({});
    const deps = { fs, paths, now: () => FAKE_NOW_MS, isRunning: () => true, sleep: () => undefined, pid: FIRST, maxAttempts: 1 };
    writeSessionState(fs, paths, POOL, SESSION, { mark: "busy", at: new Date(FAKE_NOW_MS).toISOString() });
    expect(currentConversation(fs, paths, POOL, SESSION)).toBe(SESSION);
    const guard = announceHook(deps, POOL, SESSION).acquire();
    expect(currentConversation(fs, paths, POOL, SESSION)).toBeUndefined();
    guard.finish(false, false);
    expect(currentConversation(fs, paths, POOL, SESSION)).toBeUndefined();
  });
  it("serialises hook writes and keeps an unsuccessful hook visible until a later prompt establishes state", () => {
    const fs = createFakeFarmFs({});
    const running = new Set([FIRST, SECOND]);
    const deps = { fs, paths, now: () => FAKE_NOW_MS, isRunning: (pid: number) => running.has(pid), sleep: () => undefined, maxAttempts: 1 };
    const first = announceHook({ ...deps, pid: FIRST }, POOL, SESSION).acquire();
    expect(hooksPending(fs, paths, POOL, SESSION)).toBe(true);
    expect(() => announceHook({ ...deps, pid: SECOND }, POOL, SESSION).acquire()).toThrow();
    first.finish(true, false);
    expect(hooksPending(fs, paths, POOL, SESSION)).toBe(true);
    running.delete(SECOND);
    const next = announceHook({ ...deps, pid: FIRST }, POOL, SESSION).acquire();
    next.finish(true, true);
    expect(hooksPending(fs, paths, POOL, SESSION)).toBe(false);
  });

  it("retains the guard when processing fails", () => {
    const fs = createFakeFarmFs({});
    const guard = announceHook({ fs, paths, now: () => FAKE_NOW_MS, isRunning: () => true, sleep: () => undefined, pid: FIRST, maxAttempts: 1 }, POOL, SESSION).acquire();
    guard.finish(false, false);
    expect(hooksPending(fs, paths, POOL, SESSION)).toBe(true);
  });
});

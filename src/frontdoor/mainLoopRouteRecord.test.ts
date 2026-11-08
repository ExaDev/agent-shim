import { describe, expect, it } from "vitest";

import { FAKE_HOME, createFakeFarmFs, inMemoryRouteStore } from "../test-helpers";
import { createMainLoopRouteRecord, type MainLoopRoutePorts } from "./mainLoopRoute";
import { launchKeyOf, launchRouteStore, removeFrontDoorSession, writeFrontDoorSession, type FrontDoorLaunch } from "./state";

describe("the main-loop route record", () => {
  /** A registry whose launches the test starts and ends. */
  function registryOf(stored: MainLoopRoutePorts["stored"] = inMemoryRouteStore()): MainLoopRoutePorts & { readonly start: (launch: Readonly<FrontDoorLaunch>) => void; readonly end: (launch: Readonly<FrontDoorLaunch>) => void } {
    const launches = new Map<string, FrontDoorLaunch>();
    return {
      stored,
      log: () => undefined,
      holdsLaunch: (launch) => launches.has(launchKeyOf(launch)),
      start: (launch) => {
        launches.set(launchKeyOf(launch), launch);
      },
      end: (launch) => {
        launches.delete(launchKeyOf(launch));
      },
    };
  }
  const a: FrontDoorLaunch = { pid: 1, startedAt: 1 };
  const b: FrontDoorLaunch = { pid: 2, startedAt: 1 };

  it("drops an ended launch's entry on a write by another launch, so the same launch registered again finds nothing in memory", () => {
    // The durable copy answers nothing, so only the in-memory entry can say what was recorded; the launch is identical (pid and start time) when it is registered again, so the one thing that can make the second read empty is the eviction.
    const live = new Set<FrontDoorLaunch>([a, b]);
    const record = createMainLoopRouteRecord({ holdsLaunch: (held) => live.has(held), stored: { read: () => undefined, write: () => undefined }, log: () => undefined });
    record.record(a, { kind: "provider", provider: "z" });
    expect(record.routeOf(a)).toEqual({ kind: "provider", provider: "z" });
    live.delete(a);
    record.record(b, { kind: "anthropic" });
    live.add(a);
    expect(record.routeOf(a)).toBeUndefined();
    expect(record.routeOf(b)).toEqual({ kind: "anthropic" });
  });

  it("gives a launch registered again under the same pid, and so a new start time, nothing recorded", () => {
    const registry = registryOf();
    const record = createMainLoopRouteRecord(registry);
    registry.start(a);
    record.record(a, { kind: "provider", provider: "z" });
    registry.end(a);
    const relaunched: FrontDoorLaunch = { pid: a.pid, startedAt: 2 };
    registry.start(relaunched);
    expect(record.routeOf(relaunched)).toBeUndefined();
  });

  it("is found again by a record built later over the same store, as after a door restart, and by that launch only", () => {
    const stored = inMemoryRouteStore();
    const before = registryOf(stored);
    before.start(a);
    createMainLoopRouteRecord(before).record(a, { kind: "provider", provider: "z" });
    // A new door process: nothing in memory, the registry still holds the launch.
    const after = registryOf(stored);
    after.start(a);
    after.start(b);
    const restarted = createMainLoopRouteRecord(after);
    expect(restarted.routeOf(a)).toEqual({ kind: "provider", provider: "z" });
    expect(restarted.routeOf(b)).toBeUndefined();
  });

  it("writes the store only when the route changes", () => {
    const writes: string[] = [];
    const base = inMemoryRouteStore();
    const registry = registryOf({
      read: base.read,
      write: (launch, route) => {
        writes.push(route.kind === "provider" ? route.provider : route.kind);
        base.write(launch, route);
      },
    });
    registry.start(a);
    const record = createMainLoopRouteRecord(registry);
    record.record(a, { kind: "provider", provider: "z" });
    record.record(a, { kind: "provider", provider: "z" });
    record.record(a, { kind: "anthropic" });
    record.record(a, { kind: "anthropic" });
    expect(writes).toEqual(["z", "anthropic"]);
  });
});

describe("a main-loop record whose store fails", () => {
  it("keeps the route in memory, reports the failure once and lets the request through", () => {
    const lines: string[] = [];
    const launch: FrontDoorLaunch = { pid: 9, startedAt: 1 };
    const record = createMainLoopRouteRecord({
      holdsLaunch: () => true,
      stored: {
        read: () => undefined,
        write: () => {
          throw new Error("disk full");
        },
      },
      log: (line) => {
        lines.push(line);
      },
    });
    record.record(launch, { kind: "provider", provider: "z" });
    record.record(launch, { kind: "anthropic" });
    expect(record.routeOf(launch)).toEqual({ kind: "anthropic" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("disk full");
  });
});

describe("the route file of a launch whose registry record is gone", () => {
  const SESSIONS_DIR = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
  const launch: FrontDoorLaunch = { pid: 4242, startedAt: 7 };

  it("is not written when the launch's record was removed after the door's cached view admitted the request", () => {
    const fs = createFakeFarmFs();
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const store = launchRouteStore(fs, SESSIONS_DIR);
    // The view still holds the launch (it refreshes at the next tick), while the launcher has already released it on disk.
    const record = createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log: () => undefined });
    removeFrontDoorSession(fs, SESSIONS_DIR, launch.pid);
    record.record(launch, { kind: "provider", provider: "z" });
    expect(fs.readdir(SESSIONS_DIR)).toEqual([]);
    expect(store.read(launch)).toBeUndefined();
  });

  it("is written while the record is on disk, and not for a record of another start time under the pid", () => {
    const fs = createFakeFarmFs();
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const store = launchRouteStore(fs, SESSIONS_DIR);
    store.write(launch, { kind: "provider", provider: "z" });
    expect(store.read(launch)).toEqual({ kind: "provider", provider: "z" });
    const earlier: FrontDoorLaunch = { pid: launch.pid, startedAt: launch.startedAt - 1 };
    store.write(earlier, { kind: "anthropic" });
    expect(store.read(launch)).toEqual({ kind: "provider", provider: "z" });
  });
});

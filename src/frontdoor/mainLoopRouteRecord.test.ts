import { describe, expect, it } from "vitest";

import { FAKE_HOME, createFakeFarmFs, inMemoryRouteStore } from "../test-helpers";
import { createMainLoopRouteRecord, type MainLoopRoutePorts } from "./mainLoopRoute";
import { launchKeyOf, launchRouteStore, type MainLoopRoute, removeFrontDoorSession, writeFrontDoorSession, type FrontDoorLaunch } from "./state";

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
    record.record(a, { kind: "provider", provider: "y" });
    record.record(a, { kind: "provider", provider: "y" });
    record.record(a, { kind: "anthropic" });
    record.record(a, { kind: "anthropic" });
    expect(writes).toEqual(["z", "y", "anthropic"]);
  });
});

describe("a main-loop record whose store fails", () => {
  it("keeps the route in memory and reports a failing store once per launch", () => {
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
    expect(lines[0]).toMatch(/^front door: .*disk full$/);
  });

  it("rewrites the stale durable copy once the store recovers, on the next request that records the current route", () => {
    const launch: FrontDoorLaunch = { pid: 9, startedAt: 1 };
    const store = inMemoryRouteStore();
    let failing = true;
    const ports: MainLoopRoutePorts = {
      holdsLaunch: () => true,
      stored: {
        read: store.read,
        write: (written, route) => {
          if (failing) {
            throw new Error("disk full");
          }
          store.write(written, route);
        },
      },
      log: () => undefined,
    };
    const record = createMainLoopRouteRecord(ports);
    failing = false;
    record.record(launch, { kind: "provider", provider: "z" });
    failing = true;
    record.record(launch, { kind: "anthropic" });
    failing = false;
    record.record(launch, { kind: "anthropic" });
    expect(store.read(launch)).toEqual({ kind: "anthropic" });
    expect(createMainLoopRouteRecord(ports).routeOf(launch)).toEqual({ kind: "anthropic" });
  });

  it("reports once for each launch, and again for a launch whose entry was evicted and that is registered again", () => {
    const lines: string[] = [];
    const first: FrontDoorLaunch = { pid: 1, startedAt: 1 };
    const second: FrontDoorLaunch = { pid: 2, startedAt: 1 };
    const live = new Set<FrontDoorLaunch>([first, second]);
    const record = createMainLoopRouteRecord({
      holdsLaunch: (held) => live.has(held),
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
    record.record(first, { kind: "provider", provider: "z" });
    record.record(first, { kind: "anthropic" });
    expect(lines).toHaveLength(1);
    record.record(second, { kind: "provider", provider: "z" });
    expect(lines).toHaveLength(2);
    live.delete(first);
    record.record(second, { kind: "anthropic" });
    live.add(first);
    record.record(first, { kind: "provider", provider: "z" });
    expect(lines.map((line) => /launch (\d+)'s/.exec(line)?.[1])).toEqual(["1", "2", "1"]);
  });
});

describe("a main-loop record over a durable copy that fails", () => {
  const launch: FrontDoorLaunch = { pid: 9, startedAt: 1 };
  const z: MainLoopRoute = { kind: "provider", provider: "z" };

  /** A store that fails its writes while `failing.writes` and its reads while `failing.reads`, counting every call. */
  function flaky(): { readonly ports: MainLoopRoutePorts; readonly failing: { writes: boolean; reads: boolean }; readonly lines: string[]; readonly calls: { reads: number; writes: number }; readonly store: ReturnType<typeof inMemoryRouteStore> } {
    const store = inMemoryRouteStore();
    const failing = { writes: false, reads: false };
    const lines: string[] = [];
    const calls = { reads: 0, writes: 0 };
    return {
      failing,
      lines,
      calls,
      store,
      ports: {
        holdsLaunch: () => true,
        stored: {
          read: (held) => {
            calls.reads += 1;
            if (failing.reads) {
              throw new Error("route file is version 2");
            }
            return store.read(held);
          },
          write: (held, route) => {
            calls.writes += 1;
            if (failing.writes) {
              throw new Error("disk full");
            }
            store.write(held, route);
          },
        },
        log: (line) => {
          lines.push(line);
        },
      },
    };
  }

  it("retries the durable write on a helper's lookup too, not only on the next main-loop request, and stops once it has succeeded", () => {
    const world = flaky();
    const record = createMainLoopRouteRecord(world.ports);
    world.failing.writes = true;
    record.record(launch, z);
    expect(world.store.read(launch)).toBeUndefined();
    world.failing.writes = false;
    expect(record.routeOf(launch)).toEqual(z);
    expect(world.store.read(launch)).toEqual(z);
    const writes = world.calls.writes;
    record.routeOf(launch);
    record.routeOf(launch);
    expect(world.calls.writes).toBe(writes);
  });

  it("makes at most one attempt per lookup while the store keeps failing, and reports once", () => {
    const world = flaky();
    world.failing.writes = true;
    const record = createMainLoopRouteRecord(world.ports);
    record.record(launch, z);
    const afterRecord = world.calls.writes;
    record.routeOf(launch);
    record.routeOf(launch);
    expect(world.calls.writes).toBe(afterRecord + 2);
    expect(world.lines).toHaveLength(1);
  });

  it("reports a failure again after the store recovered and failed afresh", () => {
    const world = flaky();
    const record = createMainLoopRouteRecord(world.ports);
    world.failing.writes = true;
    record.record(launch, z);
    world.failing.writes = false;
    record.record(launch, { kind: "anthropic" });
    world.failing.writes = true;
    record.record(launch, z);
    expect(world.lines).toHaveLength(2);
  });

  it("reports an unreadable durable copy once per launch, counts it as no route, and does not read it again for every helper", () => {
    const world = flaky();
    world.failing.reads = true;
    const record = createMainLoopRouteRecord(world.ports);
    expect(record.routeOf(launch)).toBeUndefined();
    expect(record.routeOf(launch)).toBeUndefined();
    expect(record.routeOf(launch)).toBeUndefined();
    expect(world.calls.reads).toBe(1);
    expect(world.lines).toHaveLength(1);
    expect(world.lines[0]).toContain("version 2");
  });

  it("reads the durable copy once per launch, a miss included, until the launch's first main-loop request", () => {
    const world = flaky();
    const record = createMainLoopRouteRecord(world.ports);
    expect(record.routeOf(launch)).toBeUndefined();
    expect(record.routeOf(launch)).toBeUndefined();
    expect(world.calls.reads).toBe(1);
    record.record(launch, z);
    expect(record.routeOf(launch)).toEqual(z);
    expect(world.calls.reads).toBe(1);
  });

  it("caches a stored route it read back, and does not rewrite it when the main loop records the same route", () => {
    const world = flaky();
    world.store.write(launch, z);
    const writes = world.calls.writes;
    const record = createMainLoopRouteRecord(world.ports);
    expect(record.routeOf(launch)).toEqual(z);
    expect(record.routeOf(launch)).toEqual(z);
    expect(world.calls.reads).toBe(1);
    record.record(launch, z);
    expect(world.calls.writes).toBe(writes);
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

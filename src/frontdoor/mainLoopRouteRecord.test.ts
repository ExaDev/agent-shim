import { describe, expect, it } from "vitest";

import { FAKE_HOME, createFakeFarmFs, inMemoryRouteStore } from "../test-helpers";
import { createMainLoopRouteRecord, type MainLoopRoutePorts } from "./mainLoopRoute";
import { launchKeyOf, launchRouteStore, type RouteContext, removeFrontDoorSession, writeFrontDoorSession, type FrontDoorLaunch } from "./state";

/** Versions of the route file past the one this door writes, up to well beyond what any door will reach. */
const NEXT_VERSION = 2;
const THIRD_VERSION = 3;
const NEAR_HUNDRED_VERSION = 99;
const HUNDRED_VERSION = 100;
const NEWER_VERSIONS: readonly number[] = [NEXT_VERSION, THIRD_VERSION, NEAR_HUNDRED_VERSION, HUNDRED_VERSION];

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
    const record = createMainLoopRouteRecord({ holdsLaunch: (held) => live.has(held), stored: { read: () => undefined, write: () => undefined, identity: () => undefined }, log: () => undefined });
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
      identity: base.identity,
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
        identity: () => undefined,
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
        identity: store.identity,
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
        identity: () => undefined,
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
  const z: RouteContext = { kind: "provider", provider: "z" };

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
          identity: store.identity,
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

  it("does not read back the copy a retried write made itself", () => {
    const world = flaky();
    const record = createMainLoopRouteRecord(world.ports);
    world.failing.writes = true;
    record.record(launch, z);
    world.failing.writes = false;
    expect(record.routeOf(launch)).toEqual(z);
    expect(record.routeOf(launch)).toEqual(z);
    expect(record.routeOf(launch)).toEqual(z);
    expect(world.calls.reads).toBe(0);
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

describe("two doors over one durable copy", () => {
  const launch: FrontDoorLaunch = { pid: 9, startedAt: 1 };
  const z: RouteContext = { kind: "provider", provider: "z" };

  /** Two records, standing for the old door and its replacement, over one store that counts every read. */
  function twoDoors(): { readonly a: ReturnType<typeof createMainLoopRouteRecord>; readonly b: ReturnType<typeof createMainLoopRouteRecord>; readonly reads: { count: number }; readonly store: ReturnType<typeof inMemoryRouteStore> } {
    const store = inMemoryRouteStore();
    const reads = { count: 0 };
    const ports: MainLoopRoutePorts = {
      holdsLaunch: () => true,
      stored: {
        identity: store.identity,
        write: store.write,
        read: (held) => {
          reads.count += 1;
          return store.read(held);
        },
      },
      log: () => undefined,
    };
    return { a: createMainLoopRouteRecord(ports), b: createMainLoopRouteRecord(ports), reads, store };
  }

  it("follows a route another door wrote after this one cached a miss", () => {
    const { a, b } = twoDoors();
    expect(a.routeOf(launch)).toBeUndefined();
    b.record(launch, z);
    expect(a.routeOf(launch)).toEqual(z);
  });

  it("follows a route another door rewrote after this one cached the one it had read", () => {
    const { a, b } = twoDoors();
    b.record(launch, z);
    expect(a.routeOf(launch)).toEqual(z);
    b.record(launch, { kind: "anthropic" });
    expect(a.routeOf(launch)).toEqual({ kind: "anthropic" });
  });

  it("does not read the copy again while it is unchanged, however many helpers ask, a miss included", () => {
    const { a, b, reads } = twoDoors();
    a.routeOf(launch);
    a.routeOf(launch);
    expect(reads.count).toBe(1);
    b.record(launch, z);
    a.routeOf(launch);
    a.routeOf(launch);
    a.routeOf(launch);
    expect(reads.count).toBe(2);
  });

  it("does not take its own write for another door's, so a route it recorded is not read back", () => {
    const { a, reads } = twoDoors();
    a.record(launch, z);
    a.routeOf(launch);
    a.routeOf(launch);
    expect(reads.count).toBe(0);
  });

  it("keeps a route it holds unwritten (the store failed) over what the copy says, since its own main loop is the newer", () => {
    const store = inMemoryRouteStore();
    store.write(launch, z);
    let failing = true;
    const record = createMainLoopRouteRecord({
      holdsLaunch: () => true,
      stored: {
        identity: store.identity,
        read: store.read,
        write: (held, route) => {
          if (failing) {
            throw new Error("disk full");
          }
          store.write(held, route);
        },
      },
      log: () => undefined,
    });
    record.record(launch, { kind: "anthropic" });
    expect(record.routeOf(launch)).toEqual({ kind: "anthropic" });
    failing = false;
    expect(record.routeOf(launch)).toEqual({ kind: "anthropic" });
    expect(store.read(launch)).toEqual({ kind: "anthropic" });
  });
});

describe("a route store whose stat fails", () => {
  const SESSIONS_DIR = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
  const launch: FrontDoorLaunch = { pid: 4242, startedAt: 7 };
  const z: RouteContext = { kind: "provider", provider: "z" };
  const routeFile = `${SESSIONS_DIR}/${String(launch.pid)}.route.json`;
  /** How many helper lookups follow a failing stat: more than one, so a read per lookup is told from a read once. */
  const LOOKUPS = 5;

  /** The real store over a fake filesystem whose `lstat` of the route file throws EACCES while `denied.stat`, counting the reads of the route file and failing its writes while `denied.write`. */
  function world(): { readonly record: ReturnType<typeof createMainLoopRouteRecord>; readonly store: ReturnType<typeof launchRouteStore>; readonly denied: { stat: boolean; write: boolean }; readonly reads: { count: number }; readonly lines: string[]; readonly fs: ReturnType<typeof createFakeFarmFs> } {
    const base = createFakeFarmFs();
    writeFrontDoorSession(base, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const denied = { stat: false, write: false };
    const reads = { count: 0 };
    const lines: string[] = [];
    const fs: ReturnType<typeof createFakeFarmFs> = {
      ...base,
      lstat: (target) => {
        if (denied.stat && target === routeFile) {
          const refusal: NodeJS.ErrnoException = new Error("EACCES: permission denied");
          refusal.code = "EACCES";
          throw refusal;
        }
        return base.lstat(target);
      },
      readFileUtf8: (target) => {
        if (target === routeFile) {
          reads.count += 1;
        }
        return base.readFileUtf8(target);
      },
      writeFilePrivate: (target, contents) => {
        if (denied.write && target === routeFile) {
          throw new Error("disk full");
        }
        base.writeFilePrivate(target, contents);
      },
    };
    const store = launchRouteStore(fs, SESSIONS_DIR, (line) => {
      lines.push(line);
    });
    const record = createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log: () => undefined });
    return { record, store, denied, reads, lines, fs };
  }

  it("returns no identity and reports once per launch, until a stat succeeds", () => {
    const w = world();
    w.denied.stat = true;
    expect(w.store.identity(launch)).toBeUndefined();
    expect(w.store.identity(launch)).toBeUndefined();
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain("EACCES");
    w.denied.stat = false;
    expect(w.store.identity(launch)).toBeUndefined();
    w.denied.stat = true;
    w.store.identity(launch);
    expect(w.lines).toHaveLength(2);
  });

  it("fails no request at a helper's first lookup, and routes it by what the copy holds", () => {
    const w = world();
    w.store.write(launch, z);
    w.denied.stat = true;
    expect(w.record.routeOf(launch)).toEqual(z);
  });

  it("fails no main-loop request after it wrote, and records the route", () => {
    const w = world();
    w.denied.stat = true;
    expect(() => {
      w.record.record(launch, z);
    }).not.toThrow();
    expect(w.record.routeOf(launch)).toEqual(z);
    expect(w.store.read(launch)).toEqual(z);
  });

  it("fails no helper lookup that retries a write, and no lookup that compares", () => {
    const w = world();
    w.denied.write = true;
    w.record.record(launch, z);
    w.denied.write = false;
    w.denied.stat = true;
    expect(w.record.routeOf(launch)).toEqual(z);
    expect(w.store.read(launch)).toEqual(z);
    expect(w.record.routeOf(launch)).toEqual(z);
  });

  it("never turns a stat that starts failing after a read into a read of the copy per helper", () => {
    const w = world();
    w.store.write(launch, z);
    expect(w.record.routeOf(launch)).toEqual(z);
    const afterFirst = w.reads.count;
    w.denied.stat = true;
    for (let lookup = 0; lookup < LOOKUPS; lookup += 1) {
      expect(w.record.routeOf(launch)).toEqual(z);
    }
    expect(w.reads.count).toBe(afterFirst);
  });

  it("never turns a stat that keeps failing into a read of the copy per helper: an unknown identity forces no read", () => {
    const w = world();
    w.denied.stat = true;
    expect(w.record.routeOf(launch)).toBeUndefined();
    const afterFirst = w.reads.count;
    for (let lookup = 0; lookup < LOOKUPS; lookup += 1) {
      w.record.routeOf(launch);
    }
    expect(w.reads.count).toBe(afterFirst);
  });
});

describe("a context that changes only in the credential it names", () => {
  const launch: FrontDoorLaunch = { pid: 9, startedAt: 1 };

  it("is written again when the credential's name changed, and not when it did not", () => {
    const writes: (string | undefined)[] = [];
    const base = inMemoryRouteStore();
    const record = createMainLoopRouteRecord({
      holdsLaunch: () => true,
      stored: {
        read: base.read,
        identity: base.identity,
        write: (held, route) => {
          writes.push(route.credential);
          base.write(held, route);
        },
      },
      log: () => undefined,
    });
    const route = { kind: "provider", provider: "z" } as const;
    record.record(launch, { ...route, credential: "bearer from env A" });
    record.record(launch, { ...route, credential: "bearer from env A" });
    record.record(launch, { ...route, credential: "bearer from env B" });
    record.record(launch, { ...route, credential: "bearer from env B" });
    expect(writes).toEqual(["bearer from env A", "bearer from env B"]);
  });
});

describe("a route file of a version this door does not know, over the real store", () => {
  const SESSIONS_DIR = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
  const launch: FrontDoorLaunch = { pid: 4242, startedAt: 7 };

  function over(version: number): { readonly lines: string[]; readonly record: ReturnType<typeof createMainLoopRouteRecord> } {
    const fs = createFakeFarmFs();
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    fs.writeFilePrivate(`${SESSIONS_DIR}/${String(launch.pid)}.route.json`, `${JSON.stringify({ version, startedAt: launch.startedAt, route: { kind: "provider", provider: "z" } })}\n`);
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };
    return { lines, record: createMainLoopRouteRecord({ holdsLaunch: () => true, stored: launchRouteStore(fs, SESSIONS_DIR, log), log }) };
  }

  it.each(NEWER_VERSIONS)("is reported once and counted as no route when it is version %s", (version) => {
    const { lines, record } = over(version);
    expect(record.routeOf(launch)).toBeUndefined();
    expect(record.routeOf(launch)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("written by a newer door");
  });

  it("is read as a provider-only context when it is version 1", () => {
    const { lines, record } = over(1);
    expect(record.routeOf(launch)).toEqual({ kind: "provider", provider: "z" });
    expect(lines).toEqual([]);
  });
});

describe("a launch that ended while only helper lookups arrived", () => {
  it("drops an ended launch's entry when another launch is first looked up, so the same launch registered again reads the store afresh", () => {
    const store = inMemoryRouteStore();
    let reads = 0;
    const live = new Set<string>(["a", "b"]);
    const a: FrontDoorLaunch = { pid: 1, startedAt: 1 };
    const b: FrontDoorLaunch = { pid: 2, startedAt: 1 };
    const names = new Map<string, string>([[launchKeyOf(a), "a"], [launchKeyOf(b), "b"]]);
    const record = createMainLoopRouteRecord({
      holdsLaunch: (held) => live.has(names.get(launchKeyOf(held)) ?? ""),
      stored: {
        identity: store.identity,
        write: store.write,
        read: (held) => {
          reads += 1;
          return store.read(held);
        },
      },
      log: () => undefined,
    });
    record.routeOf(a);
    const afterFirst = reads;
    live.delete("a");
    record.routeOf(b);
    const afterOther = reads;
    live.add("a");
    record.routeOf(a);
    // The other launch read the store once, and the launch that had ended and came back read it afresh.
    expect(afterOther).toBe(afterFirst + 1);
    expect(reads).toBe(afterOther + 1);
  });
});

describe("the route file of a launch whose registry record is gone", () => {
  const SESSIONS_DIR = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
  const launch: FrontDoorLaunch = { pid: 4242, startedAt: 7 };

  it("is not written when the launch's record was removed after the door's cached view admitted the request", () => {
    const fs = createFakeFarmFs();
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const store = launchRouteStore(fs, SESSIONS_DIR, () => undefined);
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
    const store = launchRouteStore(fs, SESSIONS_DIR, () => undefined);
    store.write(launch, { kind: "provider", provider: "z" });
    expect(store.read(launch)).toEqual({ kind: "provider", provider: "z" });
    const earlier: FrontDoorLaunch = { pid: launch.pid, startedAt: launch.startedAt - 1 };
    store.write(earlier, { kind: "anthropic" });
    expect(store.read(launch)).toEqual({ kind: "provider", provider: "z" });
  });
});

describe("a context that changes only in the models it names", () => {
  const launch: FrontDoorLaunch = { pid: 9, startedAt: 1 };

  it.each([["the model asked for", "requestedModel"], ["the model served", "servedModel"]] as const)("is written again when %s changed, and not when it did not", (_label, field) => {
    const writes: (string | undefined)[] = [];
    const base = inMemoryRouteStore();
    const record = createMainLoopRouteRecord({
      holdsLaunch: () => true,
      stored: {
        read: base.read,
        identity: base.identity,
        write: (held, route) => {
          writes.push(route[field]);
          base.write(held, route);
        },
      },
      log: () => undefined,
    });
    const route = { kind: "provider", provider: "z" } as const;
    record.record(launch, { ...route, [field]: "model-a" });
    record.record(launch, { ...route, [field]: "model-a" });
    record.record(launch, { ...route, [field]: "model-b" });
    record.record(launch, { ...route, [field]: "model-b" });
    expect(writes).toEqual(["model-a", "model-b"]);
  });
});

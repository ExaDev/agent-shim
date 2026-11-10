import * as net from "node:net";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { SourcePortRange } from "./connectEffects";
import { createDoorLookup, doorDial, sourcePortClassifier, type DialOutcome } from "./doorDial";
import { SilentSocket, scriptedDials, unusableOn } from "./sourcePortRotationTestWorld";

/** `fn` evaluated from its source text alone in a fresh context, as the probe's worker evaluates it. */
function isolated<F extends { readonly toString: () => string }>(fn: F): F {
  return vm.runInNewContext(`(${fn.toString()})`, { Promise, Error, String }) as F;
}

const RANGE_START = 1;
const RANGE_END = 3;

describe("which source-port failures move the rotation on", () => {
  const BIND_REFUSED = "EACCES@bind";
  const RANGE_WIDTH = RANGE_END - RANGE_START + 1;

  /** Dials a name over a scripted `connect` for `platform`, returning the outcome and every source port tried. */
  async function dialOn(platform: string, script: readonly (string | undefined)[]): Promise<{ readonly outcome: DialOutcome<SilentSocket>; readonly ports: readonly (number | undefined)[] }> {
    const dials = scriptedDials(script);
    const outcome = await doorDial(
      { connect: dials.connect, lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }), isIP: net.isIP, sourcePortFailure: unusableOn(platform) },
      { host: "provider.example", port: 443 },
      new SourcePortRange(RANGE_START, RANGE_END),
    );
    return { outcome, ports: dials.dialled.map((options) => options.localPort) };
  }

  it.each([
    ["win32", "EADDRINUSE@bind", "held"],
    ["win32", "EADDRNOTAVAIL@connect", "held"],
    ["win32", "EACCES@bind", "excluded"],
    ["win32", "EACCES@connect", undefined],
    ["win32", "EACCES", undefined],
    ["win32", "ECONNREFUSED@connect", undefined],
    ["linux", "EADDRINUSE@bind", "held"],
    ["linux", "EADDRNOTAVAIL@connect", "held"],
    ["linux", "EACCES@bind", undefined],
    ["darwin", "EACCES@bind", undefined],
    ["darwin", "EACCES@connect", undefined],
    ["freebsd", "EACCES@bind", undefined],
  ] as const)("on %s a %s failure of a source port is %s", (platform, failure, kind) => {
    expect(sourcePortClassifier(platform)(failureOf(failure))).toBe(kind);
  });

  /** An error as node reports one: the code and the syscall it failed in. */
  function failureOf(failure: string): NodeJS.ErrnoException {
    const [code, syscall] = failure.split("@");
    const error: NodeJS.ErrnoException = new Error(failure);
    error.code = code;
    if (syscall !== undefined) {
      error.syscall = syscall;
    }
    return error;
  }

  /** The error node rejects with when a name resolves to several addresses and every attempt fails: an AggregateError with an empty message, whose code is borrowed from an attempt and whose syscall is absent, and whose `errors` hold each attempt's own. Shape read from `net.connect` on a held source port (EADDRINUSE with sub-errors `bind` and `connect`). */
  function aggregateOf(...attempts: readonly string[]): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new AggregateError(attempts.map(failureOf), "");
    error.code = failureOf(attempts[0] ?? "").code;
    return error;
  }

  it.each([
    ["win32", ["EACCES@bind", "EACCES@bind"], "excluded"],
    ["win32", ["EACCES@bind", "EADDRINUSE@bind"], "excluded"],
    ["win32", ["EADDRINUSE@bind", "EADDRINUSE@bind"], "held"],
    ["win32", ["EACCES@bind", "ECONNREFUSED@connect"], undefined],
    ["win32", ["EACCES@bind", "EACCES@connect"], undefined],
    ["linux", ["EACCES@bind", "EACCES@bind"], undefined],
    ["linux", ["EADDRINUSE@bind", "EADDRINUSE@bind"], "held"],
    ["linux", ["EADDRINUSE@bind", "ECONNREFUSED@connect"], undefined],
  ] as const)("on %s an AggregateError of %j is judged by its attempts: %s", (platform, attempts, kind) => {
    expect(sourcePortClassifier(platform)(aggregateOf(...attempts))).toBe(kind);
  });

  it("judges a nested AggregateError by its attempts too", () => {
    const nested: NodeJS.ErrnoException = new AggregateError([aggregateOf("EACCES@bind", "EACCES@bind"), failureOf("EACCES@bind")], "");
    expect(sourcePortClassifier("win32")(nested)).toBe("excluded");
    expect(sourcePortClassifier("linux")(nested)).toBeUndefined();
  });

  it("moves past a port Windows excludes (EACCES at the bind) and connects from the next one", async () => {
    const { outcome, ports } = await dialOn("win32", [BIND_REFUSED, BIND_REFUSED, undefined]);
    expect(outcome.error).toBeNull();
    expect(ports).toEqual([RANGE_START, RANGE_START + 1, RANGE_START + 2]);
  });

  it("fails a bind refused with EACCES at once on a platform that excludes no ranges, since there it is a real error", async () => {
    for (const platform of ["linux", "darwin"]) {
      const { outcome, ports } = await dialOn(platform, [BIND_REFUSED, undefined]);
      expect(outcome.error?.code, platform).toBe("EACCES");
      expect(ports, platform).toHaveLength(1);
    }
  });

  it("never treats a destination's EACCES as a source-port problem, on Windows or anywhere", async () => {
    for (const platform of ["win32", "linux", "darwin"]) {
      const { outcome, ports } = await dialOn(platform, ["EACCES@connect", undefined]);
      expect(outcome.error?.code, platform).toBe("EACCES");
      expect(ports, platform).toHaveLength(1);
    }
  });

  it("stops after one attempt per port when Windows excludes the whole range, and names the range and the command that lists the excluded ranges", async () => {
    const { outcome, ports } = await dialOn("win32", Array.from({ length: RANGE_WIDTH * 2 }, () => BIND_REFUSED));
    expect(ports).toHaveLength(RANGE_WIDTH);
    expect(outcome.error?.code).toBe("EACCES");
    expect(outcome.error?.message).toContain(`${String(RANGE_START)} to ${String(RANGE_END)}`);
    expect(outcome.error?.message).toContain("netsh int ipv4 show excludedportrange protocol=tcp");
  });

  it("stops after one attempt per port when every port is held, surfacing the last bind error as before", async () => {
    const { outcome, ports } = await dialOn("linux", Array.from({ length: RANGE_WIDTH * 2 }, () => "EADDRINUSE@bind"));
    expect(ports).toHaveLength(RANGE_WIDTH);
    expect(outcome.error?.code).toBe("EADDRINUSE");
  });

  it("keeps the failing syscall through the trimming of node's local-end suffix", async () => {
    let handed: NodeJS.ErrnoException | undefined;
    const outcome = await doorDial(
      {
        connect: () => {
          const socket = new SilentSocket();
          queueMicrotask(() => {
            const failure: NodeJS.ErrnoException = new Error("bind EACCES 0.0.0.0:48000 - Local (0.0.0.0:48000)");
            failure.code = "EACCES";
            failure.syscall = "bind";
            socket.emit("error", failure);
          });
          return socket;
        },
        lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
        isIP: net.isIP,
        sourcePortFailure: (error) => {
          handed = error;
          return undefined;
        },
      },
      { host: "provider.example", port: 443 },
      new SourcePortRange(RANGE_START, RANGE_END),
    );
    expect(outcome.error?.message).not.toContain("Local");
    expect(handed?.syscall).toBe("bind");
  });

  it("classifies the same from its source text alone, as the probe's worker runs it", () => {
    const isolatedClassifier = isolated(sourcePortClassifier);
    const bind: NodeJS.ErrnoException = new Error("bind");
    bind.code = "EACCES";
    bind.syscall = "bind";
    expect(isolatedClassifier("win32")(bind)).toBe("excluded");
    expect(isolatedClassifier("linux")(bind)).toBeUndefined();
  });

  it("moves past an excluded port when the name resolves to several addresses and every attempt is refused at the bind, as node reports it for localhost", async () => {
    const bothBinds = "AGG:EACCES@bind|EACCES@bind";
    const { outcome, ports } = await dialOn("win32", [bothBinds, bothBinds, undefined]);
    expect(outcome.error).toBeNull();
    expect(ports).toEqual([RANGE_START, RANGE_START + 1, RANGE_START + 2]);
  });

  it("fails an aggregate at once when any attempt failed at the destination, on Windows too", async () => {
    const { outcome, ports } = await dialOn("win32", ["AGG:EACCES@bind|ECONNREFUSED@connect", undefined]);
    expect(outcome.error?.code).toBe("EACCES");
    expect(ports).toHaveLength(1);
  });

  it("fails an aggregate of bind refusals at once on a platform that excludes no ranges", async () => {
    const { ports } = await dialOn("linux", ["AGG:EACCES@bind|EACCES@bind", undefined]);
    expect(ports).toHaveLength(1);
  });

  it("says every source port was refused only when every one was, and counts the others as held when some were", async () => {
    const all = await dialOn("win32", Array.from({ length: RANGE_WIDTH }, () => BIND_REFUSED));
    expect(all.outcome.error?.message).toContain(`every source port of the door's reserved range (${String(RANGE_START)} to ${String(RANGE_END)})`);
    const mixed = await dialOn("win32", ["EADDRINUSE@bind", "EADDRINUSE@bind", BIND_REFUSED]);
    expect(mixed.outcome.error?.message).not.toContain("every source port");
    expect(mixed.outcome.error?.message).toContain(`1 of its ${String(RANGE_WIDTH)} source ports`);
    expect(mixed.outcome.error?.message).toContain("netsh int ipv4 show excludedportrange protocol=tcp");
  });

  it("surfaces the held-port error unchanged when no port was refused by the system", async () => {
    const held = await dialOn("win32", Array.from({ length: RANGE_WIDTH }, () => "EADDRINUSE@bind"));
    expect(held.outcome.error?.code).toBe("EADDRINUSE");
    expect(held.outcome.error?.message).not.toContain("netsh");
  });
});

describe("the rotation's memory of ports the system refuses", () => {
  const FIRST = 100;
  const WIDTH = 20;
  const EXCLUDED_BLOCK = 12;

  /** Dials a name repeatedly from one rotation over a range whose first `EXCLUDED_BLOCK` ports the system refuses at the bind, counting every bind attempt. */
  async function dialsOverExcludedBlock(dials: number): Promise<readonly number[]> {
    const rotation = new SourcePortRange(FIRST, FIRST + WIDTH - 1);
    const perDial: number[] = [];
    for (let dial = 0; dial < dials; dial += 1) {
      let attempts = 0;
      const outcome = await doorDial(
        {
          connect: (options) => {
            attempts += 1;
            const socket = new SilentSocket();
            const excluded = (options.localPort ?? 0) < FIRST + EXCLUDED_BLOCK;
            queueMicrotask(() => {
              if (!excluded) {
                socket.emit("connect");
                return;
              }
              const refusal: NodeJS.ErrnoException = new Error("bind EACCES");
              refusal.code = "EACCES";
              refusal.syscall = "bind";
              socket.emit("error", refusal);
            });
            return socket;
          },
          lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
          isIP: net.isIP,
          sourcePortFailure: unusableOn("win32"),
        },
        { host: "provider.example", port: 443 },
        rotation,
      );
      expect(outcome.error).toBeNull();
      perDial.push(attempts);
    }
    return perDial;
  }

  it("walks the refused block once: every later dial binds a usable port at the first attempt, including those after the cursor has wrapped round to the block", async () => {
    // Twice the range's width of dials, so the cursor passes the refused block again: without the memory each pass would walk it afresh.
    const perDial = await dialsOverExcludedBlock(2 * WIDTH);
    expect(perDial[0]).toBe(EXCLUDED_BLOCK + 1);
    expect(perDial.slice(1)).toEqual(Array.from({ length: perDial.length - 1 }, () => 1));
  });

  it("skips a remembered port when the cursor comes round to it again", () => {
    const rotation = new SourcePortRange(FIRST, FIRST + 2);
    rotation.exclude(FIRST + 1);
    expect([rotation.take(), rotation.take(), rotation.take(), rotation.take()]).toEqual([FIRST, FIRST + 2, FIRST, FIRST + 2]);
  });

  it("forgets the refusals when every port of the range is remembered, so a host whose exclusions changed is tried again, one pass", () => {
    const rotation = new SourcePortRange(FIRST, FIRST + 2);
    for (const port of [FIRST, FIRST + 1, FIRST + 2]) {
      rotation.exclude(port);
    }
    expect(rotation.take()).toBe(FIRST);
    expect([rotation.take(), rotation.take()]).toEqual([FIRST + 1, FIRST + 2]);
  });

  it("remembers only what is excluded, never a port a sibling merely holds", async () => {
    const rotation = new SourcePortRange(FIRST, FIRST + 1);
    const attempts: (number | undefined)[] = [];
    const dial = async (): Promise<void> => {
      await doorDial(
        {
          connect: (options) => {
            attempts.push(options.localPort);
            const socket = new SilentSocket();
            queueMicrotask(() => {
              if (attempts.length === 1) {
                const held: NodeJS.ErrnoException = new Error("held");
                held.code = "EADDRINUSE";
                held.syscall = "bind";
                socket.emit("error", held);
                return;
              }
              socket.emit("connect");
            });
            return socket;
          },
          lookup: createDoorLookup({ isIP: net.isIP, resolve4: () => undefined }),
          isIP: net.isIP,
          sourcePortFailure: unusableOn("win32"),
        },
        { host: "provider.example", port: 443 },
        rotation,
      );
    };
    await dial();
    await dial();
    // The held port came round again as the cursor wrapped, instead of being skipped for ever.
    expect(attempts).toEqual([FIRST, FIRST + 1, FIRST]);
  });
});

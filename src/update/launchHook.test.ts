import { describe, expect, it } from "vitest";

import { resolveUpdateMode, runLaunchUpdateCheck, updateCheckDue, updateNotifyLine, UPDATE_CHECK_COOLDOWN_MS, type UpdateLaunchPort } from "./launchHook";
import type { GlobalConfig, UpdateMode } from "../config/schema";
import { FAKE_NOW_MS } from "../test-helpers";

/** One hour, for writing readable relative stamps. */
const HOUR_MS = 3_600_000;

const CURRENT = "8.22.0";
const NEWER_TAG_URL = "https://github.com/ExaDev/agent-shim/releases/tag/v9.0.0";
const SAME_TAG_URL = "https://github.com/ExaDev/agent-shim/releases/tag/v8.22.0";
const OLDER_TAG_URL = "https://github.com/ExaDev/agent-shim/releases/tag/v8.21.0";
const CHECK_PATH = "/home/testuser/.agent-shim/update.check";

/** A promise whose settlement a test controls, so a test can prove the hook fires the check without awaiting it. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A scripted `UpdateLaunchPort`: the release check stays pending until the test settles it, the stamp file lives in a map the test can seed and inspect, and every operation is recorded in `events` in the order it happened.
 */
function scriptedPort(options: { readonly stamp?: string; readonly fail?: "read" | "write" } = {}): UpdateLaunchPort & {
  readonly events: string[];
  readonly writes: Readonly<Record<string, string>>;
  readonly errLines: string[];
  readonly spawns: readonly string[][];
  readonly settle: (url: string) => void;
  readonly failWith: (error: Error) => void;
  readonly setStamp: (contents: string) => void;
} {
  const events: string[] = [];
  const writes: Record<string, string> = {};
  const errLines: string[] = [];
  const spawns: string[][] = [];
  const pending = deferred<string>();
  return {
    events,
    writes,
    errLines,
    spawns,
    settle: (url) => {
      events.push("resolve");
      pending.resolve(url);
    },
    failWith: (error) => {
      events.push("reject");
      pending.reject(error);
    },
    setStamp: (contents) => {
      writes[CHECK_PATH] = contents;
    },
    effectiveUrl: async (url) => {
      events.push(`http ${url}`);
      return await pending.promise;
    },
    readStamp: (filePath) => {
      events.push(`read ${filePath}`);
      if (options.fail === "read") {
        throw new Error("stamp unreadable");
      }
      return writes[filePath] ?? options.stamp;
    },
    writeStamp: (filePath, contents) => {
      events.push(`write ${filePath}`);
      if (options.fail === "write") {
        throw new Error("stamp unwritable");
      }
      writes[filePath] = contents;
    },
    now: () => FAKE_NOW_MS,
    spawnDetached: (args) => {
      events.push(`spawn ${args.join(" ")}`);
      spawns.push([...args]);
    },
    writeErr: (line) => {
      events.push("stderr");
      errLines.push(line);
    },
  };
}

/** Lets every pending microtask (and one macrotask turn) run, so a check settled by the test has been acted on. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("updateCheckDue", () => {
  it("is due with no stamp at all", () => {
    expect(updateCheckDue(undefined, FAKE_NOW_MS)).toBe(true);
  });

  it("is due for a stamp older than the cooldown and not due for a fresher one", () => {
    expect(updateCheckDue(new Date(FAKE_NOW_MS - UPDATE_CHECK_COOLDOWN_MS - 1).toISOString(), FAKE_NOW_MS)).toBe(true);
    expect(updateCheckDue(new Date(FAKE_NOW_MS - UPDATE_CHECK_COOLDOWN_MS).toISOString(), FAKE_NOW_MS)).toBe(true);
    expect(updateCheckDue(new Date(FAKE_NOW_MS - UPDATE_CHECK_COOLDOWN_MS + HOUR_MS).toISOString(), FAKE_NOW_MS)).toBe(false);
  });

  it("is due for a stamp it cannot parse or that sits in the future, rather than suppressing checks forever", () => {
    expect(updateCheckDue("not a timestamp", FAKE_NOW_MS)).toBe(true);
    expect(updateCheckDue("", FAKE_NOW_MS)).toBe(true);
    expect(updateCheckDue(new Date(FAKE_NOW_MS + HOUR_MS).toISOString(), FAKE_NOW_MS)).toBe(true);
  });
});

describe("resolveUpdateMode", () => {
  it("reads each mode and treats an absent setting or config as off", () => {
    const configWith = (mode?: UpdateMode): GlobalConfig => ({ ...(mode === undefined ? {} : { update: { mode } }) });
    expect(resolveUpdateMode(undefined)).toBe("off");
    expect(resolveUpdateMode(configWith())).toBe("off");
    expect(resolveUpdateMode(configWith("off"))).toBe("off");
    expect(resolveUpdateMode(configWith("notify"))).toBe("notify");
    expect(resolveUpdateMode(configWith("auto"))).toBe("auto");
  });
});

describe("runLaunchUpdateCheck", () => {
  const hook = (port: UpdateLaunchPort | undefined, mode: UpdateMode = "notify") =>
    runLaunchUpdateCheck({ mode, checkPath: CHECK_PATH, currentVersion: CURRENT, port });

  it("touches nothing at all when the mode is off or no port is wired", () => {
    const port = scriptedPort();
    hook(port, "off").markChildStarted();
    hook(undefined).markChildStarted();
    expect(port.events).toEqual([]);
  });

  it("skips the check, the stamp write and the network when the stamp is fresh", () => {
    const port = scriptedPort({ stamp: new Date(FAKE_NOW_MS - HOUR_MS).toISOString() });
    hook(port);
    expect(port.events).toEqual([`read ${CHECK_PATH}`]);
  });

  it("writes the fresh stamp before any network work, so a concurrent launch reading it skips", () => {
    const port = scriptedPort();
    hook(port);
    expect(port.events[0]).toBe(`read ${CHECK_PATH}`);
    expect(port.events[1]).toBe(`write ${CHECK_PATH}`);
    expect(port.events[2]).toBe("http https://github.com/ExaDev/agent-shim/releases/latest");
    // The second "launch" shares the stamp file the first just wrote and so never reaches the network.
    const second = scriptedPort();
    second.setStamp(port.writes[CHECK_PATH] ?? "");
    hook(second);
    expect(second.events).toEqual([`read ${CHECK_PATH}`]);
    expect(port.events.filter((event) => event.startsWith("http"))).toHaveLength(1);
  });

  it("returns before the check resolves, so the launch never waits on it", () => {
    const port = scriptedPort();
    hook(port);
    expect(port.spawns).toEqual([]);
    port.settle(NEWER_TAG_URL);
    expect(port.spawns).toEqual([]);
  });

  it("prints exactly one stderr line naming the release and the command when a newer release is found in time", async () => {
    const port = scriptedPort();
    hook(port);
    port.settle(NEWER_TAG_URL);
    await flush();
    expect(port.errLines).toEqual([updateNotifyLine(CURRENT, "9.0.0")]);
    expect(port.errLines[0]).toContain("run `agent-shim update`");
    expect(port.spawns).toEqual([]);
  });

  it("prints nothing when the running version is current or ahead", async () => {
    for (const url of [SAME_TAG_URL, OLDER_TAG_URL]) {
      const port = scriptedPort();
      hook(port);
      port.settle(url);
      await flush();
      expect(port.errLines).toEqual([]);
      expect(port.spawns).toEqual([]);
    }
  });

  it("prints nothing when the answer arrives after the child started", async () => {
    const port = scriptedPort();
    const handle = hook(port);
    handle.markChildStarted();
    port.settle(NEWER_TAG_URL);
    await flush();
    expect(port.errLines).toEqual([]);
  });

  it("spawns the detached update with the update argv when auto finds a newer release, and never awaits it", async () => {
    const port = scriptedPort();
    hook(port, "auto");
    expect(port.spawns).toEqual([]);
    port.settle(NEWER_TAG_URL);
    await flush();
    expect(port.spawns).toEqual([["update", "--restart-door"]]);
    expect(port.errLines).toEqual([updateNotifyLine(CURRENT, "9.0.0")]);
  });

  it("still applies the update in auto mode when the answer is late, since the new binary is for future launches", async () => {
    const port = scriptedPort();
    const handle = hook(port, "auto");
    handle.markChildStarted();
    port.settle(NEWER_TAG_URL);
    await flush();
    expect(port.spawns).toEqual([["update", "--restart-door"]]);
    expect(port.errLines).toEqual([]);
  });

  it("spawns nothing in auto mode when the running version is current", async () => {
    const port = scriptedPort();
    hook(port, "auto");
    port.settle(SAME_TAG_URL);
    await flush();
    expect(port.spawns).toEqual([]);
  });

  it("swallows a stamp that cannot be read or written, a failed check and a failing sink, without surfacing anything", async () => {
    const unreadable = scriptedPort({ fail: "read" });
    expect(() => {
      hook(unreadable);
    }).not.toThrow();
    expect(unreadable.events).toEqual([`read ${CHECK_PATH}`]);

    const unwritable = scriptedPort({ fail: "write" });
    expect(() => {
      hook(unwritable);
    }).not.toThrow();
    expect(unwritable.events.filter((event) => event.startsWith("http"))).toEqual([]);

    const unreachable = scriptedPort();
    expect(() => {
      hook(unreachable);
    }).not.toThrow();
    unreachable.failWith(new Error("network down"));
    await flush();
    expect(unreachable.errLines).toEqual([]);

    const brokenSink = scriptedPort();
    const broken: UpdateLaunchPort = { ...brokenSink, writeErr: () => {
      throw new Error("stderr closed");
    } };
    expect(() => {
      hook(broken);
    }).not.toThrow();
    brokenSink.settle(NEWER_TAG_URL);
    await flush();
    expect(brokenSink.errLines).toEqual([]);
  });
});

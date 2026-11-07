import path from "node:path";

import { describe, expect, it } from "vitest";

import { createRcSessionRegistryReader, rcStatusWithRegistry, withRegisteredSessionFacts, type RcRegisteredSession, type RcSessionRegistryFs } from "./rcSessionRegistry";
import type { RcSessionStatus } from "./rcSessions";

const CSE_ID = "cse_00000000-0000-4000-8000-000000000001";
const OTHER_CSE_ID = "cse_00000000-0000-4000-8000-000000000002";
const BRIDGE_ID = "session_00000000-0000-4000-8000-000000000001";
const OTHER_BRIDGE_ID = "session_00000000-0000-4000-8000-000000000002";
const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_PID = 4001;
const OTHER_LIVE_PID = 4002;
const DEAD_PID = 4999;

/** An in-memory filesystem of directories, files and symlink-like realpath redirects. */
function fakeRegistryFs(files: Readonly<Record<string, string>>, redirects: Readonly<Record<string, string>> = {}): RcSessionRegistryFs {
  const realpathOf = (candidate: string): string => {
    for (const [from, to] of Object.entries(redirects)) {
      if (candidate === from || candidate.startsWith(`${from}/`)) {
        return `${to}${candidate.slice(from.length)}`;
      }
    }
    return candidate;
  };
  return {
    readdir: (dir) => {
      const real = realpathOf(dir);
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (path.dirname(file) === real) {
          names.add(path.basename(file));
        }
      }
      return [...names];
    },
    readFileUtf8: (file) => files[realpathOf(file)],
    realpath: (candidate) => {
      const real = realpathOf(candidate);
      return Object.keys(files).some((file) => file.startsWith(`${real}/`)) ? real : undefined;
    },
  };
}

/** One registry file's body in the shape Claude Code writes, with the fields the reader does not use alongside the ones it does. */
function entry(fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ sessionId: LOCAL_ID, startedAt: 1, kind: "interactive", status: "idle", ...fields });
}

const alive = (pid: number): boolean => pid !== DEAD_PID;

describe("the Claude Code session registry reader", () => {
  it("joins a registry entry to the door's cse_ id through its bridgeSessionId", () => {
    const fs = fakeRegistryFs({ "/work/a/sessions/4001.json": entry({ pid: LIVE_PID, cwd: "/repo", name: "fix the thing", bridgeSessionId: BRIDGE_ID }) });
    const reader = createRcSessionRegistryReader({ fs, identities: () => [{ name: "work", configDir: "/work/a" }], isRunning: alive });
    expect(reader()).toEqual(new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, cwd: "/repo", name: "fix the thing", identity: "work" }]]));
  });

  it("omits the fields an entry does not carry and skips entries with no bridge session, files that are not entries and half-written files", () => {
    const fs = fakeRegistryFs({
      "/work/a/sessions/4001.json": entry({ pid: LIVE_PID, bridgeSessionId: BRIDGE_ID, name: "" }),
      "/work/a/sessions/4002.json": entry({ pid: OTHER_LIVE_PID, bridgeSessionId: null, name: "local only" }),
      "/work/a/sessions/4003.json.tmp-4003": entry({ pid: 4003, bridgeSessionId: OTHER_BRIDGE_ID }),
      "/work/a/sessions/0.abcdef.key": "not json",
      "/work/a/sessions/4004.json": "{not json",
      "/work/a/sessions/4005.json": JSON.stringify({ pid: "four", bridgeSessionId: OTHER_BRIDGE_ID }),
    });
    const reader = createRcSessionRegistryReader({ fs, identities: () => [{ name: "work", configDir: "/work/a" }], isRunning: alive });
    expect(reader()).toEqual(new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, identity: "work" }]]));
  });

  it("ignores an entry whose process has exited, and prefers the live one when a resumed session left a stale file behind", () => {
    const fs = fakeRegistryFs({
      "/work/a/sessions/4999.json": entry({ pid: DEAD_PID, cwd: "/old", name: "stale", bridgeSessionId: BRIDGE_ID, updatedAt: 99 }),
      "/work/a/sessions/4001.json": entry({ pid: LIVE_PID, cwd: "/new", name: "resumed", bridgeSessionId: BRIDGE_ID, updatedAt: 1 }),
    });
    const reader = createRcSessionRegistryReader({ fs, identities: () => [{ name: "work", configDir: "/work/a" }], isRunning: alive });
    expect(reader().get(CSE_ID)).toEqual({ pid: LIVE_PID, localSessionId: LOCAL_ID, cwd: "/new", name: "resumed", identity: "work" });
  });

  it("reads a store shared by several identities once and attributes no identity to its entries", () => {
    const fs = fakeRegistryFs(
      { "/shared/sessions/4001.json": entry({ pid: LIVE_PID, name: "shared", bridgeSessionId: BRIDGE_ID }) },
      { "/cfg/one/sessions": "/shared/sessions", "/cfg/two/sessions": "/shared/sessions" },
    );
    const reader = createRcSessionRegistryReader({
      fs,
      identities: () => [
        { name: "one", configDir: "/cfg/one" },
        { name: "two", configDir: "/cfg/two" },
      ],
      isRunning: alive,
    });
    expect(reader()).toEqual(new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, name: "shared" }]]));
  });

  it("finds a session in whichever identity's own registry holds it", () => {
    const fs = fakeRegistryFs({
      "/cfg/one/sessions/4001.json": entry({ pid: LIVE_PID, name: "first", bridgeSessionId: BRIDGE_ID }),
      "/cfg/two/sessions/4002.json": entry({ pid: OTHER_LIVE_PID, name: "second", bridgeSessionId: OTHER_BRIDGE_ID }),
    });
    const reader = createRcSessionRegistryReader({
      fs,
      identities: () => [
        { name: "one", configDir: "/cfg/one" },
        { name: "two", configDir: "/cfg/two" },
      ],
      isRunning: alive,
    });
    expect(reader()).toEqual(
      new Map([
        [CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, name: "first", identity: "one" }],
        [OTHER_CSE_ID, { pid: OTHER_LIVE_PID, localSessionId: LOCAL_ID, name: "second", identity: "two" }],
      ]),
    );
  });

  it("reads the identities afresh on every call, so an identity added later is searched", () => {
    const fs = fakeRegistryFs({ "/cfg/late/sessions/4001.json": entry({ pid: LIVE_PID, bridgeSessionId: BRIDGE_ID }) });
    let identities: readonly { name: string; configDir: string }[] = [];
    const reader = createRcSessionRegistryReader({ fs, identities: () => identities, isRunning: alive });
    expect(reader().size).toBe(0);
    identities = [{ name: "late", configDir: "/cfg/late" }];
    expect(reader().get(CSE_ID)).toEqual({ pid: LIVE_PID, localSessionId: LOCAL_ID, identity: "late" });
  });
});

function status(id: string, fields: Partial<RcSessionStatus> = {}): RcSessionStatus {
  return { id, createdAt: 1, lastSeenAt: 2, workerState: undefined, workerIdleSeconds: undefined, pending: [], ...fields };
}

describe("withRegisteredSessionFacts", () => {
  it("adds the registry's name, pid and working directory, and keeps the identity the door observed ahead of the registry's", () => {
    const registry = new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, cwd: "/repo", name: "fix the thing", identity: "from-registry" }]]);
    const [enriched] = withRegisteredSessionFacts([status(CSE_ID, { identity: "from-door", model: "claude-opus-4" })], registry);
    expect(enriched).toEqual(status(CSE_ID, { identity: "from-door", model: "claude-opus-4", pid: LIVE_PID, cwd: "/repo", name: "fix the thing" }));
  });

  it("keeps the working directory the session's own init event stated ahead of the registry's", () => {
    const registry = new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, cwd: "/registry" }]]);
    expect(withRegisteredSessionFacts([status(CSE_ID, { cwd: "/init" })], registry)[0]?.cwd).toBe("/init");
    expect(withRegisteredSessionFacts([status(CSE_ID)], registry)[0]?.cwd).toBe("/registry");
  });

  it("takes the registry's identity when the door observed none", () => {
    const registry = new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, identity: "from-registry" }]]);
    expect(withRegisteredSessionFacts([status(CSE_ID)], registry)[0]?.identity).toBe("from-registry");
  });

  it("leaves a session found in no registry with only what the door knows, no key present for the rest", () => {
    const [bare] = withRegisteredSessionFacts([status(CSE_ID, { identity: "from-door" })], new Map());
    expect(bare).toEqual(status(CSE_ID, { identity: "from-door" }));
    expect(Object.keys(bare ?? {})).not.toEqual(expect.arrayContaining(["name", "pid", "cwd", "model"]));
  });

  it("serialises without a blank or null field for anything absent", () => {
    const [enriched] = withRegisteredSessionFacts([status(CSE_ID)], new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID }]]));
    const json: unknown = JSON.parse(JSON.stringify(enriched));
    expect(json).toEqual({ id: CSE_ID, createdAt: 1, lastSeenAt: 2, pending: [], pid: LIVE_PID });
  });
});

describe("rcStatusWithRegistry", () => {
  it("passes the tracker's filter through and reads the registry only when there is a status to describe", () => {
    let reads = 0;
    const read = (): ReadonlyMap<string, RcRegisteredSession> => {
      reads += 1;
      return new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID }]]);
    };
    const statuses = [status(CSE_ID)];
    const statusOf = rcStatusWithRegistry((sessionId) => statuses.filter((candidate) => sessionId === undefined || candidate.id === sessionId), read);
    expect(statusOf(OTHER_CSE_ID)).toEqual([]);
    expect(reads).toBe(0);
    expect(statusOf(CSE_ID)[0]?.pid).toBe(LIVE_PID);
    expect(reads).toBe(1);
  });
});

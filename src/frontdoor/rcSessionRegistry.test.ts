import * as nodeFs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { realRcSessionRegistryFs } from "./rcSessionRegistryFs";

import { RC_REGISTRY_ENTRY_MAX_BYTES, createRcSessionRegistryReader, rcRegistryIdentitiesOf, rcStatusWithRegistry, withIdentityNames, withRegisteredSessionFacts, type RcRegisteredSession, type RcSessionRegistryFs } from "./rcSessionRegistry";
import type { RcTrackedSessionStatus } from "./rcSessions";

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
    statEntry: (candidate) => {
      const body = files[realpathOf(candidate)];
      return body === undefined ? undefined : { regular: true, sizeBytes: body.length };
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

  it("joins an entry whose bridgeSessionId still has the service's own cse_ form, which the CLI leaves unconverted when its conversion gate is off", () => {
    const fs = fakeRegistryFs({ "/work/a/sessions/4001.json": entry({ pid: LIVE_PID, name: "unconverted", bridgeSessionId: CSE_ID }) });
    const reader = createRcSessionRegistryReader({ fs, identities: () => [{ name: "work", configDir: "/work/a" }], isRunning: alive });
    expect(reader()).toEqual(new Map([[CSE_ID, { pid: LIVE_PID, localSessionId: LOCAL_ID, name: "unconverted", identity: "work" }]]));
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

function status(id: string, fields: Partial<RcTrackedSessionStatus> = {}): RcTrackedSessionStatus {
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
    const statusOf = rcStatusWithRegistry((sessionId) => statuses.filter((candidate) => sessionId === undefined || candidate.id === sessionId), read, () => undefined);
    expect(statusOf(OTHER_CSE_ID)).toEqual([]);
    expect(reads).toBe(0);
    expect(statusOf(CSE_ID)[0]?.pid).toBe(LIVE_PID);
    expect(reads).toBe(1);
  });
});

describe("withIdentityNames", () => {
  it("turns the identity id a request carried into the identity's name, and drops an id that names no identity", () => {
    const names = new Map([["id-work", "work"]]);
    const result = withIdentityNames([status(CSE_ID, { identity: "id-work" }), status(OTHER_CSE_ID, { identity: "id-gone" }), status("cse_3")], (id) => names.get(id));
    expect(result[0]?.identity).toBe("work");
    expect(result[1]).not.toHaveProperty("identity");
    expect(result[2]).not.toHaveProperty("identity");
  });
});

describe("the registry reader over a real filesystem it does not own", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** A real configuration directory with a `sessions` directory, one good entry for a live process, and whatever hostile files the case adds. */
  function world(addHostile: (sessionsDir: string) => void): ReturnType<typeof createRcSessionRegistryReader> {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "rc-registry-"));
    roots.push(root);
    const sessionsDir = path.join(root, "sessions");
    nodeFs.mkdirSync(sessionsDir);
    nodeFs.writeFileSync(path.join(sessionsDir, "1.json"), entry({ pid: LIVE_PID, bridgeSessionId: BRIDGE_ID, name: "good" }));
    addHostile(sessionsDir);
    return createRcSessionRegistryReader({ fs: realRcSessionRegistryFs, identities: () => [{ name: "work", configDir: root }], isRunning: alive });
  }

  it("skips a directory named like an entry instead of failing the read for every session", () => {
    const reader = world((dir) => { nodeFs.mkdirSync(path.join(dir, "2.json")); });
    expect(reader().get(CSE_ID)?.name).toBe("good");
  });

  it("skips a file it cannot open instead of failing the read for every session", () => {
    const reader = world((dir) => {
      const locked = path.join(dir, "2.json");
      nodeFs.writeFileSync(locked, entry({ pid: OTHER_LIVE_PID, bridgeSessionId: OTHER_BRIDGE_ID }));
      nodeFs.chmodSync(locked, 0);
    });
    const read = reader();
    expect(read.get(CSE_ID)?.name).toBe("good");
    // The assertion that makes this case discriminating: where the process can open a mode-0 file (running as root), the file is simply read.
    expect(read.has(OTHER_CSE_ID)).toBe(process.getuid?.() === 0);
  });

  it("never opens a FIFO named like an entry, which would block the read forever", () => {
    const reader = world((dir) => { execFileSync("mkfifo", [path.join(dir, "2.json")]); });
    expect(reader().get(CSE_ID)?.name).toBe("good");
  });

  it("never follows a link named like an entry", () => {
    const reader = world((dir) => { nodeFs.symlinkSync("/dev/zero", path.join(dir, "2.json")); });
    expect(reader().get(CSE_ID)?.name).toBe("good");
  });

  it("skips a file larger than any entry can be", () => {
    const reader = world((dir) => {
      nodeFs.writeFileSync(path.join(dir, "2.json"), entry({ pid: OTHER_LIVE_PID, bridgeSessionId: OTHER_BRIDGE_ID, padding: "x".repeat(RC_REGISTRY_ENTRY_MAX_BYTES) }));
    });
    expect(reader().has(OTHER_CSE_ID)).toBe(false);
    expect(reader().get(CSE_ID)?.name).toBe("good");
  });
});

describe("the identities the registry reader searches", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  function store(identities: Readonly<Record<string, string>>): ReturnType<typeof buildLayoutPaths> {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "rc-identities-"));
    roots.push(root);
    const paths = buildLayoutPaths(root);
    for (const [id, name] of Object.entries(identities)) {
      nodeFs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
      nodeFs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), JSON.stringify({ name, allowAmbientCredential: false }));
    }
    return paths;
  }

  it("lists an identity under its name with the directory of its id, which differs from the name after a rename", () => {
    const paths = store({ work: "client" });
    expect(rcRegistryIdentitiesOf(paths)).toEqual([{ name: "client", configDir: path.join(paths.identitiesDir, "work") }]);
  });

  it("lists two identities that claim one name instead of throwing, so one misnamed identity never fails every session's status", () => {
    const paths = store({ one: "twin", two: "twin" });
    expect(rcRegistryIdentitiesOf(paths).map((listed) => listed.configDir).sort()).toEqual([path.join(paths.identitiesDir, "one"), path.join(paths.identitiesDir, "two")]);
  });
});

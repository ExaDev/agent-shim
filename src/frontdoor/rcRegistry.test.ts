import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLAUDE_SESSION_REGISTRY_DIR, rcRegistryDirsOf, rcSessionIdOfBridgeId, readRcRegisteredSessions } from "./rcRegistry";

/** Made-up ids of the protocol's shapes: one bridge suffix in its compatibility and infrastructure forms, and local session ids. */
const BRIDGE_SUFFIX = "01AAAAAAAAAAAAAAAAAAAAAA";
const COMPAT_ID = `session_${BRIDGE_SUFFIX}`;
const CSE_ID = `cse_${BRIDGE_SUFFIX}`;
const OTHER_CSE_ID = "cse_01BBBBBBBBBBBBBBBBBBBBBB";
const LOCAL_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_LOCAL_ID = "00000000-0000-4000-8000-000000000002";
const LIVE_PID = 101;
const OTHER_LIVE_PID = 102;
const DEAD_PID = 103;

const SHARED_DIR = "/home/claude/sessions";
const IDENTITY_DIR = "/home/agent-shim/identities/work/sessions";

/** A fake filesystem over a fixed map of directory to file name to contents. */
function fakeFs(tree: Readonly<Record<string, Readonly<Record<string, string>>>>) {
  return {
    readdir: (dir: string) => Object.keys(tree[dir] ?? {}),
    readFileUtf8: (file: string) => tree[path.dirname(file)]?.[path.basename(file)],
  };
}

const record = (fields: Readonly<Record<string, unknown>>): string => JSON.stringify({ kind: "interactive", status: "idle", cwd: "/work", ...fields });

describe("the Claude Code session registry read", () => {
  it("converts a bridge id from the compatibility form to the cse_ form, and keeps a cse_ id as it is", () => {
    expect(rcSessionIdOfBridgeId(COMPAT_ID)).toBe(CSE_ID);
    expect(rcSessionIdOfBridgeId(CSE_ID)).toBe(CSE_ID);
  });

  it("names the sessions directory of every configuration directory", () => {
    expect(rcRegistryDirsOf(["/home/claude", "/home/agent-shim/identities/work"])).toEqual([path.join("/home/claude", CLAUDE_SESSION_REGISTRY_DIR), path.join("/home/agent-shim/identities/work", CLAUDE_SESSION_REGISTRY_DIR)]);
  });

  it("lists each live bridged session once, by its cse_ id, across every registry directory", () => {
    const fs = fakeFs({
      [SHARED_DIR]: {
        [`${String(LIVE_PID)}.json`]: record({ sessionId: LOCAL_ID, pid: LIVE_PID, bridgeSessionId: COMPAT_ID }),
        // A record with no bridge registered no Remote Control session.
        "104.json": record({ sessionId: "00000000-0000-4000-8000-000000000004", pid: 104 }),
        // A record left behind by a process that exited.
        [`${String(DEAD_PID)}.json`]: record({ sessionId: "00000000-0000-4000-8000-000000000003", pid: DEAD_PID, bridgeSessionId: "session_01CCCCCCCCCCCCCCCCCCCCCC" }),
        // A file mid-write and a file of another kind name no session.
        "105.json": "{",
        "notes.txt": "not a record",
      },
      [IDENTITY_DIR]: {
        // The same session seen through an identity's link to the shared directory.
        [`${String(LIVE_PID)}.json`]: record({ sessionId: LOCAL_ID, pid: LIVE_PID, bridgeSessionId: COMPAT_ID }),
        [`${String(OTHER_LIVE_PID)}.json`]: record({ sessionId: OTHER_LOCAL_ID, pid: OTHER_LIVE_PID, bridgeSessionId: OTHER_CSE_ID }),
      },
    });
    const sessions = readRcRegisteredSessions({ fs, registryDirs: () => [SHARED_DIR, IDENTITY_DIR, "/missing/sessions"], isProcessAlive: (pid) => pid !== DEAD_PID });
    expect(sessions).toEqual([
      { id: CSE_ID, localSessionId: LOCAL_ID, pid: LIVE_PID },
      { id: OTHER_CSE_ID, localSessionId: OTHER_LOCAL_ID, pid: OTHER_LIVE_PID },
    ]);
  });
});

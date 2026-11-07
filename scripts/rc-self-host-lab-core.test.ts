import { describe, expect, it } from "vitest";

import { labBaseEnv, labLaunchVariables, labPaneCommand, labPaneState, labSessionId, parseLabDoorState, readLabCapture, shellQuote } from "./rc-self-host-lab-core";

/** Ports and a pid with no meaning beyond being told apart in the assertions. */
const TRANSPARENT_PORT = 4321;
const TLS_PORT = 443;
const DOOR_PORT = 5000;
const SUPERVISOR_PID = 7;

const line = (record: Record<string, unknown>): string => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", ...record });

describe("the lab's environment", () => {
  it("keeps only the inherited minimum and the lab's own home, never the operator's configuration directory, proxy or credentials", () => {
    const env = labBaseEnv({ HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/real", HTTPS_PROXY: "http://x", ANTHROPIC_API_KEY: "k", AGENT_SHIM_HOME: "/real-home" }, { home: "/lab/home" });
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", TERM: "xterm-256color", AGENT_SHIM_HOME: "/lab/home" });
  });

  it("starts the door in self-hosted mode with its capture on, its transparent surface on the given port, and nothing of ~/.claude shared", () => {
    expect(labLaunchVariables(TRANSPARENT_PORT)).toMatchObject({ AGENT_SHIM_FRONTDOOR_RC_SELF_HOST: "1", AGENT_SHIM_TRANSPARENT_SURFACE: "4321", AGENT_SHIM_FRONTDOOR_CAPTURE: "1", AGENT_SHIM_CATEGORY_OVERRIDE: "all=false" });
  });

  it("builds the pane command with CLAUDE_CONFIG_DIR unset first and every word quoted", () => {
    expect(labPaneCommand({ A: "x y" }, ["node", "it's"])).toBe(`env -u CLAUDE_CONFIG_DIR A='x y' 'node' 'it'\\''s'`);
    expect(shellQuote("plain")).toBe("'plain'");
  });
});

describe("the lab's leak check", () => {
  it("passes a capture holding only the intercepted tunnels and upgrade arrivals", () => {
    const capture = [line({ kind: "connect", host: "api.anthropic.com", port: TLS_PORT, intercepted: true }), line({ kind: "upgrade", method: "GET", url: "/x", headers: {} }), ""].join("\n");
    expect(readLabCapture(capture, [])).toEqual({ records: 2, leaks: [] });
  });

  it("names every forwarded exchange, tapped stream and blind tunnel, except a tunnel host the caller allows", () => {
    const capture = [
      line({ kind: "request", id: 1, method: "GET", url: "/api/claude_code_grove", headers: {} }),
      line({ kind: "stream", id: 2, host: "platform.claude.com" }),
      line({ kind: "connect", host: "downloads.example.test", port: TLS_PORT, intercepted: false }),
      line({ kind: "connect", host: "allowed.example.test", port: TLS_PORT, intercepted: false }),
    ].join("\n");
    expect(readLabCapture(capture, ["allowed.example.test"]).leaks).toEqual([
      { kind: "forwarded", detail: "GET /api/claude_code_grove" },
      { kind: "forwarded", detail: "stream to platform.claude.com" },
      { kind: "tunnel", detail: "downloads.example.test:443" },
    ]);
  });

  it("refuses a capture it cannot read instead of calling it clean", () => {
    expect(() => readLabCapture("not json\n", [])).toThrow("capture line 1 is not JSON");
    expect(() => readLabCapture("[1]\n", [])).toThrow("capture line 1 is not a JSON object");
  });
});

describe("the lab's readings of the pane, the log and the state", () => {
  it("tells an active Remote Control, the trust prompt, a first-run screen to confirm and anything else apart", () => {
    expect(labPaneState("❯ No, exit\n  Yes, I trust this folder\n Enter to confirm · Esc to cancel")).toBe("trust");
    expect(labPaneState("❯ No, disable external imports\n Enter to confirm · Esc to cancel")).toBe("confirm");
    expect(labPaneState(" Press Enter to continue…")).toBe("confirm");
    expect(labPaneState("  Syntax theme: Monokai Extended")).toBe("confirm");
    expect(labPaneState("  /remote-control is active · Continue here")).toBe("active");
    expect(labPaneState("Claude Code v2")).toBe("starting");
  });

  it("names the most recent session the door created on its own surface", () => {
    const log = ["x rc selfhost cse_aaa: session created on the door's own surface, attached", "x rc selfhost cse_bbb-1: session created on the door's own surface, attached"].join("\n");
    expect(labSessionId(log)).toBe("cse_bbb-1");
    expect(labSessionId("nothing yet")).toBeUndefined();
  });

  it("reads the door's port and supervisor pid, and nothing from an incomplete state file", () => {
    expect(parseLabDoorState(JSON.stringify({ supervisorPid: SUPERVISOR_PID, port: DOOR_PORT }))).toEqual({ port: DOOR_PORT, supervisorPid: SUPERVISOR_PID });
    expect(parseLabDoorState("{")).toBeUndefined();
    expect(parseLabDoorState(JSON.stringify({ port: DOOR_PORT }))).toBeUndefined();
  });
});

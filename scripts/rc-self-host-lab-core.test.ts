import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { SSH_STAND_IN, gitEgressIn, labBaseEnv, labLayout, parseLabState, labLaunchVariables, labPaneCommand, labPaneState, labRefusal, labSessionId, nonLoopbackSockets, parseLabDoorState, parseLabRoute, readLabCapture, shellQuote } from "./rc-self-host-lab-core";

/** Ports and a pid with no meaning beyond being told apart in the assertions. */
const TRANSPARENT_PORT = 4321;
const TLS_PORT = 443;
/** The exit status OpenSSH ends with when it cannot connect, which the stand-in reproduces. */
const SSH_REFUSED_EXIT_STATUS = 255;
const DOOR_PORT = 5000;
const SUPERVISOR_PID = 7;

const line = (record: Record<string, unknown>): string => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", ...record });

describe("the lab's environment", () => {
  it("keeps only the inherited minimum and the lab's own home, never the operator's configuration directory, proxy or credentials", () => {
    const env = labBaseEnv({ HOME: "/h", TMPDIR: "/shared-tmp", PATH: "/bin", CLAUDE_CONFIG_DIR: "/real", HTTPS_PROXY: "http://x", ANTHROPIC_API_KEY: "k", AGENT_SHIM_HOME: "/real-home" }, { home: "/lab/home", claudeHome: "/lab/claude-home", userHome: "/lab/user-home", tmpDir: "/lab/tmp", stubBin: "/lab/bin" });
    expect(env).toEqual({ HOME: "/lab/user-home", TMPDIR: "/lab/tmp", DISABLE_AUTOUPDATER: "1", PATH: "/lab/bin:/bin", TERM: "xterm-256color", AGENT_SHIM_HOME: "/lab/home", AGENT_SHIM_CLAUDE_HOME: "/lab/claude-home", GIT_SSH_COMMAND: "false", GIT_TERMINAL_PROMPT: "0" });
  });

  it("reads each lab route by its name and nothing else", () => {
    expect(["launched", "supervised", "self-hosted"].map(parseLabRoute)).toEqual(["launched", "supervised", "self-hosted"]);
    expect(parseLabRoute("native")).toBeUndefined();
  });

  it("puts an ssh stand-in first on PATH that fails like a refused connection without opening one", () => {
    const run = spawnSync("sh", ["-c", SSH_STAND_IN]);
    expect(run.status).toBe(SSH_REFUSED_EXIT_STATUS);
  });

  it("starts the door in self-hosted mode with its capture on, its transparent surface on the given port, and nothing of ~/.claude shared", () => {
    expect(labLaunchVariables(TRANSPARENT_PORT)).toMatchObject({ AGENT_SHIM_FRONTDOOR_RC_SELF_HOST: "1", AGENT_SHIM_TRANSPARENT_SURFACE: "4321", AGENT_SHIM_FRONTDOOR_CAPTURE: "1", AGENT_SHIM_CATEGORY_OVERRIDE: "all=false" });
  });

  it("refuses an inherited CLAUDE_CONFIG_DIR, a foreign AGENT_SHIM_HOME, and a lab directory in a real state root or /tmp", () => {
    expect(labRefusal({}, "/work/lab1", "/u")).toBeUndefined();
    expect(labRefusal({ AGENT_SHIM_HOME: "/work/lab1/home" }, "/work/lab1", "/u")).toBeUndefined();
    expect(labRefusal({ CLAUDE_CONFIG_DIR: "/u/.claude" }, "/work/lab1", "/u")).toContain("CLAUDE_CONFIG_DIR is set");
    expect(labRefusal({ AGENT_SHIM_HOME: "/u/.agent-shim" }, "/work/lab1", "/u")).toContain("AGENT_SHIM_HOME is set");
    for (const dir of ["/u/.agent-shim/lab", "/u/.claude-use", "/u/.claude/x"]) {
      expect(labRefusal({}, dir, "/u")).toContain("a real state root");
    }
    expect(labRefusal({}, "/private/tmp/lab", "/u")).toContain("under /tmp");
    expect(labRefusal({}, "/u/.claude-elsewhere", "/u")).toBeUndefined();
  });

  it("builds the pane command with CLAUDE_CONFIG_DIR unset first and every word quoted", () => {
    expect(labPaneCommand({ A: "x y" }, ["node", "it's"])).toBe(`env -u CLAUDE_CONFIG_DIR A='x y' 'node' 'it'\\''s'`);
    expect(shellQuote("plain")).toBe("'plain'");
  });
});

describe("the lab's leak check", () => {
  it("passes a capture holding only the intercepted tunnels and upgrade arrivals", () => {
    const capture = [line({ kind: "connect", host: "api.anthropic.com", port: TLS_PORT, intercepted: true }), line({ kind: "upgrade", method: "GET", url: "/x", headers: {} }), ""].join("\n");
    expect(readLabCapture(capture)).toEqual({ records: 2, leaks: [], refusedTunnels: [] });
  });

  it("names every forwarded exchange, tapped stream and dialled tunnel as a leak, and a refused tunnel as refused", () => {
    const capture = [
      line({ kind: "request", id: 1, method: "GET", url: "/api/claude_code_grove", headers: {} }),
      line({ kind: "stream", id: 2, host: "platform.claude.com" }),
      line({ kind: "connect", host: "downloads.example.test", port: TLS_PORT, intercepted: false }),
      line({ kind: "connect-refused", host: "refused.example.test", port: TLS_PORT }),
      line({ kind: "routed-forward", method: "GET", url: "/v1/mcp_servers", headers: {} }),
    ].join("\n");
    const verdict = readLabCapture(capture);
    expect(verdict.refusedTunnels).toEqual([`refused.example.test:${String(TLS_PORT)}`]);
    expect(verdict.leaks).toEqual([
      { kind: "forwarded", detail: "GET /api/claude_code_grove" },
      { kind: "forwarded", detail: "stream to platform.claude.com" },
      { kind: "tunnel", detail: "downloads.example.test:443" },
      { kind: "forwarded", detail: "GET /v1/mcp_servers (routed pass-through)" },
    ]);
  });

  it("refuses a capture it cannot read instead of calling it clean", () => {
    expect(() => readLabCapture("not json\n")).toThrow("capture line 1 is not JSON");
    expect(() => readLabCapture("[1]\n")).toThrow("capture line 1 is not a JSON object");
    expect(() => readLabCapture("")).toThrow("the capture holds no records");
  });

  it("names every repository the CLI's debug log says git reached", () => {
    const log = ["2026 [DEBUG] git clone: url=git@github.example:o/r.git ref=default", "2026 [DEBUG] git clone succeeded: git@github.example:o/r.git", "2026 [DEBUG] git clone failed: x"].join("\n");
    expect(gitEgressIn(log)).toEqual(["git@github.example:o/r.git"]);
    expect(gitEgressIn("")).toEqual([]);
  });

  it("names every socket off this machine in lsof's field output, and none that is loopback or listening", () => {
    const fields = ["p101", "f12", "n127.0.0.1:5000", "f13", "n127.0.0.1:5001->127.0.0.1:5002", "f14", "n*:5003", "f15", "n[::1]:5004->[::1]:5005", "p102", "f3", "n192.168.1.20:6000->160.79.104.10:443"].join("\n");
    expect(nonLoopbackSockets(fields)).toEqual(["192.168.1.20:6000->160.79.104.10:443"]);
    expect(nonLoopbackSockets("")).toEqual([]);
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

describe("the lab's layout and state", () => {
  it("puts every root of the lab inside its directory, the home where the refusal expects it", () => {
    expect(labLayout("/lab")).toEqual({ home: "/lab/home", claudeHome: "/lab/claude-home", userHome: "/lab/user-home", work: "/lab/work", tmpDir: "/lab/tmp", stubBin: "/lab/bin" });
    expect(labRefusal({ AGENT_SHIM_HOME: labLayout("/lab").home }, "/lab", "/h")).toBeUndefined();
  });

  it("reads back the state up records, and nothing missing a field or of another type", () => {
    const state = { socket: "/lab/tmux.sock", home: "/lab/home", sessionId: "cse_1", cliBundle: "/b/cli.cjs", doorPid: 1, cliPid: 2, mockPid: 3 };
    expect(parseLabState(JSON.stringify(state))).toEqual(state);
    expect(parseLabState(JSON.stringify({ ...state, sessionId: undefined }))).toBeUndefined();
    expect(parseLabState(JSON.stringify({ ...state, doorPid: "1" }))).toBeUndefined();
    expect(parseLabState("not json")).toBeUndefined();
  });
});

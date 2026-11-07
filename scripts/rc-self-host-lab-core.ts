/**
 * The pure half of the isolated self-hosted Remote Control lab (`scripts/rc-self-host-lab.mts`): the environment a lab process starts with, the reading of the lab door's capture for anything that left the machine, and the reading of the CLI's pane and the door's log and state. Everything here takes text and returns values, so the rules the lab enforces are unit-tested without a door, a CLI or tmux.
 */

/**
 * The only variables a lab process inherits from the environment that runs the lab: enough for a shell, the toolchains on `PATH` and a terminal, and nothing that names an account, a configuration directory, a proxy or a credential. Everything else is left behind on purpose: an inherited `CLAUDE_CONFIG_DIR` makes the launched CLI run as the operator's real login (ExaDev/agent-shim#725), an inherited `HTTPS_PROXY` would route the CLI around the lab door, and the session running the lab carries provider keys of its own.
 */
export const LAB_INHERITED_VARIABLES: readonly string[] = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR"];

/**
 * The Claude Code version the lab runs unless told otherwise: the release the self-hosted surface's protocol and the isolation work were verified against. A pin the machine does not have installed fails the launch loudly rather than falling back to another version.
 */
export const PINNED_CLAUDE_VERSION = "2.1.319";

/** What the lab's environment is built from: the lab's own state roots. */
export interface LabEnvInputs {
  /** The throwaway `AGENT_SHIM_HOME`, inside the lab directory. */
  readonly home: string;
  /** The empty directory the lab's farm treats as `~/.claude` (`AGENT_SHIM_CLAUDE_HOME`), inside the lab directory, so no farm entry can point into the operator's real one. */
  readonly claudeHome: string;
  /** The lab's own `HOME`, inside the lab directory: the CLI reads user-level files (`~/.claude/CLAUDE.md`, `~/.ssh`, `~/.gitconfig`) from `HOME` whatever its configuration directory, so the operator's are out of reach only under a home of the lab's own. */
  readonly userHome: string;
  /** The directory, inside the lab directory, holding the `ssh` stand-in (see `SSH_STAND_IN`) that comes first on every lab process's `PATH`. */
  readonly stubBin: string;
}

/**
 * The script the lab's `ssh` stand-in runs: it fails the way a refused connection does (exit 255) without opening one. The CLI probes `ssh -T git@github.com` itself before it clones a plugin marketplace, outside git and so outside `GIT_SSH_COMMAND`, and OpenSSH reads `~/.ssh` from the passwd entry rather than `HOME`, so only a stand-in found first on `PATH` keeps that probe from reaching GitHub with the operator's keys.
 */
export const SSH_STAND_IN = "#!/bin/sh\nexit 255\n";

/**
 * Why the lab refuses to run in this environment, or undefined when it may: `CLAUDE_CONFIG_DIR` set (a launched CLI would run as the operator's real login, ExaDev/agent-shim#725, so the operator runs the lab under `env -u CLAUDE_CONFIG_DIR` and the refusal proves they did); `AGENT_SHIM_HOME` set to anything but the lab's own home (the lab makes its own throwaway one and never writes into another); or a lab directory inside a real state root (`~/.agent-shim`, `~/.claude-use`, `~/.claude`) or under `/tmp`, where the lab's minted credential and transcripts would outlive it or mix with real state.
 */
export function labRefusal(operator: Readonly<Record<string, string | undefined>>, labDir: string, operatorHome: string): string | undefined {
  if (operator.CLAUDE_CONFIG_DIR !== undefined) {
    return "CLAUDE_CONFIG_DIR is set; run the lab under env -u CLAUDE_CONFIG_DIR so nothing it starts can run as a real login";
  }
  const labHome = `${labDir}/home`;
  if (operator.AGENT_SHIM_HOME !== undefined && operator.AGENT_SHIM_HOME !== labHome) {
    return `AGENT_SHIM_HOME is set to ${operator.AGENT_SHIM_HOME}; unset it, since the lab makes its own throwaway home at ${labHome}`;
  }
  const inside = (root: string): boolean => labDir === root || labDir.startsWith(`${root}/`);
  const realRoots = [".agent-shim", ".claude-use", ".claude"].map((name) => `${operatorHome}/${name}`);
  const realRoot = realRoots.find(inside);
  if (realRoot !== undefined) {
    return `${labDir} is inside ${realRoot}, a real state root; put the lab somewhere of its own`;
  }
  if (inside("/tmp") || inside("/private/tmp")) {
    return `${labDir} is under /tmp; keep the lab out of it, since it holds a minted credential until down removes it`;
  }
  return undefined;
}

/**
 * The environment every lab process starts with: the inherited minimum, the lab's own `HOME`, `AGENT_SHIM_HOME` and `AGENT_SHIM_CLAUDE_HOME`, git's SSH transport disabled, an `ssh` stand-in first on `PATH`, and a terminal type the CLI renders against. `CLAUDE_CONFIG_DIR` is never in it, whatever the operator's environment holds.
 */
export function labBaseEnv(operator: Readonly<Record<string, string | undefined>>, inputs: LabEnvInputs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of LAB_INHERITED_VARIABLES) {
    const value = operator[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env.TERM = "xterm-256color";
  env.PATH = env.PATH === undefined ? inputs.stubBin : `${inputs.stubBin}:${env.PATH}`;
  env.HOME = inputs.userHome;
  env.AGENT_SHIM_HOME = inputs.home;
  env.AGENT_SHIM_CLAUDE_HOME = inputs.claudeHome;
  // Git over SSH ignores HTTPS_PROXY, so the CLI's plugin marketplace clone (git@github.com) would dial out around the door: every SSH transport is replaced by one that fails before connecting, and git never prompts for what it lacks.
  env.GIT_SSH_COMMAND = "false";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * The variables the launch adds to the base: the self-hosted mode, the transparent surface the door's own client half dials, the door's capture (which the leak check reads), and every configuration category unshared so the lab identity sees nothing of the operator's `~/.claude`. All of them are read by the door at start, which is why the launch that starts the lab's door is the one that must carry them.
 */
export function labLaunchVariables(transparentPort: number): Record<string, string> {
  return {
    AGENT_SHIM_FRONTDOOR_RC_SELF_HOST: "1",
    AGENT_SHIM_TRANSPARENT_SURFACE: String(transparentPort),
    AGENT_SHIM_FRONTDOOR_CAPTURE: "1",
    AGENT_SHIM_CATEGORY_OVERRIDE: "all=false",
  };
}

/** Quotes one word for a POSIX shell: single quotes, with an embedded single quote closed, escaped and reopened. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell command tmux runs for the CLI pane: `env -u CLAUDE_CONFIG_DIR` first (the variable is already absent from the base, and naming it here keeps that true even if the pane's shell profile sets it), then the launch variables, then the command. Every word is quoted.
 */
export function labPaneCommand(variables: Readonly<Record<string, string>>, command: readonly string[]): string {
  const assignments = Object.entries(variables).map(([name, value]) => `${name}=${shellQuote(value)}`);
  return ["env", "-u", "CLAUDE_CONFIG_DIR", ...assignments, ...command.map(shellQuote)].join(" ");
}

/** One thing the capture shows leaving the machine. */
export interface LabLeak {
  /** `forwarded`: a request, upgrade relay or tapped stream piped to an intercepted host's real upstream, which carries whatever credential the CLI presented. `tunnel`: a blind CONNECT tunnel the door dialled to a host outside the intercept set. */
  readonly kind: "forwarded" | "tunnel";
  readonly detail: string;
}

/** What the capture says about the lab: everything that left the machine, the tunnels the door refused instead, and how many records were read. */
export interface LabCaptureVerdict {
  readonly records: number;
  readonly leaks: readonly LabLeak[];
  /** The `host:port` of every CONNECT the door refused for the self-hosted session: attempted, never dialled. */
  readonly refusedTunnels: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "?";
}

/**
 * Reads the door's capture (`logs/frontdoor-capture.jsonl`, one JSON object per line) for anything that left the machine. A `request` record is a piped exchange to an intercepted host's real upstream (the door records one only for a request it forwards), a `routed-forward` record a request the routed pipeline's pass-through sent to the real API, a `stream` record is a tapped host's channel or a relayed upgrade, both pumped to the real host, and a `connect` record with `intercepted: false` is a blind tunnel to some other host; each is a leak, with no exemption, since a self-hosted session's door refuses every blind tunnel (a `connect-refused` record, reported but nothing dialled). A `connect` record for an intercepted host is the tunnel the door terminates itself, and an `upgrade` record is an upgrade's arrival (a refused one is recorded too, and a relayed one also leaves a `stream` record), so neither is. A line that is not a JSON object is an error rather than a skip, and so is a capture with no records at all, since a door that served a session always records its tunnels: a capture the check cannot read, or one the door never wrote to, cannot be said to be clean.
 */
export function readLabCapture(capture: string): LabCaptureVerdict {
  const leaks: LabLeak[] = [];
  const refusedTunnels: string[] = [];
  let records = 0;
  for (const [index, line] of capture.split("\n").entries()) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`capture line ${String(index + 1)} is not JSON`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`capture line ${String(index + 1)} is not a JSON object`);
    }
    records += 1;
    if (parsed.kind === "request" || parsed.kind === "routed-forward") {
      leaks.push({ kind: "forwarded", detail: `${text(parsed.method)} ${text(parsed.url)}${parsed.kind === "routed-forward" ? " (routed pass-through)" : ""}` });
    } else if (parsed.kind === "stream") {
      leaks.push({ kind: "forwarded", detail: `stream to ${text(parsed.host)}` });
    } else if (parsed.kind === "connect" && parsed.intercepted === false) {
      leaks.push({ kind: "tunnel", detail: `${text(parsed.host)}:${text(parsed.port)}` });
    } else if (parsed.kind === "connect-refused") {
      refusedTunnels.push(`${text(parsed.host)}:${text(parsed.port)}`);
    }
  }
  if (records === 0) {
    throw new Error("the capture holds no records; the lab door never recorded the session, so nothing can be said to have stayed local");
  }
  return { records, leaks, refusedTunnels };
}

/**
 * Where the CLI pane is in its start-up: Remote Control up; the folder-trust prompt, whose default is to exit; another first-run screen the lab confirms with its default (the theme picker, the security notes, the project MCP-server and external-import prompts, whose defaults all decline what they offer); or none of these yet.
 */
export type LabPaneState = "active" | "trust" | "confirm" | "starting";

/** Reads the CLI pane's visible text for the start-up state the lab drives. */
export function labPaneState(pane: string): LabPaneState {
  if (pane.includes("/remote-control is active")) {
    return "active";
  }
  if (pane.includes("Yes, I trust this folder")) {
    return "trust";
  }
  if (pane.includes("Enter to confirm") || pane.includes("Press Enter to continue") || pane.includes("Syntax theme:")) {
    return "confirm";
  }
  return "starting";
}

/** The session id the door's log names for the most recent Remote Control session created on its own surface, or undefined before one exists. */
export function labSessionId(doorLog: string): string | undefined {
  const matches = [...doorLog.matchAll(/rc selfhost (cse_[0-9a-f-]+): session created on the door's own surface/g)];
  return matches.at(-1)?.[1];
}

/** The two facts the lab reads from the door's state file: the provider listener's port (the door URL) and the supervisor's pid (what teardown stops). */
export interface LabDoorState {
  readonly port: number;
  readonly supervisorPid: number;
}

/** Parses the door's `frontdoor/state.json`, or undefined while the door has not written a complete one. */
export function parseLabDoorState(stateJson: string): LabDoorState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.port !== "number" || typeof parsed.supervisorPid !== "number") {
    return undefined;
  }
  return { port: parsed.port, supervisorPid: parsed.supervisorPid };
}

/** Whether one socket endpoint address (lsof's `host:port` form, IPv6 bracketed) is on this machine: loopback, or a listening wildcard. */
function isLocalEndpoint(endpoint: string): boolean {
  const host = endpoint.slice(0, endpoint.lastIndexOf(":"));
  return host === "127.0.0.1" || host === "[::1]" || host === "localhost" || host === "*" || host.startsWith("127.");
}

/**
 * The network endpoints in `lsof -nP -i -F n` output (one `n<local>` or `n<local>-><remote>` line per socket) that are not on this machine: every socket a lab process holds must be loopback, so any remote address here is traffic leaving the machine at the moment of reading, whatever the capture recorded.
 */
export function nonLoopbackSockets(lsofFields: string): readonly string[] {
  return lsofFields
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter((name) => !name.split("->").every(isLocalEndpoint));
}

/**
 * The repositories the CLI's debug log says it cloned or fetched (`git clone succeeded: <url>`, the line Claude Code writes after its plugin marketplace clone): git dials its remote itself, around the door and its capture, and a clone is over before a socket check could see it, so a success here is traffic that left the machine.
 */
export function gitEgressIn(debugLog: string): readonly string[] {
  return [...debugLog.matchAll(/git (?:clone|fetch|pull) succeeded: (\S+)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

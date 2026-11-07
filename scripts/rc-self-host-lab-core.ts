/**
 * The pure half of the isolated self-hosted Remote Control lab (`scripts/rc-self-host-lab.mts`): the environment a lab process starts with, the reading of the lab door's capture for anything that left the machine, and the reading of the CLI's pane and the door's log and state. Everything here takes text and returns values, so the rules the lab enforces are unit-tested without a door, a CLI or tmux.
 */

/**
 * The only variables a lab process inherits from the environment that runs the lab: enough for a shell, the toolchains on `PATH` and a terminal, and nothing that names an account, a configuration directory, a proxy or a credential. Everything else is left behind on purpose: an inherited `CLAUDE_CONFIG_DIR` makes the launched CLI run as the operator's real login (ExaDev/agent-shim#725), an inherited `HTTPS_PROXY` would route the CLI around the lab door, and the session running the lab carries provider keys of its own.
 */
export const LAB_INHERITED_VARIABLES: readonly string[] = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR"];

/** What the lab's environment is built from: the lab's own state root and, for the launch, the ports the door's transparent surface binds. */
export interface LabEnvInputs {
  /** The throwaway `AGENT_SHIM_HOME`, inside the lab directory. */
  readonly home: string;
}

/**
 * The environment every lab process starts with: the inherited minimum, the lab's own `AGENT_SHIM_HOME`, and a terminal type the CLI renders against. `CLAUDE_CONFIG_DIR` is never in it, whatever the operator's environment holds.
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
  env.AGENT_SHIM_HOME = inputs.home;
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
  /** `forwarded`: a request, upgrade relay or tapped stream piped to an intercepted host's real upstream, which carries whatever credential the CLI presented. `tunnel`: a blind CONNECT tunnel to a host outside the intercept set. */
  readonly kind: "forwarded" | "tunnel";
  readonly detail: string;
}

/** What the capture says about the lab: everything that left the machine, and how many records were read. */
export interface LabCaptureVerdict {
  readonly records: number;
  readonly leaks: readonly LabLeak[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "?";
}

/**
 * Reads the door's capture (`logs/frontdoor-capture.jsonl`, one JSON object per line) for anything that left the machine. A `request` record is a piped exchange to an intercepted host's real upstream (the door records one only for a request it forwards), a `stream` record is a tapped host's channel or a relayed upgrade, both pumped to the real host, and a `connect` record with `intercepted: false` is a blind tunnel to some other host; each is a leak. A `connect` record for an intercepted host is the tunnel the door terminates itself, and an `upgrade` record is an upgrade's arrival (a refused one is recorded too, and a relayed one also leaves a `stream` record), so neither is. A line that is not a JSON object is an error rather than a skip: a capture the check cannot read cannot be said to be clean.
 */
export function readLabCapture(capture: string, allowedTunnelHosts: readonly string[]): LabCaptureVerdict {
  const leaks: LabLeak[] = [];
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
    if (parsed.kind === "request") {
      leaks.push({ kind: "forwarded", detail: `${text(parsed.method)} ${text(parsed.url)}` });
    } else if (parsed.kind === "stream") {
      leaks.push({ kind: "forwarded", detail: `stream to ${text(parsed.host)}` });
    } else if (parsed.kind === "connect" && parsed.intercepted === false && !allowedTunnelHosts.includes(text(parsed.host))) {
      leaks.push({ kind: "tunnel", detail: `${text(parsed.host)}:${text(parsed.port)}` });
    }
  }
  return { records, leaks };
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

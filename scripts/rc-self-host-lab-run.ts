/**
 * An isolated self-hosted Remote Control lab on this machine: a real Claude Code CLI with Remote Control on, launched through this checkout's agent-shim against a throwaway `AGENT_SHIM_HOME`, served by that home's own door in self-hosted mode, with `scripts/rc-mock-provider.mts` as its only inference provider, all in a tmux server on the lab's own socket. Nothing is shared with the operator's identities, sessions or `~/.claude`, and the door's capture is checked for anything that left the machine.
 *
 * Usage (through `node scripts/rc-self-host-lab.mts`, which bundles this file):
 *
 * up --dir <lab-dir> [--allow-tunnel <host>]...   build and start the lab in <lab-dir> (which must not exist yet), wait for Remote Control to come up, print the lab's facts, then run the leak check check --dir <lab-dir> [--allow-tunnel <host>]... read the lab door's capture and fail if anything left the machine down --dir <lab-dir> [--keep] [--allow-tunnel <host>]...  run the leak check, stop the CLI, the mock provider and the lab door, and delete <lab-dir> unless --keep
 *
 * `up` prints, one per line: the lab directory, the tmux socket and the command that attaches to the CLI pane, the door URL (the provider listener the typed API and web client are served on, over TLS), the door's CA certificate, the control-token path, the Remote Control session id, the capture path, the CLI's debug log, and the environment prefix that points `agent-shim frontdoor rc ...` at the lab's door. The leak check exits 1 naming every forwarded exchange, tapped stream and blind tunnel the capture records; `--allow-tunnel` exempts a named host's blind tunnels (a CLI start-up dial outside the intercept set, never an intercepted host's forwarded traffic, which is always a leak).
 *
 * The CLI runs in `<lab-dir>/work` and, like any session, reads the project files of that directory's ancestors (`CLAUDE.md` imports, `.mcp.json` servers): the lab declines each first-run offer with the CLI's own default, but a lab outside every project tree starts from nothing at all.
 *
 * Requirements: this checkout built (`node scripts/build.mts --bundle-only`, which `pnpm install` runs), tmux, and a Claude Code CLI the launcher resolves. Keep <lab-dir> out of /tmp: it holds the lab's minted credential, logs and transcripts until `down` deletes it.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildLayoutPaths } from "../src/paths";
import { labBaseEnv, labLaunchVariables, labPaneCommand, labPaneState, labSessionId, parseLabDoorState, readLabCapture, shellQuote } from "./rc-self-host-lab-core";

const USAGE = "usage: node scripts/rc-self-host-lab.mts up|check|down --dir <lab-dir> [--allow-tunnel <host>]... [--keep]";

/** The identity the lab creates and launches: one per lab home, so the name needs no uniqueness of its own. */
const LAB_IDENTITY = "lab";
/** The provider file the lab writes, naming the mock provider. */
const LAB_PROVIDER = "mock";
/** The lab's state file inside the lab directory: what `check` and `down` read back. */
const LAB_STATE_FILE = "lab.json";
/** The tmux sessions on the lab's socket. */
const MOCK_SESSION = "mock";
const CLI_SESSION = "cc";
/** The CLI pane's size: wide enough that the status lines the lab reads are never wrapped. */
const PANE_COLUMNS = 200;
const PANE_ROWS = 50;
/** The mock credential's length in random bytes: 128 bits, the size of every other random credential the door mints. */
const MOCK_TOKEN_BYTES = 16;
/** Owner-only file mode for the lab's token and provider file. */
const PRIVATE_FILE_MODE = 0o600;

/** How often the lab polls the pane, the logs and the state file while it waits: a person-scale cadence, since every wait is on a process start. */
const POLL_MS = 1_000;
/** The longest any one start-up wait lasts before the lab gives up loudly: the CLI's start on a heavily loaded machine is the slowest step, and it has been seen to take tens of seconds. */
const START_DEADLINE_MS = 180_000;
/** How long teardown gives the door to exit after SIGTERM before saying so: the door drains its tunnels first. */
const STOP_DEADLINE_MS = 30_000;

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The bundled entry lives in `dist/`, so the checkout root is one level up from either location. */
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const CLI_BUNDLE = path.join(REPO_ROOT, "dist", "cli.cjs");
const MOCK_PROVIDER = path.join(REPO_ROOT, "scripts", "rc-mock-provider.mts");

/** What `up` records for `check` and `down`. */
interface LabState {
  readonly socket: string;
  readonly home: string;
  readonly supervisorPid: number;
}

interface Options {
  readonly command: string;
  readonly dir: string;
  readonly allowTunnels: readonly string[];
  readonly keep: boolean;
}

function parseOptions(argv: readonly string[]): Options | undefined {
  const [command, ...rest] = argv;
  let dir: string | undefined;
  const allowTunnels: string[] = [];
  let keep = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--keep") {
      keep = true;
    } else if ((flag === "--dir" || flag === "--allow-tunnel") && value !== undefined) {
      if (flag === "--dir") {
        dir = path.resolve(value);
      } else {
        allowTunnels.push(value);
      }
      index += 1;
    } else {
      return undefined;
    }
  }
  if (command === undefined || !["up", "check", "down"].includes(command) || dir === undefined) {
    return undefined;
  }
  return { command, dir, allowTunnels, keep };
}

/** Runs one command to completion with the lab's environment, failing loudly with its own output when it fails. Output is captured, never echoed, because the CLI's commands are quiet about tokens but the lab prints only what it chooses to. */
function run(command: string, args: readonly string[], env: Readonly<Record<string, string>>): string {
  const result = spawnSync(command, args, { env, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function tmux(socket: string, args: readonly string[], env: Readonly<Record<string, string>>): string {
  return run("tmux", ["-L", socket, ...args], env);
}

/** A port free on loopback right now, by binding port 0 and reading what the system chose. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("the loopback listener reported no port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls until `probe` answers a value, or fails naming what it waited for. */
async function waitFor<T>(what: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function readState(dir: string): LabState {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, LAB_STATE_FILE), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("socket" in parsed) || !("home" in parsed) || !("supervisorPid" in parsed) || typeof parsed.socket !== "string" || typeof parsed.home !== "string" || typeof parsed.supervisorPid !== "number") {
    throw new Error(`${path.join(dir, LAB_STATE_FILE)} is not a lab state file`);
  }
  return { socket: parsed.socket, home: parsed.home, supervisorPid: parsed.supervisorPid };
}

/** The leak check: prints the verdict and answers whether the capture is clean. */
function check(home: string, allowTunnels: readonly string[]): boolean {
  const capturePath = path.join(buildLayoutPaths(home).logsDir, "frontdoor-capture.jsonl");
  if (!fs.existsSync(capturePath)) {
    console.error(`rc-self-host-lab: no capture at ${capturePath}; the lab door never recorded anything, so nothing can be said to have stayed local`);
    return false;
  }
  const verdict = readLabCapture(fs.readFileSync(capturePath, "utf8"), allowTunnels);
  if (verdict.leaks.length === 0) {
    console.log(`leak check: clean (${String(verdict.records)} capture records, nothing forwarded upstream, no blind tunnel${allowTunnels.length === 0 ? "" : ` outside ${allowTunnels.join(", ")}`})`);
    return true;
  }
  console.error(`rc-self-host-lab: LEAK: the lab door's capture shows ${String(verdict.leaks.length)} request(s) leaving the machine:`);
  for (const leak of verdict.leaks) {
    console.error(`  ${leak.kind}: ${leak.detail}`);
  }
  return false;
}

async function up(options: Options): Promise<boolean> {
  if (fs.existsSync(options.dir)) {
    throw new Error(`${options.dir} already exists; a lab starts from an empty directory so nothing of an earlier one is reused`);
  }
  if (!fs.existsSync(CLI_BUNDLE)) {
    throw new Error(`${CLI_BUNDLE} is missing; build it with node scripts/build.mts --bundle-only`);
  }
  const home = path.join(options.dir, "home");
  const work = path.join(options.dir, "work");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const paths = buildLayoutPaths(home);
  const env = labBaseEnv(process.env, { home });
  const socket = `rc-lab-${path.basename(options.dir)}`;
  const agentShim = (args: readonly string[]): string => run(process.execPath, [CLI_BUNDLE, ...args], env);

  agentShim(["identity", "add", LAB_IDENTITY]);
  agentShim(["frontdoor", "rc", "selfhost", "mint", LAB_IDENTITY]);

  // The mock provider checks every request carries the provider file's own credential, so the lab mints one: random, lab-only, read by the mock from a file rather than its command line.
  const mockPort = await freePort();
  const tokenFile = path.join(options.dir, "mock.token");
  const token = randomBytes(MOCK_TOKEN_BYTES).toString("hex");
  fs.writeFileSync(tokenFile, token, { mode: PRIVATE_FILE_MODE });
  fs.mkdirSync(paths.providersDir, { recursive: true });
  fs.writeFileSync(path.join(paths.providersDir, `${LAB_PROVIDER}.json`), JSON.stringify({ displayName: "rc-self-host-lab mock", baseUrl: `http://127.0.0.1:${String(mockPort)}`, credential: { sources: [{ literal: token }] } }), { mode: PRIVATE_FILE_MODE });

  const mockLog = path.join(options.dir, "mock.log");
  tmux(socket, ["new-session", "-d", "-s", MOCK_SESSION, "-c", options.dir, `RC_MOCK_TOKEN=$(cat ${shellQuote(tokenFile)}) exec ${shellQuote(process.execPath)} ${shellQuote(MOCK_PROVIDER)} --port ${String(mockPort)} >> ${shellQuote(mockLog)} 2>&1`], env);
  await waitFor("the mock provider to listen", () => (readIfExists(mockLog).includes("listening") ? true : undefined));

  const transparentPort = await freePort();
  const debugLog = path.join(options.dir, "claude-debug.txt");
  const paneCommand = labPaneCommand(labLaunchVariables(transparentPort), [process.execPath, CLI_BUNDLE, "run", `@${LAB_IDENTITY}`, "--provider", LAB_PROVIDER, "--remote-control", "--debug-file", debugLog]);
  tmux(socket, ["new-session", "-d", "-s", CLI_SESSION, "-x", String(PANE_COLUMNS), "-y", String(PANE_ROWS), "-c", work, paneCommand], env);
  await waitFor("Remote Control to come up in the CLI pane", () => {
    const state = labPaneState(tmux(socket, ["capture-pane", "-p", "-t", CLI_SESSION], env));
    if (state === "trust") {
      // The trust prompt's default is "No, exit": the lab moves to "Yes" before confirming.
      tmux(socket, ["send-keys", "-t", CLI_SESSION, "Down"], env);
      tmux(socket, ["send-keys", "-t", CLI_SESSION, "Enter"], env);
    } else if (state === "confirm") {
      tmux(socket, ["send-keys", "-t", CLI_SESSION, "Enter"], env);
    }
    return state === "active" ? true : undefined;
  });

  const door = await waitFor("the lab door's state file", () => parseLabDoorState(readIfExists(paths.frontdoorStateFile)));
  const sessionId = await waitFor("the door to log the Remote Control session", () => labSessionId(readIfExists(paths.frontdoorLogPath)));
  const state: LabState = { socket, home, supervisorPid: door.supervisorPid };
  fs.writeFileSync(path.join(options.dir, LAB_STATE_FILE), JSON.stringify(state, null, 2));

  console.log(`lab dir:        ${options.dir}`);
  console.log(`tmux socket:    ${socket} (attach: tmux -L ${socket} attach -t ${CLI_SESSION})`);
  console.log(`door url:       https://127.0.0.1:${String(door.port)}`);
  console.log(`door ca:        ${path.join(paths.frontdoorCaDir, "ca.pem")}`);
  console.log(`control token:  ${paths.frontdoorControlTokenFile}`);
  console.log(`session id:     ${sessionId}`);
  console.log(`capture:        ${path.join(paths.logsDir, "frontdoor-capture.jsonl")}`);
  console.log(`cli debug log:  ${debugLog}`);
  console.log(`agent-shim:     env -u CLAUDE_CONFIG_DIR AGENT_SHIM_HOME=${shellQuote(home)} node ${shellQuote(CLI_BUNDLE)} frontdoor rc ...`);
  return check(home, options.allowTunnels);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function down(options: Options): Promise<boolean> {
  const state = readState(options.dir);
  const env = labBaseEnv(process.env, { home: state.home });
  const clean = check(state.home, options.allowTunnels);
  for (const session of [CLI_SESSION, MOCK_SESSION]) {
    const listed = spawnSync("tmux", ["-L", state.socket, "has-session", "-t", session], { env });
    if (listed.status === 0) {
      tmux(state.socket, ["kill-session", "-t", session], env);
    }
  }
  // The door outlives its launch by design (it idles down on its own clock), so teardown stops it by the pid its own state file named, and only when that file still names the same supervisor.
  const current = parseLabDoorState(readIfExists(buildLayoutPaths(state.home).frontdoorStateFile));
  if (current?.supervisorPid === state.supervisorPid && isAlive(state.supervisorPid)) {
    process.kill(state.supervisorPid, "SIGTERM");
    const deadline = Date.now() + STOP_DEADLINE_MS;
    while (isAlive(state.supervisorPid) && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (isAlive(state.supervisorPid)) {
      throw new Error(`the lab door (pid ${String(state.supervisorPid)}) did not exit after SIGTERM; ${options.dir} is left in place`);
    }
  }
  if (options.keep) {
    console.log(`lab stopped; ${options.dir} kept`);
  } else {
    fs.rmSync(options.dir, { recursive: true, force: true });
    console.log(`lab stopped and ${options.dir} removed`);
  }
  return clean;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    const clean = options.command === "up" ? await up(options) : options.command === "down" ? await down(options) : check(readState(options.dir).home, options.allowTunnels);
    process.exit(clean ? 0 : 1);
  } catch (error) {
    console.error(`rc-self-host-lab: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

await main();

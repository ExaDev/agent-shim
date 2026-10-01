import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { listFrontDoorSessions, readFrontDoorState, type FrontDoorSessionSummary, type FrontDoorState } from "../frontdoor/state";
import { isCodexProvider } from "../config/schema";
import { readAllProviders, type HeadroomFs } from "../headroom/state";
import { resolveClaudeHome, type LayoutPaths } from "../paths";
import { realFarmFs, realIsProcessRunning } from "../realPorts";
import { createUpstreamAgent, createUpstreamFetch } from "./agent";
import { createCodexAuthStore, type CodexAuthFs } from "./auth";
import type { UsageSnapshot } from "./quota";
import type { CodexRoutePorts } from "./route";
import { realTimers } from "./upstream";

/** The Codex CLI's home: `CODEX_HOME` when set, as the Codex CLI itself reads it, otherwise `~/.codex`. */
export function codexHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const fromEnv = env.CODEX_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : path.join(home, ".codex");
}

/** Where the usage snapshot for a statusline is written: the canonical Claude Code home, which a statusline's `externalUsagePath` names. */
export function codexUsageSnapshotPath(): string {
  return path.join(resolveClaudeHome(), "codex-quota.json");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Owner read and write only: the auth file holds the Codex login's tokens. */
const PRIVATE_FILE_MODE = 0o600;

/** The real auth filesystem port. */
const realCodexAuthFs: CodexAuthFs = {
  read: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  writePrivate: (filePath, contents) => {
    fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    // `mode` applies only when the file is created; a leftover temporary file from a crashed refresh keeps whatever mode it had.
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  },
  rename: (from, to) => {
    fs.renameSync(from, to);
  },
};

/** Writes the usage snapshot atomically; a failure is logged and never fails the request that produced it. */
function writeUsageSnapshot(log: (line: string) => void, snapshot: UsageSnapshot): void {
  const target = codexUsageSnapshotPath();
  const temp = `${target}.${String(process.pid)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
    fs.renameSync(temp, target);
  } catch (error) {
    log(`usage snapshot write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The ports the translation route needs, wired to the real auth store and upstream fetch, for the process that mounts the route: the front-door supervisor, which serves codex providers in process. The undici agent's keep-alive ceiling (the fix for the idle-socket hang) applies to every upstream call this process makes.
 */
export function createCodexRoutePorts(log: (line: string) => void): Omit<CodexRoutePorts, "loadProvider"> {
  const agent = createUpstreamAgent();
  const upstreamFetch = createUpstreamFetch(agent);
  const auth = createCodexAuthStore(path.join(codexHome(process.env, os.homedir()), "auth.json"), {
    fs: realCodexAuthFs,
    fetch: upstreamFetch,
    now: () => new Date(),
    tempSuffix: `${String(process.pid)}.${randomUUID()}`,
  });
  return {
    upstream: { fetch: upstreamFetch, auth, timers: realTimers, randomId: randomUUID },
    writeUsageSnapshot: (snapshot) => {
      writeUsageSnapshot(log, snapshot);
    },
    now: () => Date.now(),
    log,
  };
}

/** One session-registry entry plus whether its launcher is still running. */
interface CodexSessionStatus extends FrontDoorSessionSummary {
  readonly alive: boolean;
}

/** Everything `claude-use codex status` reports, collected read-only. */
export interface CodexStatus {
  /** The front door's state: the codex translation is one route inside the front-door daemon, so its availability is the front door's. */
  readonly frontDoor: FrontDoorState;
  readonly supervisorAlive: boolean;
  readonly sessions: readonly CodexSessionStatus[];
  /** The codex provider files this CLAUDE_USE_HOME defines. */
  readonly codexProviders: readonly string[];
  /** Where the statusline usage snapshot lives. */
  readonly usageSnapshotPath: string;
  readonly usageSnapshotExists: boolean;
  readonly logPath: string;
  readonly logExists: boolean;
}

/** Names every provider file whose kind is `codex`, best-effort through the same reader the headroom allowlist uses: a file that fails validation is skipped, since the point here is to name what is served, not to fail a status read. */
function codexProviderNames(fsPort: HeadroomFs, providersDir: string): readonly string[] {
  return readAllProviders(fsPort, providersDir)
    .filter((entry) => isCodexProvider(entry.provider))
    .map((entry) => entry.name)
    .sort();
}

/** Collects the codex translation's read-only status through the front door that serves it. */
export function collectCodexStatus(fsPort: HeadroomFs, paths: LayoutPaths, isRunning: (pid: number) => boolean): CodexStatus {
  const state = readFrontDoorState(fsPort, paths.frontdoorStateFile) ?? {};
  return {
    frontDoor: state,
    supervisorAlive: state.supervisorPid !== undefined && isRunning(state.supervisorPid),
    sessions: listFrontDoorSessions(fsPort, paths.frontdoorSessionsDir).map((session) => ({ ...session, alive: isRunning(session.pid) })),
    codexProviders: codexProviderNames(fsPort, paths.providersDir),
    usageSnapshotPath: codexUsageSnapshotPath(),
    usageSnapshotExists: fsPort.readFileUtf8(codexUsageSnapshotPath()) !== undefined,
    logPath: paths.frontdoorLogPath,
    logExists: fsPort.readFileUtf8(paths.frontdoorLogPath) !== undefined,
  };
}

/** Formats `claude-use codex status`, one line per entry. */
export function formatCodexStatus(status: CodexStatus): string[] {
  const lines: string[] = [];
  lines.push(
    status.frontDoor.supervisorPid === undefined
      ? "front door: not running"
      : `front door: supervisor pid ${String(status.frontDoor.supervisorPid)} (${status.supervisorAlive ? "alive" : "NOT running"})`,
  );
  if (status.frontDoor.port === undefined) {
    lines.push(`listener: not running${status.frontDoor.lastPort === undefined ? "" : ` (next start on 127.0.0.1:${String(status.frontDoor.lastPort)})`}`);
  } else {
    lines.push(`listener: front door on 127.0.0.1:${String(status.frontDoor.port)}, serving codex providers under /providers/<name>`);
  }
  lines.push(status.codexProviders.length === 0 ? "codex providers: none defined" : `codex providers: ${status.codexProviders.join(", ")}`);
  if (status.sessions.length === 0) {
    lines.push("sessions: none");
  } else {
    const pids = status.sessions.map((session) => `${String(session.pid)}${session.alive ? "" : " (dead)"}`);
    lines.push(`sessions: ${String(status.sessions.length)} registered (${pids.join(", ")})`);
  }
  if (status.frontDoor.lastError !== undefined) {
    lines.push(`last error: ${status.frontDoor.lastError}`);
  }
  lines.push(`usage snapshot: ${status.usageSnapshotPath}${status.usageSnapshotExists ? "" : " (not created yet)"}`);
  lines.push(`daemon log: ${status.logPath}${status.logExists ? "" : " (not created yet)"}`);
  return lines;
}

/** Registers `claude-use codex status`: the codex translation's read-only status through the front door that serves it. */
export function registerCodexCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const codex = withExamples(program.command("codex").description("Inspect the codex translation the front-door daemon serves for codex providers."), ["claude-use codex status"]);

  withExamples(
    codex
      .command("status")
      .description("Report the front door serving codex providers, its sessions, and the usage snapshot. Read-only.")
      .option("--json", "Print the status as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const status = collectCodexStatus(realFarmFs, paths, realIsProcessRunning);
        if (options.json === true) {
          printJson(status);
          return;
        }
        for (const line of formatCodexStatus(status)) {
          console.log(line);
        }
      }),
    ["claude-use codex status", "claude-use codex status --json"],
  );
}

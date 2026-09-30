import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { detachedDaemonSpawnOptions } from "../realPorts";

/** A process started by a launcher that then loses its terminal, the way a daemon does when the first session's window is closed. */
const LAUNCHER_SCRIPT = `
const { spawn } = require("node:child_process");
const detached = process.env.DAEMON_DETACHED === "true";
const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached, stdio: "ignore" });
daemon.unref();
process.stdout.write(String(daemon.pid) + "\\n");
setInterval(() => {}, 1000);
`;

const POLL_MS = 20;
const EXIT_TIMEOUT_MS = 2000;
const SETTLE_MS = 200;
const LOG_FD = 7;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  return true;
}

/**
 * Starts a stand-in launcher in its own process group (standing in for a terminal's foreground job), has it start a daemon with the given `detached` setting, then hangs up the whole group the way closing the terminal does. Returns whether the daemon survived.
 */
async function daemonSurvivesHangup(detached: boolean): Promise<boolean> {
  const launcher = spawn(process.execPath, ["-e", LAUNCHER_SCRIPT], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, DAEMON_DETACHED: String(detached) } });
  const launcherPid = launcher.pid;
  if (launcherPid === undefined) {
    throw new Error("launcher did not start");
  }
  const daemonPid = await new Promise<number>((resolve, reject) => {
    launcher.stdout.once("data", (chunk: Buffer) => {
      resolve(Number(chunk.toString("utf8").trim()));
    });
    launcher.once("error", reject);
  });
  try {
    process.kill(-launcherPid, "SIGHUP");
    expect(await waitFor(() => !isAlive(launcherPid), EXIT_TIMEOUT_MS)).toBe(true);
    // Give a hung-up daemon time to die before reading its fate.
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
    return isAlive(daemonPid);
  } finally {
    for (const pid of [daemonPid, launcherPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

describe("detachedDaemonSpawnOptions", () => {
  it("detaches the daemon from the launcher's terminal and sends its output to the log", () => {
    const env = { PATH: "/usr/bin" };
    expect(detachedDaemonSpawnOptions(LOG_FD, env)).toEqual({ detached: true, stdio: ["ignore", LOG_FD, LOG_FD], env });
  });

  it.skipIf(process.platform === "win32")("keeps a detached daemon alive when the first session's terminal hangs up", async () => {
    expect(detachedDaemonSpawnOptions(1, {}).detached).toBe(true);
    expect(await daemonSurvivesHangup(true)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("would lose a daemon started without detaching, which is what the option prevents", async () => {
    expect(await daemonSurvivesHangup(false)).toBe(false);
  });
});

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { LayoutPaths } from "../paths";
import { handOverListeners, predecessorOver, type HandoverOutcome, type HandoverSockets, type Predecessor, type PredecessorChannel, type SuccessorChannel } from "./handover";

/** The invocation that starts a successor door: this very executable running the supervisor subcommand (`selfInvocation`), so a door running from an installed path starts whatever that path now holds. */
export interface SuccessorInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Starts the successor door with an IPC channel beside its log-file output, detached from this door's session exactly as every background daemon is (see `detachedDaemonSpawnOptions`), with `AGENT_SHIM_HOME` pinned to this door's state root. The channel is the handover's only path; `release` ends it and drops this process's reference, after which the successor is an ordinary detached door that outlives this one.
 */
function spawnSuccessorDoor(paths: LayoutPaths, invocation: SuccessorInvocation): SuccessorChannel {
  fs.mkdirSync(path.dirname(paths.frontdoorLogPath), { recursive: true });
  const logFd = fs.openSync(paths.frontdoorLogPath, "a");
  let child;
  try {
    child = spawn(invocation.command, [...invocation.args], { detached: true, stdio: ["ignore", logFd, logFd, "ipc"], env: { ...process.env, AGENT_SHIM_HOME: paths.root } });
  } finally {
    fs.closeSync(logFd);
  }
  const { pid } = child;
  if (pid === undefined) {
    throw new Error("spawning the successor front door returned no pid");
  }
  const spawned = child;
  return {
    pid,
    sendListener: (message, socket) => {
      spawned.send(message, socket);
    },
    onMessage: (listener) => {
      spawned.on("message", (message: unknown) => {
        listener(message);
      });
    },
    onGone: (listener) => {
      let fired = false;
      const once = (description: string): void => {
        if (!fired) {
          fired = true;
          listener(description);
        }
      };
      spawned.once("exit", (code, signal) => {
        once(`exited (${signal ?? `code ${String(code)}`})`);
      });
      spawned.once("disconnect", () => {
        once("closed its channel");
      });
      // A failed spawn (the executable missing) is reported here and not by `exit`.
      spawned.once("error", (error) => {
        once(`could not be started: ${error.message}`);
      });
    },
    release: () => {
      // A successor that has exited or already ended the channel has nothing left to disconnect, and `disconnect` on a closed channel emits an error event rather than doing nothing.
      if (spawned.connected) {
        spawned.disconnect();
      }
      spawned.unref();
    },
    kill: () => {
      spawned.kill("SIGKILL");
    },
  };
}

/** The real handover a door runs on request: the successor started through `spawnSuccessorDoor`, the budget kept on a timer that never holds the process open. */
export async function realHandOverListeners(paths: LayoutPaths, invocation: SuccessorInvocation, sockets: HandoverSockets, budgetMs: number): Promise<HandoverOutcome> {
  return await handOverListeners({
    spawn: () => spawnSuccessorDoor(paths, invocation),
    sockets,
    budgetMs,
    timers: {
      startTimer: (ms) => {
        let timer: NodeJS.Timeout | undefined;
        const elapsed = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
          timer.unref();
        });
        return {
          elapsed,
          cancel: () => {
            clearTimeout(timer);
          },
        };
      },
    },
  });
}

/**
 * The door this process replaces, when it was started by `spawnSuccessorDoor`: Node opens the IPC channel only for a child spawned with one, which no other start of the supervisor does. Undefined otherwise.
 */
export function predecessorOfThisProcess(): Predecessor | undefined {
  if (process.channel === undefined || process.send === undefined || process.disconnect === undefined) {
    return undefined;
  }
  const send = process.send.bind(process);
  const disconnect = process.disconnect.bind(process);
  const channel: PredecessorChannel = {
    // The callback runs once the message is written (or failed to be): either way nothing more will reach the old door through it.
    send: (message, sent) => {
      send(message, () => {
        sent?.();
      });
    },
    onMessage: (listener) => {
      process.on("message", (message: unknown, handle: unknown) => {
        listener(message, handle);
      });
    },
    onGone: (listener) => {
      process.once("disconnect", () => {
        listener("closed");
      });
    },
    release: () => {
      if (process.connected) {
        disconnect();
      }
    },
  };
  return predecessorOver(channel, (handle): handle is net.Server => handle instanceof net.Server);
}

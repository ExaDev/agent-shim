import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

import type { LogPort, SpawnResult, SupervisedSpawnPort } from "../launcher/ports";
import { realFarmFs } from "../realPorts";
import type { SignalPort, TimerPort } from "./supervise";

/** The real `SupervisedSpawnPort`: the child keeps the terminal, and its exit is a promise that never rejects. */
export const realSupervisedSpawnPort: SupervisedSpawnPort = {
  spawn(command, args, options) {
    const child = spawn(command, [...args], { stdio: options.stdio, env: { ...options.env } });
    const exit = new Promise<SpawnResult>((resolve) => {
      child.once("error", (error) => {
        resolve({ status: null, signal: null, error });
      });
      child.once("close", (status, signal) => {
        resolve({ status, signal });
      });
    });
    return {
      exit,
      signal: (signal) => {
        child.kill(signal);
      },
    };
  },
};

/** The real `SignalPort`, over this process's own signal handlers. */
export const realSignalPort: SignalPort = {
  on(signal, handler) {
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
};

/** The real `TimerPort`. */
export const realTimerPort: TimerPort = {
  after(ms) {
    let timer: NodeJS.Timeout | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return {
      elapsed,
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },
};

/**
 * Watches the usage snapshots directory and calls `onChange` when `<identity>.json` is written. The door replaces a snapshot by renaming a temporary file over it, which a directory watch reports; a watch on the file itself would be left pointing at the replaced one. The watcher does not keep the process alive, and a watcher error is reported once and ends the watch rather than going unseen.
 */
export function realWatchUsage(snapshotsDir: string, log: LogPort): (identity: string, onChange: () => void) => () => void {
  return (identity, onChange) => {
    // The door creates the directory at its first record; an identity that has never been routed has none yet.
    realFarmFs.mkdirPrivate(snapshotsDir);
    const watcher = fs.watch(snapshotsDir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === `${identity}.json`) {
        onChange();
      }
    });
    watcher.on("error", (error) => {
      log.warn(`agent-shim: the usage watch for ${identity} stopped (${error.message}); this session will not be moved when ${identity} runs out of quota`);
      watcher.close();
    });
    return () => {
      watcher.close();
    };
  };
}

/** What a terminal needs written to leave the modes claude sets while it runs, as claude itself leaves them when it exits: the cursor shown, mouse reporting, bracketed paste and focus reporting off, the enhanced keyboard mode popped, and the text attributes reset. The alternate screen is left alone: claude does not use it, and leaving a screen one was never in can move the cursor. */
const TERMINAL_RESET = "\u001B[?25h\u001B[?1006l\u001B[?1003l\u001B[?1002l\u001B[?1000l\u001B[?2004l\u001B[?1004l\u001B[<u\u001B[0m";

/**
 * Puts the terminal back as a shell expects it, after a child was killed before it could do so itself: the escape sequences that leave the modes claude sets, then `stty sane` for the line settings it changed. Does nothing when output is not a terminal.
 */
export function resetTerminal(): void {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write(TERMINAL_RESET);
  spawnSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
}

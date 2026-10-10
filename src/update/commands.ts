import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Option, type Command } from "commander";

import packageJson from "../../package.json";
import { reportMutation, printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { readGlobalConfig } from "../configProfilesStore";
import { applyPatch, writeTextAtomic } from "../config/store";
import { UPDATE_MODES, GlobalConfigSchema, type UpdateMode } from "../config/schema";
import type { LayoutPaths } from "../paths";
import { realRestartFrontDoor } from "../frontdoor/realFrontDoorPort";
import { realOwnExecutablePath, spawnDetachedSupervisor, spawnSelfDetached } from "../realPorts";
import { runSelfUpdate, type SelfUpdateOptions, type UpdateReport, type UpdatePorts } from "./update";
import type { UpdateLaunchPort } from "./launchHook";

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** The real `UpdatePorts`: Node's own `fetch` (which follows redirects, so `response.url` is the effective URL install.sh reads out of `curl -w %{url_effective}`), `node:fs`, and signal-0 liveness. */
const realUpdatePorts: UpdatePorts = {
  http: {
    effectiveUrl: async (url) => {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      return response.url;
    },
    download: async (url) => {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  },
  fs: {
    realpath: (target) => fs.realpathSync(target),
    readFileUtf8: (filePath) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch (error) {
        if (isEnoent(error)) {
          return undefined;
        }
        throw error;
      }
    },
    readFileBytes: (filePath) => {
      try {
        return new Uint8Array(fs.readFileSync(filePath));
      } catch (error) {
        if (isEnoent(error)) {
          return undefined;
        }
        throw error;
      }
    },
    readFileHead: (filePath, length) => {
      let descriptor: number;
      try {
        descriptor = fs.openSync(filePath, "r");
      } catch (error) {
        if (isEnoent(error)) {
          return undefined;
        }
        throw error;
      }
      try {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(descriptor, buffer, 0, length, 0);
        return read === 0 ? "" : buffer.toString("latin1", 0, read);
      } finally {
        fs.closeSync(descriptor);
      }
    },
    writeFileUtf8: (filePath, contents) => {
      fs.writeFileSync(filePath, contents, "utf8");
    },
    writeFileBytes: (filePath, contents) => {
      fs.writeFileSync(filePath, contents);
    },
    writeFileExclusive: (filePath, contents) => {
      try {
        fs.writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (error) {
        if (isErrorWithCode(error, "EEXIST")) {
          return false;
        }
        throw error;
      }
    },
    unlink: (filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (!isEnoent(error)) {
          throw error;
        }
      }
    },
    rename: (from, to) => {
      fs.renameSync(from, to);
    },
    chmod: (filePath, mode) => {
      fs.chmodSync(filePath, mode);
    },
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-update-")),
    rmRecursive: (targetPath) => {
      fs.rmSync(targetPath, { recursive: true, force: true });
    },
  },
  // Signal 0 performs the permission and existence checks without delivering anything; EPERM means the process exists but belongs to another user.
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrorWithCode(error, "EPERM");
    }
  },
};

/** The inputs one self-update or update check runs with: this process's version, platform and executable, and the lock beside the state root. */
function selfUpdateOptions(paths: LayoutPaths, checkOnly: boolean): SelfUpdateOptions {
  return {
    currentVersion: packageJson.version,
    platform: process.platform,
    arch: process.arch,
    executablePath: realOwnExecutablePath(),
    lockPath: path.join(paths.root, "update.lock"),
    checkOnly,
    pid: process.pid,
  };
}

/** `agent-shim update --check` as a function: asks the release channel for the newest release and reports against the running version, downloading and changing nothing. Raises the update path's own refusals (a package-manager channel, a concurrent update, a release that could not be fetched). */
export async function checkForUpdate(paths: LayoutPaths): Promise<UpdateReport> {
  return await runSelfUpdate(realUpdatePorts, selfUpdateOptions(paths, true));
}

/** `agent-shim update`'s one line of human output per outcome. */
export function formatUpdateReport(report: UpdateReport): string {
  switch (report.action) {
    case "current":
      return `already at the latest release (${report.latest})`;
    case "available":
      return `update available: ${report.current} -> ${report.latest} (run \`agent-shim update\` to install it)`;
    case "updated":
      return `updated agent-shim: ${report.current} -> ${report.latest}`;
    default:
      return report.action satisfies never;
  }
}

/** Writes `update.mode` into the user-global config, preserving every other field: `applyPatch` replaces top-level keys wholesale, so the existing `update` block is read and merged here first. */
function setUpdateMode(paths: LayoutPaths, mode: UpdateMode): void {
  const existing = readGlobalConfig(paths);
  applyPatch(paths.globalConfigFile, GlobalConfigSchema, { update: { ...existing?.update, mode } }, { defaults: {} });
}

/**
 * The real `UpdateLaunchPort` for the command line launcher: the update command's own network port resolves the newest release, the config store's atomic write stamps the cooldown file, and the background apply re-invokes this very binary as a detached `agent-shim update` (stdio ignored, unref'd) so it outlives the launch it was spawned from. `AGENT_SHIM_HOME` is passed explicitly so the detached update locks and stamps under the same root as the launcher that spawned it, for the same reason the daemon spawner passes it.
 */
export function realLaunchUpdatePort(paths: LayoutPaths): UpdateLaunchPort {
  return {
    effectiveUrl: realUpdatePorts.http.effectiveUrl,
    readStamp: (filePath) => realUpdatePorts.fs.readFileUtf8(filePath),
    writeStamp: (filePath, contents) => {
      writeTextAtomic(filePath, contents);
    },
    now: () => Date.now(),
    spawnDetached: (args) => {
      spawnSelfDetached(paths, args);
    },
    writeErr: (line) => {
      console.error(line);
    },
  };
}

/**
 * Registers `agent-shim update` onto `program`: resolves the running executable, checks the channel and the latest release through `runSelfUpdate`, and prints the outcome as text or JSON. Refusals (a package-manager channel, a live lock, a download or checksum failure) reach the top-level catch as `CliError`s and exit with the failure status.
 */
export function registerUpdateCommand(program: Command, deps: CommandDeps, ports: UpdatePorts = realUpdatePorts): void {
  withExamples(
    program
      .command("update")
      .description(
        "Download the newest release binary and install it over the running one. An installation that belongs to a package manager (Homebrew, npm, Scoop) names its channel and its upgrade command instead of updating in place. With --mode, set the launch-time update mode in the global config instead of updating now.",
      )
      .option("--check", "Only report whether a newer release exists; download and change nothing.")
      .option("--restart-door", "After installing a newer release, replace the serving front door with one started from it, in place, instead of leaving the old one until its sessions end.")
      .addOption(new Option("--mode <mode>", "Set what a launch does about a newer release (off: nothing; notify: print one line; auto: also apply it in the background) in the global config, then exit.").choices(UPDATE_MODES))
      .option("--json", "Print the result as JSON.")
      .action(async (options: Readonly<{ check?: boolean; json?: boolean; mode?: UpdateMode; restartDoor?: boolean }>) => {
        const mode = options.mode;
        if (mode !== undefined) {
          setUpdateMode(deps.paths, mode);
          reportMutation(options.json, { action: "updated", kind: "update", name: "mode", value: { mode } }, () => {
            console.log(`update mode set to ${mode}`);
          });
          return;
        }
        const report = await runSelfUpdate(ports, selfUpdateOptions(deps.paths, options.check === true));
        // Only an applied update has a newer binary for the door to restart into; every other outcome (current, check-only, a channel refusal) leaves the door as it is.
        const doorRestart = options.restartDoor === true && report.action === "updated" ? realRestartFrontDoor(deps.paths, spawnDetachedSupervisor) : undefined;
        if (options.json === true) {
          printJson(doorRestart === undefined ? report : { ...report, frontdoor: doorRestart });
          return;
        }
        console.log(formatUpdateReport(report));
        if (doorRestart?.action === "restarted") {
          console.log(`front door restarted: pid ${String(doorRestart.previousPid)} -> ${String(doorRestart.pid)}`);
        }
      }),
    ["agent-shim update", "agent-shim update --check", "agent-shim update --mode auto", "agent-shim update --json"],
  );
}

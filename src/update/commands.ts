import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import packageJson from "../../package.json";
import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { realOwnExecutablePath } from "../realPorts";
import { runSelfUpdate, type UpdateReport, type UpdatePorts } from "./update";

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

/**
 * Registers `agent-shim update` onto `program`: resolves the running executable, checks the channel and the latest release through `runSelfUpdate`, and prints the outcome as text or JSON. Refusals (a package-manager channel, a live lock, a download or checksum failure) reach the top-level catch as `CliError`s and exit with the failure status.
 */
export function registerUpdateCommand(program: Command, deps: CommandDeps, ports: UpdatePorts = realUpdatePorts): void {
  withExamples(
    program
      .command("update")
      .description(
        "Download the newest release binary and install it over the running one. An installation that belongs to a package manager (Homebrew, npm, Scoop) names its channel and its upgrade command instead of updating in place.",
      )
      .option("--check", "Only report whether a newer release exists; download and change nothing.")
      .option("--json", "Print the result as JSON.")
      .action(async (options: Readonly<{ check?: boolean; json?: boolean }>) => {
        const report = await runSelfUpdate(ports, {
          currentVersion: packageJson.version,
          platform: process.platform,
          arch: process.arch,
          executablePath: realOwnExecutablePath(),
          lockPath: path.join(deps.paths.root, "update.lock"),
          checkOnly: options.check === true,
          pid: process.pid,
        });
        if (options.json === true) {
          printJson(report);
          return;
        }
        console.log(formatUpdateReport(report));
      }),
    ["agent-shim update", "agent-shim update --check", "agent-shim update --json"],
  );
}

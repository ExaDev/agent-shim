import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { connectProxyUrl } from "./capability";
import { readFrontDoorState } from "./state";
import { realFarmFs } from "../realPorts";

/** The capability the test registers for itself as a live launch: what the CONNECT surface demands of a tunnel. */
const CAPABILITY = "drain-e2e-capability";
const BUNDLE_TARGET = "node22";
const IMPORT_META_URL_VARIABLE = "__agentShimImportMetaUrl";
const POLL_MS = 25;
/** Ceilings for events the real process produces; a pass takes a small fraction of each. */
const STARTUP_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 5_000;
const SUITE_TIMEOUT_MS = 60_000;

async function until<T>(read: () => T | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The CLI bundled the way the release bundles it, into a file under `dir`, so the test runs the real `__frontdoor-supervisor` with no prebuilt artefact. */
async function bundleCli(dir: string): Promise<string> {
  const outfile = path.join(dir, "cli.cjs");
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "..", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: BUNDLE_TARGET,
    outfile,
    banner: { js: `const ${IMPORT_META_URL_VARIABLE} = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;` },
    define: { "import.meta.url": IMPORT_META_URL_VARIABLE },
    logLevel: "silent",
  });
  return outfile;
}

/**
 * A real front-door process in a throwaway state directory, on ports it picks itself, with this test process registered as a live launch so a tunnel is admitted. Nothing of the real installation is read, signalled or written: the process is the one this test started and the home is a fresh temporary directory.
 */
describe.skipIf(process.platform === "win32")("a retiring front door over a real process", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
  });

  it(
    "keeps an established blind tunnel running after SIGTERM, refuses new connections, frees its port for a successor, and exits when the tunnel ends",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "drain-e2e-"));
      cleanups.push(() => {
        fs.rmSync(home, { recursive: true, force: true });
      });
      const cli = await bundleCli(home);

      const echo = net.createServer((socket) => {
        socket.on("data", (chunk) => {
          socket.write(chunk);
        });
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) => {
        echo.listen(0, "127.0.0.1", resolve);
      });
      cleanups.push(() => {
        echo.close();
      });
      const echoPort = (echo.address() as net.AddressInfo).port;

      const door: ChildProcess = spawn(process.execPath, [cli, "__frontdoor-supervisor"], { env: { ...process.env, AGENT_SHIM_HOME: home }, stdio: "ignore" });
      cleanups.push(() => {
        door.kill("SIGKILL");
      });
      const doorPid = door.pid;
      if (doorPid === undefined) {
        throw new Error("the door did not start");
      }
      const stateFile = path.join(home, "frontdoor", "state.json");
      const readState = () => readFrontDoorState(realFarmFs, stateFile);
      const serving = await until(() => {
        const state = readState();
        return state?.supervisorPid === doorPid && state.connectPort !== undefined ? state : undefined;
      }, STARTUP_TIMEOUT_MS, "the door to serve");
      const connectPort = serving.connectPort ?? 0;

      fs.mkdirSync(path.join(home, "frontdoor", "sessions"), { recursive: true });
      fs.writeFileSync(path.join(home, "frontdoor", "sessions", `${String(process.pid)}.json`), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: CAPABILITY, supervisorPid: doorPid }));

      const credential = new URL(connectProxyUrl(connectPort, CAPABILITY));
      const authorization = Buffer.from(`${decodeURIComponent(credential.username)}:${decodeURIComponent(credential.password)}`).toString("base64");
      const tunnel = net.connect(connectPort, "127.0.0.1");
      cleanups.push(() => {
        tunnel.destroy();
      });
      let received = "";
      tunnel.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
      });
      tunnel.write(`CONNECT 127.0.0.1:${String(echoPort)} HTTP/1.1\r\nHost: 127.0.0.1:${String(echoPort)}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
      await until(() => received.includes("200"), EVENT_TIMEOUT_MS, "the tunnel to be established");
      const echoes = async (payload: string): Promise<void> => {
        received = "";
        tunnel.write(payload);
        await until(() => received.includes(payload), EVENT_TIMEOUT_MS, `the tunnel to echo ${payload}`);
      };
      await echoes("before");

      door.kill("SIGTERM");
      await until(() => readState()?.supervisorPid === undefined, EVENT_TIMEOUT_MS, "the door to stop naming itself the owner");

      // Still running, still carrying the tunnel.
      expect(isAlive(doorPid)).toBe(true);
      await echoes("during");

      // The released port refuses new connections and is free for a successor to bind.
      const refusal = await new Promise<string>((resolve) => {
        const probe = net.connect(connectPort, "127.0.0.1");
        probe.once("error", (error: NodeJS.ErrnoException) => {
          resolve(error.code ?? "error");
        });
        probe.once("connect", () => {
          probe.destroy();
          resolve("accepted");
        });
      });
      expect(refusal).toBe("ECONNREFUSED");
      const successorBound = await new Promise<boolean>((resolve) => {
        const successor = net.createServer();
        successor.once("error", () => {
          resolve(false);
        });
        successor.listen(connectPort, "127.0.0.1", () => {
          successor.close(() => {
            resolve(true);
          });
        });
      });
      expect(successorBound).toBe(true);

      // The drain ends with the last tunnel.
      const exited = new Promise<number | null>((resolve) => {
        door.once("exit", (code) => {
          resolve(code);
        });
      });
      tunnel.destroy();
      expect(await exited).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );
});

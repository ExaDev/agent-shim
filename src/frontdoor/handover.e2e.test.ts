import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { buildLayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { connectProxyUrl } from "./capability";
import { listDrainingFrontDoors, readFrontDoorState } from "./state";

/** The capability the test registers for itself as a live launch: what the CONNECT surface demands of a tunnel. */
const CAPABILITY = "handover-e2e-capability";
const BUNDLE_TARGET = "node22";
const IMPORT_META_URL_VARIABLE = "__agentShimImportMetaUrl";
const POLL_MS = 25;
/** Ceilings for events the real processes produce; a pass takes a small fraction of each. */
const STARTUP_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 5_000;
const SUITE_TIMEOUT_MS = 120_000;
/** A connection that neither answers nor fails within this is counted as hung: an accepted connection nothing serves, which is exactly what a socket adopted too late would produce. */
const HANG_GUARD_MS = 10_000;
/** Attempts each listener makes before the request and again after the old door stopped accepting, so traffic crosses the whole swap on every listener rather than being inferred; the overlap between is crossed by whatever the loops send while it lasts. */
const ATTEMPTS_PER_PHASE = 5;

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

/** The CLI bundled the way the release bundles it, into a file under `dir`, so the test runs the real `__frontdoor-supervisor` (and the successor it starts from the same file) with no prebuilt artefact. */
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

/** How one attempt ended; a failure other than a refusal carries its error code (or message), so a failing run says what went wrong. */
type Outcome = "served" | "refused" | "hung" | `failed: ${string}`;

/** One request to one listener on a fresh connection: the provider listener's and the direct listener's health endpoints, and an unauthenticated CONNECT on the CONNECT surface, which the surface answers with a refusal of its own. Any HTTP answer is `served`; a refused TCP connection is `refused`. */
async function answer(listener: "provider" | "connect" | "direct", port: number, ca: string): Promise<Outcome> {
  return await new Promise<Outcome>((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      resolve(error.code === "ECONNREFUSED" ? "refused" : `failed: ${error.code ?? error.message}`);
    };
    if (listener === "connect") {
      const socket = net.connect(port, "127.0.0.1");
      let head = "";
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString("utf8");
        if (head.startsWith("HTTP/1.1 ")) {
          socket.destroy();
          resolve("served");
        }
      });
      socket.on("error", onError);
      socket.write("CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n");
      return;
    }
    const options = { host: "127.0.0.1", port, path: "/healthz", agent: false };
    const onResponse = (response: http.IncomingMessage): void => {
      response.resume();
      resolve(response.statusCode === undefined ? "failed: no status" : "served");
    };
    const request = listener === "provider" ? https.get({ ...options, ca: [ca] }, onResponse) : http.get(options, onResponse);
    request.on("error", onError);
  });
}

/** `answer`, or `hung` when it has neither answered nor failed within the hang guard. */
async function attempt(listener: "provider" | "connect" | "direct", port: number, ca: string): Promise<Outcome> {
  let guard: NodeJS.Timeout | undefined;
  const hung = new Promise<Outcome>((resolve) => {
    guard = setTimeout(() => {
      resolve("hung");
    }, HANG_GUARD_MS);
  });
  const outcome = await Promise.race([answer(listener, port, ca), hung]);
  clearTimeout(guard);
  return outcome;
}

/**
 * A real front door handing its listeners to the successor it starts, in a throwaway state directory on ports it picks itself, with this test process registered as a live launch so a tunnel is admitted. Nothing of the real installation is read, signalled or written: both doors are processes this test started (the successor through the first), and the home is a fresh temporary directory.
 */
describe.skipIf(process.platform === "win32")("a front door handing its listeners to its successor over real sockets", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
  });

  it(
    "refuses no connection on any listener across the swap, serves on through the successor once the old door stops accepting, and lets a connection opened before the swap finish on the old door",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "handover-e2e-"));
      cleanups.push(() => {
        fs.rmSync(home, { recursive: true, force: true });
      });
      const layout = buildLayoutPaths(home);
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
      const readState = () => readFrontDoorState(realFarmFs, layout.frontdoorStateFile);
      const serving = await until(() => {
        const state = readState();
        return state?.supervisorPid === doorPid && state.port !== undefined && state.connectPort !== undefined && state.directPort !== undefined ? state : undefined;
      }, STARTUP_TIMEOUT_MS, "the door to serve");
      const ports = { provider: serving.port ?? 0, connect: serving.connectPort ?? 0, direct: serving.directPort ?? 0 };
      const ca = fs.readFileSync(layout.frontdoorCaCertFile, "utf8");
      const controlToken = fs.readFileSync(layout.frontdoorControlTokenFile, "utf8");

      fs.mkdirSync(layout.frontdoorSessionsDir, { recursive: true });
      fs.writeFileSync(path.join(layout.frontdoorSessionsDir, `${String(process.pid)}.json`), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: CAPABILITY, supervisorPid: doorPid }));

      // A blind tunnel opened before the swap: it must keep working on the old door after the successor has taken the listeners.
      const credential = new URL(connectProxyUrl(ports.connect, CAPABILITY));
      const authorization = Buffer.from(`${decodeURIComponent(credential.username)}:${decodeURIComponent(credential.password)}`).toString("base64");
      const tunnel = net.connect(ports.connect, "127.0.0.1");
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

      // Clients connecting in a loop on every listener for the whole swap, each phase counted.
      type Phase = "before" | "overlap" | "after";
      let phase: Phase = "before";
      let stop = false;
      /** Every attempt that was not served, as `<phase> <listener> <outcome>`. */
      const unserved: string[] = [];
      const listeners = ["provider", "connect", "direct"] as const;
      const perListener = (): Record<(typeof listeners)[number], number> => ({ provider: 0, connect: 0, direct: 0 });
      const attempts: Record<Phase, Record<(typeof listeners)[number], number>> = { before: perListener(), overlap: perListener(), after: perListener() };
      const served: Record<Phase, Record<(typeof listeners)[number], number>> = { before: perListener(), overlap: perListener(), after: perListener() };
      const loops = listeners.map(async (listener) => {
        while (!stop) {
          const at = phase;
          const outcome = await attempt(listener, ports[listener], ca);
          attempts[at][listener] += 1;
          if (outcome === "served") {
            served[at][listener] += 1;
          } else {
            unserved.push(`${at} ${listener} ${outcome}`);
          }
        }
      });
      const everyListenerTried = (at: Phase): boolean => Object.values(attempts[at]).every((count) => count >= ATTEMPTS_PER_PHASE);

      await until(() => everyListenerTried("before"), EVENT_TIMEOUT_MS, "traffic before the swap");
      phase = "overlap";
      process.kill(doorPid, "SIGUSR2");
      const successorPid = await until(() => {
        const owner = readState()?.supervisorPid;
        return owner !== undefined && owner !== doorPid ? owner : undefined;
      }, STARTUP_TIMEOUT_MS, "the successor to record itself as the owner");
      cleanups.push(() => {
        if (isAlive(successorPid)) {
          process.kill(successorPid, "SIGKILL");
        }
      });
      // The old door marks itself draining once it has stopped accepting: from then on only the successor can be serving the sticky addresses.
      await until(() => listDrainingFrontDoors(realFarmFs, layout.frontdoorDrainingDir, isAlive).includes(doorPid), EVENT_TIMEOUT_MS, "the old door to start draining");
      phase = "after";
      await until(() => everyListenerTried("after"), EVENT_TIMEOUT_MS + HANG_GUARD_MS, "traffic after the old door stopped accepting");
      stop = true;
      await Promise.all(loops);

      expect(unserved).toEqual([]);
      // Every attempt was served, after the old door stopped accepting as much as before, so the successor is what answered them.
      expect(served).toEqual(attempts);
      // The successor serves on the very same addresses.
      expect(readState()).toMatchObject({ supervisorPid: successorPid, port: ports.provider, connectPort: ports.connect, directPort: ports.direct });
      // And under the same control token, so a control request made with the file's value is admitted by either door while both accept.
      expect(fs.readFileSync(layout.frontdoorControlTokenFile, "utf8")).toBe(controlToken);

      // The connection opened before the swap is still carried by the old door, which stays up for it and exits once it ends.
      expect(isAlive(doorPid)).toBe(true);
      await echoes("after");
      const exited = new Promise<number | null>((resolve) => {
        door.once("exit", (code) => {
          resolve(code);
        });
      });
      tunnel.destroy();
      expect(await exited).toBe(0);
      expect(isAlive(successorPid)).toBe(true);
    },
    SUITE_TIMEOUT_MS,
  );
});

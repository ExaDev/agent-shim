import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";

import { HTTP_STATUS } from "./http";
import type { CallbackListener } from "./siwcLogin";
import { SIWC_CALLBACK_PATH, type SiwcPorts } from "./siwc";
import type { UpstreamFetch } from "./upstreamPort";

/** The real primitives the Sign in with ChatGPT flow draws on: the process's own fetch, the operating system's random source and the wall clock. */
export function realSiwcPorts(fetch: UpstreamFetch): SiwcPorts {
  return { fetch, randomBytes: (size) => randomBytes(size), now: () => new Date() };
}

/** What the person's browser shows once the redirect has landed. */
const CALLBACK_PAGE = "<!doctype html><meta charset=utf-8><title>Signed in</title><p>You can close this tab and return to the terminal.</p>";

/**
 * Listens on a loopback port for the browser's redirect and resolves with its URL. Bound to 127.0.0.1 only, so nothing else on the network can deliver a callback, and it answers only the callback path carrying this sign-in's state.
 */
export async function listenForCallback(port: number, state: string): Promise<CallbackListener> {
  let deliver: ((url: URL) => void) | undefined;
  const arrived = new Promise<URL>((resolve) => {
    deliver = resolve;
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
    // A request that is not this sign-in's callback (a stale tab's older state, a favicon fetch) is refused and leaves the sign-in waiting.
    if (request.method !== "GET" || url.pathname !== SIWC_CALLBACK_PATH || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) {
      response.writeHead(HTTP_STATUS.notFound).end("Not found");
      return;
    }
    response.writeHead(HTTP_STATUS.ok, { "Content-Type": "text/html; charset=utf-8" });
    response.end(CALLBACK_PAGE);
    deliver?.(url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error(`port ${String(port)} is in use (another sign-in, such as \`codex login\`, may be running): finish or stop it and try again`) : error);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  return {
    waitForCallback: async (signal) =>
      await Promise.race([
        arrived,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("timed out waiting for the browser sign-in to finish"));
          });
        }),
      ]),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Opens the system browser at `url`, detached so the sign-in command's own exit never waits on it. */
export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? { file: "open", args: [url] } : process.platform === "win32" ? { file: "cmd", args: ["/c", "start", "", url] } : { file: "xdg-open", args: [url] };
  spawn(command.file, command.args, { detached: true, stdio: "ignore" }).unref();
}

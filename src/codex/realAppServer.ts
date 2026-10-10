import { spawn } from "node:child_process";
import readline from "node:readline";

import { CodexAppServerUnavailableError, type CodexAppServerConnection, type CodexAppServerPort } from "./appServer";

/**
 * How long a server gets to exit after its input is closed before it is stopped. A server whose input ended has nothing left to do, so this bounds a wedged shutdown rather than describing a normal one.
 */
const SHUTDOWN_GRACE_MS = 5_000;

/** The real app-server port: `codex app-server` as a child process speaking one JSON message per line on standard input and output, with `CODEX_HOME` set for it alone. */
export const realCodexAppServerPort: CodexAppServerPort = {
  open: async ({ bin, codexHome }) => {
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEX_HOME: codexHome } });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        reject(new CodexAppServerUnavailableError(`${bin} could not be started (${error.message})`));
      });
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    const pending: unknown[] = [];
    const waiting: ((message: unknown) => void)[] = [];
    let ended = false;
    const deliver = (message: unknown): void => {
      const waiter = waiting.shift();
      if (waiter === undefined) {
        pending.push(message);
      } else {
        waiter(message);
      }
    };
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        deliver(JSON.parse(line));
      } catch {
        // A line that is not JSON is the server's own log output, never a protocol message.
      }
    });
    lines.on("close", () => {
      ended = true;
      for (const waiter of waiting.splice(0)) {
        waiter(undefined);
      }
    });
    const connection: CodexAppServerConnection = {
      send: (message) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      receive: async () => {
        if (pending.length > 0) {
          return pending.shift();
        }
        if (ended) {
          return undefined;
        }
        return await new Promise<unknown>((resolve) => {
          waiting.push(resolve);
        });
      },
      close: async () => {
        child.stdin.end();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, SHUTDOWN_GRACE_MS);
        await exited;
        clearTimeout(timer);
        lines.close();
      },
    };
    return connection;
  },
};

import type { z } from "zod";

import { CliError } from "../cliError";
import packageJson from "../../package.json";
import {
  CODEX_APP_SERVER_GENERATED_AGAINST,
  CodexAccountReadSchema,
  CodexInitializeResultSchema,
  CodexRateLimitsReadSchema,
  type CodexAccountRead,
  type CodexRateLimitsRead,
} from "./appServerSchemas";

/**
 * A reader for what Codex itself knows about a login: the account behind a Codex home and its rate limits, asked of `codex app-server` over stdio so no consumer opens `auth.json` or depends on a private file format. Each read starts a short-lived app-server under the given home, asks one question and ends it. It never starts a login and never sends a prompt.
 */

/** Raised when the Codex binary cannot be started (not installed, not executable) or ends before it answers. */
export class CodexAppServerUnavailableError extends CliError {
  constructor(detail: string) {
    super(`The Codex app-server is not available: ${detail}.`);
    this.name = "CodexAppServerUnavailableError";
  }
}

/** Raised when the app-server answers a request with a JSON-RPC error; `rpcCode` and the message are the server's own, so a signed-out home reads as the server's "authentication required". */
export class CodexAppServerRequestError extends CliError {
  constructor(
    readonly method: string,
    readonly rpcCode: number,
    detail: string,
  ) {
    super(`Codex app-server ${method} failed (${String(rpcCode)}): ${detail}`);
    this.name = "CodexAppServerRequestError";
  }
}

/** Raised when an answer does not have the shape this reader was written against, naming the installed Codex version and the one the shapes were generated against. */
export class CodexAppServerProtocolError extends CliError {
  constructor(
    readonly method: string,
    readonly installedVersion: string | undefined,
    detail: string,
  ) {
    super(
      `Codex app-server ${method} answered in a shape this reader does not know (installed Codex ${installedVersion ?? "of unknown version"}, shapes generated against ${CODEX_APP_SERVER_GENERATED_AGAINST}): ${detail}`,
    );
    this.name = "CodexAppServerProtocolError";
  }
}

/** One open conversation with an app-server process. */
export interface CodexAppServerConnection {
  /** Writes one JSON-RPC message. */
  readonly send: (message: unknown) => void;
  /** The next message the server wrote, or undefined once it has ended. */
  readonly receive: () => Promise<unknown>;
  /** Ends the conversation: closes the server's input, waits for it to exit and stops it if it does not. Safe to call twice. */
  readonly close: () => Promise<void>;
}

/** Starts app-server processes. Injected so the reader runs against a scripted server in tests and against the real `codex` binary in use. */
export interface CodexAppServerPort {
  /** Starts `bin app-server` with `CODEX_HOME` set to `codexHome`. Rejects with `CodexAppServerUnavailableError` when it cannot start. */
  readonly open: (options: Readonly<{ bin: string; codexHome: string }>) => Promise<CodexAppServerConnection>;
}

/** What a read needs from its caller. */
export interface CodexAppServerReadOptions {
  /** The Codex home to read: the directory `codex` keeps its login in, `~/.codex` unless `CODEX_HOME` says otherwise. */
  readonly codexHome: string;
  /** The Codex executable; `codex` on `PATH` when absent. */
  readonly bin?: string;
  /** Stops the read: the server is ended and the read rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** How long the read may take, `CODEX_APP_SERVER_TIMEOUT_MS` when absent. A read that exceeds it rejects with `CodexAppServerUnavailableError`. */
  readonly timeoutMs?: number;
}

/**
 * How long a read may take before it is abandoned. An app-server start plus one backend call for the usage windows is network bound; this bounds a hung server rather than describing a normal read.
 */
export const CODEX_APP_SERVER_TIMEOUT_MS = 30_000;

/** The `clientInfo` an app-server is told, so its own logs and user agent name this reader. */
const CLIENT_NAME = "agent-shim";

/** The version a user agent such as `agent-shim/0.160.0 (Mac OS ...)` carries after the client name. */
function installedVersionOf(userAgent: string): string | undefined {
  return /^[^/\s]+\/(\S+)/.exec(userAgent)?.[1];
}

/** A JSON-RPC response message, narrowed from an unknown value read off the wire. */
function responseTo(message: unknown, id: number): { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } } | undefined {
  if (typeof message !== "object" || message === null || !("id" in message) || message.id !== id) {
    return undefined;
  }
  if ("error" in message && typeof message.error === "object" && message.error !== null) {
    const { error } = message;
    const code = "code" in error && typeof error.code === "number" ? error.code : 0;
    const detail = "message" in error && typeof error.message === "string" ? error.message : "no message";
    return { error: { code, message: detail } };
  }
  return "result" in message ? { result: message.result } : undefined;
}

/** Opens a connection, completes the handshake and runs `ask` over it, always ending the server afterwards. */
async function withAppServer<Result>(
  port: CodexAppServerPort,
  options: Readonly<CodexAppServerReadOptions>,
  ask: (request: (method: string, params: unknown) => Promise<unknown>, installedVersion: string | undefined) => Promise<Result>,
): Promise<Result> {
  const connection = await port.open({ bin: options.bin ?? "codex", codexHome: options.codexHome });
  let nextId = 0;
  // The caller's signal and the read's own time limit, as one. A signal that is already aborted raises no event, so it is read here rather than listened for.
  const timeoutMs = options.timeoutMs ?? CODEX_APP_SERVER_TIMEOUT_MS;
  const stopper = AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(timeoutMs)]);
  const stopReason = (): Error => {
    if (options.signal?.aborted !== true) {
      return new CodexAppServerUnavailableError(`it did not answer within ${String(timeoutMs)} ms`);
    }
    const reason: unknown = options.signal.reason;
    return reason instanceof Error ? reason : new Error(`the Codex app-server read was aborted: ${String(reason)}`);
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    if (stopper.aborted) {
      reject(stopReason());
      return;
    }
    stopper.addEventListener(
      "abort",
      () => {
        reject(stopReason());
      },
      { once: true },
    );
  });
  // The race rejection is observed by the race itself; a read that finishes first leaves it unobserved, so it is marked handled.
  aborted.catch(() => undefined);
  const request = async (method: string, params: unknown): Promise<unknown> => {
    nextId += 1;
    const id = nextId;
    connection.send({ jsonrpc: "2.0", id, method, params });
    for (;;) {
      // Notifications and server requests arrive interleaved with answers; only the response to this id is read.
      const message = await Promise.race([connection.receive(), aborted]);
      if (message === undefined) {
        throw new CodexAppServerUnavailableError(`it ended before answering ${method}`);
      }
      const response = responseTo(message, id);
      if (response === undefined) {
        continue;
      }
      if ("error" in response) {
        throw new CodexAppServerRequestError(method, response.error.code, response.error.message);
      }
      return response.result;
    }
  };
  try {
    const initialised = CodexInitializeResultSchema.safeParse(await request("initialize", { clientInfo: { name: CLIENT_NAME, title: null, version: packageJson.version } }));
    if (!initialised.success) {
      throw new CodexAppServerProtocolError("initialize", undefined, initialised.error.message);
    }
    connection.send({ jsonrpc: "2.0", method: "initialized" });
    return await ask(request, installedVersionOf(initialised.data.userAgent));
  } finally {
    await connection.close();
  }
}

/** Validates one answer against its schema, reporting a mismatch as a protocol error naming the installed version. */
function validated<Output>(method: string, installedVersion: string | undefined, schema: z.ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CodexAppServerProtocolError(method, installedVersion, parsed.error.message);
  }
  return parsed.data;
}

/**
 * Reads the account behind a Codex home through `account/read`: its type, and for a ChatGPT sign-in the email and plan. The token is never part of the answer. A home with no login answers `account: null`.
 */
export async function readCodexAccount(port: CodexAppServerPort, options: Readonly<CodexAppServerReadOptions>): Promise<CodexAccountRead> {
  return await withAppServer(port, options, async (request, version) => validated("account/read", version, CodexAccountReadSchema, await request("account/read", { refreshToken: false })));
}

/**
 * Reads a Codex home's rate limits through `account/rateLimits/read`: the windows by their length and the banked reset credits. A home with no login is refused by the server, reported as `CodexAppServerRequestError`.
 */
export async function readCodexRateLimits(port: CodexAppServerPort, options: Readonly<CodexAppServerReadOptions>): Promise<CodexRateLimitsRead> {
  return await withAppServer(port, options, async (request, version) => validated("account/rateLimits/read", version, CodexRateLimitsReadSchema, await request("account/rateLimits/read", undefined)));
}

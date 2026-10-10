import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerProtocolError,
  CodexAppServerRequestError,
  CodexAppServerUnavailableError,
  readCodexAccount,
  readCodexRateLimits,
  type CodexAppServerConnection,
  type CodexAppServerPort,
} from "./appServer";
import { CODEX_APP_SERVER_GENERATED_AGAINST } from "./appServerSchemas";

const FIVE_HOUR_WINDOW_MINS = 300;
const WEEK_WINDOW_MINS = 10_080;
const USER_AGENT = "agent-shim/0.160.0 (Mac OS 27.0.0; arm64)";
const INITIALIZE_ANSWER = { userAgent: USER_AGENT, codexHome: "/home/codex", platformFamily: "unix", platformOs: "macos" };

type Reply = (request: { readonly id: number; readonly method: string; readonly params: unknown }) => readonly unknown[];

/** A scripted server: each request the reader sends is answered by `reply`, whose messages (notifications included) are queued in order, and the open connection records what it was sent and whether it was closed. */
function scriptedPort(reply: Reply) {
  const sent: unknown[] = [];
  const queue: unknown[] = [];
  const close = vi.fn(async () => {
    await Promise.resolve();
  });
  const connection: CodexAppServerConnection = {
    send: (message) => {
      sent.push(message);
      if (typeof message === "object" && message !== null && "id" in message && "method" in message && typeof message.id === "number" && typeof message.method === "string") {
        queue.push(...reply({ id: message.id, method: message.method, params: "params" in message ? message.params : undefined }));
      }
    },
    receive: async () => await Promise.resolve(queue.shift()),
    close,
  };
  const open = vi.fn<CodexAppServerPort["open"]>(async () => await Promise.resolve(connection));
  const port: CodexAppServerPort = { open };
  return { port, sent, close, open };
}

/** A server that answers the handshake, and then each method from `answers`, with a notification ahead of every answer as a real server emits them. */
function serverAnswering(answers: Readonly<Record<string, unknown>>): Reply {
  return ({ id, method }) => {
    const notification = { method: "remoteControl/status/changed", params: { status: "disabled" } };
    if (method === "initialize") {
      return [notification, { id, result: INITIALIZE_ANSWER }];
    }
    return [notification, { id, result: answers[method] }];
  };
}

describe("readCodexAccount", () => {
  it("reads a ChatGPT account through the handshake, skipping interleaved notifications", async () => {
    const answer = { account: { type: "chatgpt", email: "me@example.com", planType: "plus" }, requiresOpenaiAuth: true };
    const { port, sent, close, open } = scriptedPort(serverAnswering({ "account/read": answer }));

    const account = await readCodexAccount(port, { codexHome: "/home/codex" });

    expect(account).toEqual(answer);
    expect(open).toHaveBeenCalledWith({ bin: "codex", codexHome: "/home/codex" });
    const methods = sent.map((message) => (typeof message === "object" && message !== null && "method" in message ? message.method : undefined));
    expect(methods).toEqual(["initialize", "initialized", "account/read"]);
    expect(sent[2]).toMatchObject({ params: { refreshToken: false } });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports a home with no login as no account", async () => {
    const { port } = scriptedPort(serverAnswering({ "account/read": { account: null, requiresOpenaiAuth: true } }));
    expect(await readCodexAccount(port, { codexHome: "/empty" })).toEqual({ account: null, requiresOpenaiAuth: true });
  });

  it("passes the executable it was given", async () => {
    const { port, open } = scriptedPort(serverAnswering({ "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: false } }));
    await readCodexAccount(port, { codexHome: "/home/codex", bin: "/opt/codex/bin/codex" });
    expect(open).toHaveBeenCalledWith({ bin: "/opt/codex/bin/codex", codexHome: "/home/codex" });
  });
});

describe("readCodexRateLimits", () => {
  it("reads the windows by length and the banked reset credits", async () => {
    const answer = {
      rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 12, resetsAt: 1_800_000_000, windowDurationMins: FIVE_HOUR_WINDOW_MINS }, secondary: { usedPercent: 40, resetsAt: 1_800_500_000, windowDurationMins: WEEK_WINDOW_MINS } },
      rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 12, resetsAt: 1_800_000_000, windowDurationMins: FIVE_HOUR_WINDOW_MINS } } },
      rateLimitResetCredits: { availableCount: 1, credits: [{ id: "credit-1", grantedAt: 1_790_000_000, resetType: "weekly", status: "available" }] },
    };
    const { port, close } = scriptedPort(serverAnswering({ "account/rateLimits/read": answer }));

    const limits = await readCodexRateLimits(port, { codexHome: "/home/codex" });

    expect(limits.rateLimits.primary?.windowDurationMins).toBe(FIVE_HOUR_WINDOW_MINS);
    expect(limits.rateLimits.secondary?.windowDurationMins).toBe(WEEK_WINDOW_MINS);
    expect(limits.rateLimitResetCredits?.availableCount).toBe(1);
    expect(limits.rateLimitResetCredits?.credits?.[0]?.id).toBe("credit-1");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports the server's refusal with its code, and still ends the server", async () => {
    const reply: Reply = ({ id, method }) =>
      method === "initialize" ? [{ id, result: INITIALIZE_ANSWER }] : [{ id, error: { code: -32_600, message: "codex account authentication required to read rate limits" } }];
    const { port, close } = scriptedPort(reply);

    const failure = await readCodexRateLimits(port, { codexHome: "/empty" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CodexAppServerRequestError);
    expect(failure).toMatchObject({ method: "account/rateLimits/read", rpcCode: -32_600 });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("a server whose answers do not match", () => {
  it("names the installed Codex version and the version the shapes were generated against", async () => {
    const { port } = scriptedPort(serverAnswering({ "account/read": { account: { type: "chatgpt", planType: 7 }, requiresOpenaiAuth: "yes" } }));

    const failure = await readCodexAccount(port, { codexHome: "/home/codex" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CodexAppServerProtocolError);
    expect(failure).toMatchObject({ method: "account/read", installedVersion: "0.160.0" });
    expect((failure as Error).message).toContain(CODEX_APP_SERVER_GENERATED_AGAINST);
  });

  it("reports a server that ends before answering as unavailable", async () => {
    const { port, close } = scriptedPort(({ id, method }) => (method === "initialize" ? [{ id, result: INITIALIZE_ANSWER }] : []));

    const failure = await readCodexAccount(port, { codexHome: "/home/codex" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CodexAppServerUnavailableError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops reading when its signal aborts, and ends the server", async () => {
    const controller = new AbortController();
    const connection: CodexAppServerConnection = {
      send: () => undefined,
      receive: async () => await new Promise<unknown>(() => undefined),
      close: vi.fn(async () => {
        await Promise.resolve();
      }),
    };
    const port: CodexAppServerPort = { open: async () => await Promise.resolve(connection) };

    const reading = readCodexAccount(port, { codexHome: "/home/codex", signal: controller.signal }).catch((error: unknown) => error);
    controller.abort(new Error("stopped by the caller"));

    expect(await reading).toMatchObject({ message: "stopped by the caller" });
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("gives up on a server that never answers, and ends it", async () => {
    const connection: CodexAppServerConnection = {
      send: () => undefined,
      receive: async () => await new Promise<unknown>(() => undefined),
      close: vi.fn(async () => {
        await Promise.resolve();
      }),
    };
    const port: CodexAppServerPort = { open: async () => await Promise.resolve(connection) };

    const failure = await readCodexAccount(port, { codexHome: "/home/codex", timeoutMs: 20 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CodexAppServerUnavailableError);
    expect((failure as Error).message).toContain("20 ms");
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fetchHeadroomSessionStats, headroomSessionIdOf, headroomTargetOf, realHeadroomGet, type HeadroomGet, type HeadroomTarget } from "./headroom";

const TOKENS_SAVED = 41_816;
const SAVINGS_PERCENT = 3.5;
const SAVINGS_USD = 0.13;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const SOCKET_TARGET: HeadroomTarget = { kind: "socket", socketPath: "/run/headroom.sock" };

function answering(status: number, text: string): HeadroomGet {
  return async () => await Promise.resolve({ status, text });
}

describe("headroomSessionIdOf", () => {
  it("prefers the payload's session id, then the launcher's session header", () => {
    expect(headroomSessionIdOf({ session_id: "abc" }, { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-session: from-header" })).toBe("abc");
    expect(headroomSessionIdOf({}, { ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-identity: zai\nx-agent-shim-session: from-header" })).toBe("from-header");
    expect(headroomSessionIdOf({ session_id: "  " }, {})).toBeUndefined();
    expect(headroomSessionIdOf(undefined, {})).toBeUndefined();
  });
});

describe("headroomTargetOf", () => {
  it("lets an explicit proxy URL win over the supervised socket, trimming trailing slashes", () => {
    expect(headroomTargetOf({ HEADROOM_PROXY_URL: "http://127.0.0.1:8787/" }, "/run/headroom.sock")).toEqual({ kind: "http", baseUrl: "http://127.0.0.1:8787" });
    expect(headroomTargetOf({}, "/run/headroom.sock")).toEqual(SOCKET_TARGET);
    expect(headroomTargetOf({}, undefined)).toBeUndefined();
  });
});

describe("fetchHeadroomSessionStats", () => {
  it("reads the session's savings from the proxy's row", async () => {
    const row = JSON.stringify({ tokens_saved: TOKENS_SAVED, savings_percent: SAVINGS_PERCENT, compression_savings_usd: SAVINGS_USD, requests: 9 });
    expect(await fetchHeadroomSessionStats(answering(HTTP_OK, row), SOCKET_TARGET, "abc")).toEqual({ tokensSaved: TOKENS_SAVED, savingsPercent: SAVINGS_PERCENT, savingsUsd: SAVINGS_USD });
  });

  it("asks for the session's own row, the id encoded", async () => {
    let asked: string | undefined;
    const spy: HeadroomGet = async (_target, requestPath) => {
      asked = requestPath;
      return await Promise.resolve({ status: HTTP_NOT_FOUND, text: "" });
    };
    await fetchHeadroomSessionStats(spy, SOCKET_TARGET, "a/b");
    expect(asked).toBe("/stats/sessions/a%2Fb");
  });

  it("answers undefined when there is nothing to show: unreachable, unknown session, not a savings row, or an empty one", async () => {
    const unreachable: HeadroomGet = async () => await Promise.reject(new Error("ECONNREFUSED"));
    expect(await fetchHeadroomSessionStats(unreachable, SOCKET_TARGET, "abc")).toBeUndefined();
    expect(await fetchHeadroomSessionStats(answering(HTTP_NOT_FOUND, "{}"), SOCKET_TARGET, "abc")).toBeUndefined();
    expect(await fetchHeadroomSessionStats(answering(HTTP_OK, "not json"), SOCKET_TARGET, "abc")).toBeUndefined();
    expect(await fetchHeadroomSessionStats(answering(HTTP_OK, JSON.stringify({ tokens_saved: "many" })), SOCKET_TARGET, "abc")).toBeUndefined();
    expect(await fetchHeadroomSessionStats(answering(HTTP_OK, "{}"), SOCKET_TARGET, "abc")).toBeUndefined();
  });
});

describe("realHeadroomGet", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("reads a session's row over a unix socket, and fails when nothing listens", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hr-"));
    const socketPath = path.join(directory, "d.sock");
    const server = http.createServer((request, response) => {
      response.writeHead(request.url === "/stats/sessions/abc" ? HTTP_OK : HTTP_NOT_FOUND, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens_saved: TOKENS_SAVED }));
    });
    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });
    cleanup = () => {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    };
    expect(await fetchHeadroomSessionStats(realHeadroomGet, { kind: "socket", socketPath }, "abc")).toEqual({ tokensSaved: TOKENS_SAVED, savingsPercent: undefined, savingsUsd: undefined });
    expect(await fetchHeadroomSessionStats(realHeadroomGet, { kind: "socket", socketPath }, "other")).toBeUndefined();
    expect(await fetchHeadroomSessionStats(realHeadroomGet, { kind: "socket", socketPath: path.join(directory, "absent.sock") }, "abc")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { COMPACT_TIMEOUT_MS } from "../supervise/compactTimeout";
import { RC_ORPC_PATH_PREFIX, headersTimeoutOf } from "./rcApi";
import { RC_SESSION_COMMAND_MAX_WAIT_MS } from "./rcSessionCommands";

/** undici's default wait for response headers, the bound every ordinary procedure keeps. */
const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 300_000;

const URL_BASE = `https://127.0.0.1:4100${RC_ORPC_PATH_PREFIX}`;

function rpcBody(input: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ json: input }));
}

describe("how long the typed API's client waits for response headers", () => {
  it("keeps undici's default for every procedure that does not wait on a session, so a hung door still fails a list", () => {
    expect(headersTimeoutOf(`${URL_BASE}/rc/list`, undefined)).toBe(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
    expect(headersTimeoutOf(`${URL_BASE}/rc/send`, rpcBody({ session: "cse_x", text: "hi", waitMs: 1 }))).toBe(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
  });

  it("gives a goal or compaction verb its own wait plus that default, its default wait when it names none, capped at the timer limit", () => {
    const waitMs = 30_000;
    expect(headersTimeoutOf(`${URL_BASE}/rc/goalSet`, rpcBody({ session: "cse_x", condition: "x", waitMs }))).toBe(waitMs + UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
    expect(headersTimeoutOf(`${URL_BASE}/rc/compact`, rpcBody({ session: "cse_x" }))).toBe(COMPACT_TIMEOUT_MS + UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
    expect(headersTimeoutOf(`${URL_BASE}/rc/turn`, rpcBody({ session: "cse_x", text: "carry on", waitMs }))).toBe(waitMs + UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
    expect(headersTimeoutOf(`${URL_BASE}/rc/compactWithInstructions`, rpcBody({ session: "cse_x", instructions: "x", waitMs: RC_SESSION_COMMAND_MAX_WAIT_MS }))).toBe(RC_SESSION_COMMAND_MAX_WAIT_MS);
  });
});

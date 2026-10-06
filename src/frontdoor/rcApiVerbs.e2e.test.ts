import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateCa, LOOPBACK_LEAF_NAMES, mintLeaf, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS } from "./connectTestWorld";
import { createRcApiNodeHandler, frontDoorRcApiClient } from "./rcApi";
import { createRcEventFanout } from "./rcStream";
import type { RcEventWriteResult } from "./rcWrites";
import { createFrontDoorServer, listenFrontDoor } from "./server";

/**
 * The end-to-end proof of the wider control-verb family on the typed API: the door's real server builder serving the Remote Control router as its one pre-pipeline surface, over TLS signed by a freshly generated CA, reached by the CLI's own TLS-pinned client. The write operations are recording stand-ins (the operations' own behaviour over a real dial is the self-host e2e's subject); what this file proves is the mount's part: the token middleware, the procedure-to-operation wiring, and the output contract naming the minted request id, all across real transport and in both directions of validation. The input enums' narrowing is asserted at the schema source in `rcWrites.test.ts` (the typed client refuses an out-of-enum input at compile time, which is the narrowing working).
 */

/** The token the mounted door accepts, standing in for the per-generation value the real door writes owner-only. */
const CONTROL_TOKEN = "e2e-control-token";
/** The session id the recording operations echo, of the protocol's own shape. */
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000001";
/** The request id every recording write answers with, so a procedure's output naming it proves the id crossed the mount. */
const MINTED_REQUEST_ID = "minted-00000000-0000-4000-8000-000000000002";
/** The sequence numbers the recording writes answer with, named so the literal never reads as a magic number. */
const ANSWERED_SEQUENCE_NUM = 411;
const SEQUENCE_NUMS = [ANSWERED_SEQUENCE_NUM];

describe("the wider control-verb family on the door's typed API, end to end over its own TLS", () => {
  let ca: CaMaterial;
  let port: number;
  let close: (() => Promise<void>) | undefined;
  /** Every operation call the mount carried out, so the assertions read exactly what each procedure handed its dependency. */
  const calls: { readonly op: string; readonly args: readonly unknown[] }[] = [];
  /** A recording stand-in for one operation: notes what it was handed and answers with the fixed delivered write. */
  const note = async (op: string, args: readonly unknown[]): Promise<RcEventWriteResult> => {
    calls.push({ op, args });
    return await Promise.resolve({ ok: true, sequenceNums: [...SEQUENCE_NUMS], requestId: MINTED_REQUEST_ID });
  };

  beforeAll(async () => {
    ca = generateCa(new Date());
    const doorApi = createRcApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: () => [],
      statusOf: () => [],
      pendingOf: () => [],
      inject: async (session, text) => note("inject", [session, text]),
      answer: async (session, request, decision) => note("answer", [session, request, decision]),
      interrupt: async (session) => note("interrupt", [session]),
      setModel: async (session, model) => note("setModel", [session, model]),
      setPermissionMode: async (session, mode) => note("setPermissionMode", [session, mode]),
      endSession: async (session, reason) => note("endSession", [session, reason]),
      getUsage: async (session, skipBehaviors) => note("getUsage", [session, skipBehaviors]),
      getContextUsage: async (session, detail) => note("getContextUsage", [session, detail]),
      readFile: async (session, path, options) => note("readFile", [session, path, options]),
      fileSuggestions: async (session, query) => note("fileSuggestions", [session, query]),
      keepAlive: async (session) => note("keepAlive", [session]),
      mcpStatus: async (session) => note("mcpStatus", [session]),
      mcpReconnect: async (session, serverName) => note("mcpReconnect", [session, serverName]),
      mcpAuthenticate: async (session, serverName, redirectUri) => note("mcpAuthenticate", [session, serverName, redirectUri]),
      mcpOAuthCallbackUrl: async (session, serverName, callbackUrl) => note("mcpOAuthCallbackUrl", [session, serverName, callbackUrl]),
      teleport: async (session, marker) => note("teleport", [session, marker]),
      fanout: createRcEventFanout(),
    });
    const server = createFrontDoorServer(
      async () => {
        await Promise.resolve();
      },
      () => undefined,
      mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
      undefined,
      [doorApi],
    );
    const handle = await listenFrontDoor(server, { ca: ca.certPem });
    port = handle.port;
    close = handle.close;
  }, KEYGEN_TIMEOUT_MS);

  afterAll(async () => {
    await close?.();
  });

  it("serves one verb per family through the real mount, each answer naming the minted request id beside the sequence numbers", async () => {
    const api = frontDoorRcApiClient(port, ca.certPem, CONTROL_TOKEN);
    // The simple session-bound verbs: end-session carries its optional reason, keep-alive is the one payload with no request envelope and so no request id in its answer.
    expect(await api.rc.endSession({ session: SESSION_ID, reason: "done for today" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.keepAlive({ session: SESSION_ID })).toEqual({ session: SESSION_ID, sequenceNums: SEQUENCE_NUMS });
    // The query verbs: usage, context usage with the SDK's own detail level, and the file read with its byte cap and encoding.
    expect(await api.rc.getUsage({ session: SESSION_ID, skipBehaviors: true })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.getContextUsage({ session: SESSION_ID, detail: "summary" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.readFile({ session: SESSION_ID, path: "src/index.ts", maxBytes: 4096, encoding: "base64" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.fileSuggestions({ session: SESSION_ID, query: "src/front" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    // The teleport write: the one verb with no request envelope, so its answer names no request id.
    expect(await api.rc.teleport({ session: SESSION_ID, marker: "__ULTRAPAN_TELEPORT_LOCAL__" })).toEqual({ session: SESSION_ID, sequenceNums: SEQUENCE_NUMS });
    // The mcp_* family.
    expect(await api.rc.mcpStatus({ session: SESSION_ID })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.mcpReconnect({ session: SESSION_ID, serverName: "github" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.mcpAuthenticate({ session: SESSION_ID, serverName: "github", redirectUri: "https://example.com/cb" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(await api.rc.mcpOAuthCallbackUrl({ session: SESSION_ID, serverName: "github", callbackUrl: "https://example.com/cb?code=x" })).toEqual({ session: SESSION_ID, request: MINTED_REQUEST_ID, sequenceNums: SEQUENCE_NUMS });
    expect(calls).toEqual([
      { op: "endSession", args: [SESSION_ID, "done for today"] },
      { op: "keepAlive", args: [SESSION_ID] },
      { op: "getUsage", args: [SESSION_ID, true] },
      { op: "getContextUsage", args: [SESSION_ID, "summary"] },
      { op: "readFile", args: [SESSION_ID, "src/index.ts", { maxBytes: 4096, encoding: "base64" }] },
      { op: "fileSuggestions", args: [SESSION_ID, "src/front"] },
      { op: "teleport", args: [SESSION_ID, "__ULTRAPAN_TELEPORT_LOCAL__"] },
      { op: "mcpStatus", args: [SESSION_ID] },
      { op: "mcpReconnect", args: [SESSION_ID, "github"] },
      { op: "mcpAuthenticate", args: [SESSION_ID, "github", "https://example.com/cb"] },
      { op: "mcpOAuthCallbackUrl", args: [SESSION_ID, "github", "https://example.com/cb?code=x"] },
    ]);
  });

  it("refuses a caller without this generation's control token before any operation runs", async () => {
    // The same token middleware the whole mount shares refuses a caller without it, and no operation is carried out: the recording log holds exactly what it held before.
    const callsBefore = calls.length;
    const wrongToken = frontDoorRcApiClient(port, ca.certPem, "not-the-control-token");
    await expect(wrongToken.rc.mcpStatus({ session: SESSION_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(wrongToken.rc.endSession({ session: SESSION_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(calls.length).toBe(callsBefore);
  });

  it("carries an undelivered write as the operation's verbose message, the same refusal the bespoke routes answer 502 with", async () => {
    const surface = createRcApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: () => [],
      statusOf: () => [],
      pendingOf: () => [],
      inject: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      answer: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      interrupt: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      setModel: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      setPermissionMode: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      endSession: async () => await Promise.resolve({ ok: false, message: "the front door has not observed Remote Control session cse_missing" }),
      getUsage: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      getContextUsage: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      readFile: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      fileSuggestions: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      keepAlive: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      mcpStatus: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      mcpReconnect: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      mcpAuthenticate: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      mcpOAuthCallbackUrl: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      teleport: async () => await Promise.resolve({ ok: false, message: "unexercised" }),
      fanout: createRcEventFanout(),
    });
    const server = createFrontDoorServer(
      async () => {
        await Promise.resolve();
      },
      () => undefined,
      mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
      undefined,
      [surface],
    );
    const handle = await listenFrontDoor(server, { ca: ca.certPem });
    try {
      const api = frontDoorRcApiClient(handle.port, ca.certPem, CONTROL_TOKEN);
      await expect(api.rc.endSession({ session: "cse_missing" })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "the front door has not observed Remote Control session cse_missing" });
    } finally {
      await handle.close();
    }
  });
});

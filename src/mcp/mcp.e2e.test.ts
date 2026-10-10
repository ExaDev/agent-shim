import * as http from "node:http";

import { RPCLink } from "@orpc/client/fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CheckReport } from "../checkReport";
import { HTTP_STATUS } from "../codex/http";
import type { DoctorReport } from "../doctorReport";
import { createDoorApiNodeHandler } from "../frontdoor/controlApi";
import { LIFECYCLE_AND_CODEX_TEST_DEPS } from "../frontdoor/lifecycleCodexTestDeps";
import { createDoorEventHub, rcFanoutOnDoorHub } from "../frontdoor/eventHub";
import { RC_ORPC_PATH_PREFIX } from "../frontdoor/rcApi";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS } from "../frontdoor/rcSessions";
import { createRcEventFanout } from "../frontdoor/rcStream";
import type { FrontDoorStatus } from "../frontdoor/status";
import { createMcpServer, serveMcp, type McpServerPorts } from "./server";
import { toolsFromOpenApiDocument, type McpWritePermissions } from "./tools";

const CONTROL_TOKEN = "unit-mcp-token";
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000002";
/** The sequence number the stand-in write answers with, one named value both the fake and its assertion read. */
const WRITE_SEQUENCE_NUM = 7;
const WRITE_SEQUENCE_NUMS = [WRITE_SEQUENCE_NUM] as const;

const FRONTDOOR_STATUS: FrontDoorStatus = {
  state: { supervisorPid: 10, port: 4100, lastPort: 4100 },
  supervisorAlive: true,
  sessions: [],
  headroomSocket: undefined,
  logPath: "/home/testuser/.agent-shim/logs/frontdoor.log",
  logExists: false,
};

/** Reads the call's text content as the JSON the server serialised. */
function textOf(result: Readonly<Record<string, unknown>>): string {
  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error("the tool result carried no content array");
  }
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") {
    throw new Error("the tool result's first content item is not text");
  }
  return first.text;
}

describe("the MCP server over a real door handler", () => {
  let origin: string;
  let close: () => Promise<void>;
  const injected: string[] = [];

  beforeAll(async () => {
    const events = createDoorEventHub();
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
    const surface = createDoorApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: tracker.list,
      statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
      pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
      inject: async (_session: string, text: string) => {
        injected.push(text);
        return await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS });
      },
      answer: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      interrupt: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      setModel: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      setPermissionMode: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      endSession: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      getUsage: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      getContextUsage: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      readFile: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      fileSuggestions: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      keepAlive: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS }),
      mcpStatus: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      mcpReconnect: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      mcpAuthenticate: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      mcpOAuthCallbackUrl: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" }),
      teleport: async () => await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS }),
      fanout: rcFanoutOnDoorHub(createRcEventFanout(), events),
      usageSnapshots: () => [],
      usageSnapshotOf: () => undefined,
      liveRateLimits: () => [],
      latestRateLimit: () => undefined,
      now: () => 0,
      frontDoorStatus: () => FRONTDOOR_STATUS,
      checkReport: (): CheckReport => {
        throw new Error("no MCP test drives check.run");
      },
      doctorReport: (): DoctorReport => {
        throw new Error("no MCP test drives doctor.run");
      },
      poolPick: (): never => {
        throw new Error("no MCP test drives pool.pick");
      },
      poolNames: () => [],
      ...LIFECYCLE_AND_CODEX_TEST_DEPS,
      resolveLaunch: (): never => {
        throw new Error("no MCP test drives launch.resolve");
      },
      events,
    });
    const server = http.createServer((request, response) => {
      surface.handle(request, response).then(
        (result) => {
          if (!result.matched) {
            response.statusCode = HTTP_STATUS.notFound;
            response.end("no match");
          }
        },
        (error: unknown) => {
          console.error(error);
        },
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP server");
    }
    origin = `http://127.0.0.1:${String(address.port)}`;
    close = async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    };
    // Seeds one observed session the way the door's own adapters do, so the Remote Control writes have a session to name.
    const observed = tracker.observeExchange({ method: "POST", url: "/v1/code/sessions", headers: { authorization: "Bearer sk-ant-oat2" } });
    observed?.onResponse(HTTP_STATUS.ok, {});
    observed?.onBodyChunk(Buffer.from(JSON.stringify({ session: { id: SESSION_ID } }), "utf8"));
    observed?.onEnd();
  });

  afterAll(async () => {
    await close();
  });

  /** The server's ports over plain HTTP to the stand-in door, the same shape `doorMcpPorts` has over the pinned TLS link. */
  function portsFor(permissions: McpWritePermissions): McpServerPorts {
    const link = new RPCLink({ origin, url: RC_ORPC_PATH_PREFIX, headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    return {
      listTools: async () => {
        const answered = await fetch(`${origin}${RC_ORPC_PATH_PREFIX}/openapi.json`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
        return toolsFromOpenApiDocument(await answered.json(), permissions);
      },
      callProcedure: async (procedure, input) => await link.call([...procedure], input, { context: {} }),
    };
  }

  async function connect(permissions: McpWritePermissions): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void serveMcp(createMcpServer({ name: "agent-shim", version: "0.0.0-test" }, portsFor(permissions)), serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("lists the door's reads as tools and answers a call from the door's own output", async () => {
    const client = await connect({ writes: false, remoteControl: false });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("frontdoor_status");
    expect(names).toContain("usage_effectiveWindow");
    expect(names).not.toContain("rc_send");
    const status = await client.callTool({ name: "frontdoor_status", arguments: {} });
    expect(JSON.parse(textOf(status))).toMatchObject({ supervisorAlive: true, state: { port: 4100 } });
    await client.close();
  });

  it("returns a refusal as an error result naming its code, not as a protocol failure", async () => {
    const client = await connect({ writes: false, remoteControl: false });
    const refused = await client.callTool({ name: "usage_effectiveWindow", arguments: { identity: "nobody" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("NOT_FOUND");
    await client.close();
  });

  it("exposes a Remote Control write only when its opt-in is given, and the call reaches the door's operation", async () => {
    const withoutOptIn = await connect({ writes: true, remoteControl: false });
    expect((await withoutOptIn.listTools()).tools.map((tool) => tool.name)).not.toContain("rc_send");
    await withoutOptIn.close();
    const client = await connect({ writes: false, remoteControl: true });
    const sent = await client.callTool({ name: "rc_send", arguments: { session: SESSION_ID, text: "hello" } });
    expect(sent.isError).not.toBe(true);
    expect(JSON.parse(textOf(sent))).toMatchObject({ session: SESSION_ID, sequenceNums: WRITE_SEQUENCE_NUMS });
    expect(injected).toEqual(["hello"]);
    await client.close();
  });

  it("refuses an unknown tool as an error result", async () => {
    const client = await connect({ writes: false, remoteControl: false });
    const missing = await client.callTool({ name: "nothing_here", arguments: {} });
    expect(missing.isError).toBe(true);
    await client.close();
  });
});

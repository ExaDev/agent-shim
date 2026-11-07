import * as http from "node:http";

import { RPCLink } from "@orpc/client/fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CheckReport } from "../checkReport";
import { HTTP_STATUS } from "../codex/http";
import type { DoctorReport } from "../doctorReport";
import { createDoorApiNodeHandler } from "../frontdoor/controlApi";
import { LIFECYCLE_AND_CODEX_TEST_DEPS } from "../frontdoor/lifecycleCodexTestDeps";
import { buildLayoutPaths } from "../paths";
import { createDoorEventHub, rcFanoutOnDoorHub } from "../frontdoor/eventHub";
import { RC_ORPC_PATH_PREFIX } from "../frontdoor/rcApi";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS } from "../frontdoor/rcSessions";
import { RC_SESSION_EVENT_LOG_CAPACITY, createRcSessionEventLog } from "../frontdoor/rcEventLog";
import { createRcEventFanout } from "../frontdoor/rcStream";
import type { RcAnswerDecision } from "../frontdoor/rcWrites";
import type { FrontDoorStatus } from "../frontdoor/status";
import { createMcpServer, serveMcp, type McpServerPorts } from "./server";
import { toolsFromOpenApiDocument, type McpPermissions } from "./tools";

const CONTROL_TOKEN = "unit-mcp-token";
const SESSION_ID = "cse_00000000-0000-4000-8000-000000000002";
/** The sequence number the stand-in write answers with, one named value both the fake and its assertion read. */
const WRITE_SEQUENCE_NUM = 7;
const WRITE_SEQUENCE_NUMS = [WRITE_SEQUENCE_NUM] as const;

const FRONTDOOR_STATUS: FrontDoorStatus = {
  state: { supervisorPid: 10, port: 4100, lastPort: 4100 },
  supervisorAlive: true,
  draining: [],
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
  /** The decisions the answer operation received, so the MCP case proves a question's choices arrive whole. */
  const answerDecisions: RcAnswerDecision[] = [];
  /** The session event log the door's page read serves, appended to directly by the test that reads it through the tool. */
  const sessionEvents = createRcSessionEventLog({ generation: "00000000-0000-4000-8000-0000000000ee", capacity: RC_SESSION_EVENT_LOG_CAPACITY });

  /** The door's session tracker, which the pending-question case files a request into. */
  const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });

  beforeAll(async () => {
    const events = createDoorEventHub();
    const surface = createDoorApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: tracker.list,
      statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
      pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
      inject: async (_session: string, text: string) => {
        injected.push(text);
        return await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS });
      },
      answer: async (_session: string, _request: string, decision: RcAnswerDecision) => {
        answerDecisions.push(decision);
        return await Promise.resolve({ ok: true, sequenceNums: WRITE_SEQUENCE_NUMS, requestId: "req_1" });
      },
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
      goalGet: async () => await Promise.resolve({ ok: true as const, report: { route: "supervised" as const, goal: null } }),
      goalSet: async (_session: string, condition: string) => await Promise.resolve({ ok: true as const, report: { route: "supervised" as const, condition, superseded: null } }),
      goalClear: async () => await Promise.resolve({ ok: true as const, report: { route: "supervised" as const, cleared: null } }),
      compact: async () => await Promise.resolve({ ok: true as const, report: { route: "supervised" as const, trigger: "plugin" } }),
      fanout: rcFanoutOnDoorHub(createRcEventFanout(), events),
      sessionEvents,
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
      paths: buildLayoutPaths("/nonexistent/agent-shim-mcp-config-unexercised"),
      sessionList: () => [],
      liveTasks: () => [],
      sessionShow: () => {
        throw new Error("this test serves no sessions");
      },
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

  /** The server's ports over plain HTTP to the stand-in door, the same shape `doorMcpPorts` has over the pinned TLS link, with the permissions read on every request as the command reads them. */
  function portsFor(permissions: () => McpPermissions): McpServerPorts {
    const link = new RPCLink({ origin, url: RC_ORPC_PATH_PREFIX, headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    return {
      listTools: async () => {
        const answered = await fetch(`${origin}${RC_ORPC_PATH_PREFIX}/openapi.json`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
        return toolsFromOpenApiDocument(await answered.json(), permissions());
      },
      callProcedure: async (procedure, input) => await link.call([...procedure], input, { context: {} }),
    };
  }

  async function connect(permissions: McpPermissions | (() => McpPermissions), options?: Parameters<typeof serveMcp>[2]): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const inForce = typeof permissions === "function" ? permissions : () => permissions;
    void serveMcp(createMcpServer({ name: "agent-shim", version: "0.0.0-test" }, portsFor(inForce)), serverSide, options);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("lists the door's reads as tools and answers a call from the door's own output", async () => {
    const client = await connect({ writes: false, remoteControl: false, history: false, directives: false });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("frontdoor_status");
    expect(names).toContain("usage_effectiveWindow");
    expect(names).not.toContain("rc_send");
    const status = await client.callTool({ name: "frontdoor_status", arguments: {} });
    expect(JSON.parse(textOf(status))).toMatchObject({ supervisorAlive: true, state: { port: 4100 } });
    await client.close();
  });

  it("serves every session's transitions as a cursor-paged read tool, and leaves the stream that cannot be a tool out", async () => {
    const client = await connect({ writes: false, remoteControl: false, history: false, directives: false });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("rcSessions_eventsPage");
    expect(names).not.toContain("rcSessions_events");
    sessionEvents.append({ kind: "session-appeared", session: SESSION_ID, at: 1 });
    const page = await client.callTool({ name: "rcSessions_eventsPage", arguments: { limit: 1 } });
    expect(JSON.parse(textOf(page))).toMatchObject({ status: "ok", events: [{ kind: "session-appeared", session: SESSION_ID, sequence: 1 }] });
    await client.close();
  });

  it("returns a refusal as an error result naming its code, not as a protocol failure", async () => {
    const client = await connect({ writes: false, remoteControl: false, history: false, directives: false });
    const refused = await client.callTool({ name: "usage_effectiveWindow", arguments: { identity: "nobody" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("NOT_FOUND");
    await client.close();
  });

  it("exposes a Remote Control write only when its opt-in is given, and the call reaches the door's operation", async () => {
    const withoutOptIn = await connect({ writes: true, remoteControl: false, history: false, directives: false });
    expect((await withoutOptIn.listTools()).tools.map((tool) => tool.name)).not.toContain("rc_send");
    await withoutOptIn.close();
    const client = await connect({ writes: false, remoteControl: true, history: false, directives: false });
    const sent = await client.callTool({ name: "rc_send", arguments: { session: SESSION_ID, text: "hello" } });
    expect(sent.isError).not.toBe(true);
    expect(JSON.parse(textOf(sent))).toMatchObject({ session: SESSION_ID, sequenceNums: WRITE_SEQUENCE_NUMS });
    expect(injected).toEqual(["hello"]);
    await client.close();
  });

  it("exposes a goal set and an instructed compaction only under the directives grant on top of the Remote Control one, which does not imply it", async () => {
    const remoteOnly = await connect({ writes: true, remoteControl: true, history: false, directives: false });
    const remoteTools = (await remoteOnly.listTools()).tools.map((tool) => tool.name);
    expect(remoteTools).toEqual(expect.arrayContaining(["rc_goalGet", "rc_goalClear", "rc_compact"]));
    expect(remoteTools).not.toContain("rc_goalSet");
    expect(remoteTools).not.toContain("rc_compactWithInstructions");
    await remoteOnly.close();
    const alone = await connect({ writes: false, remoteControl: false, history: false, directives: true });
    expect((await alone.listTools()).tools.map((tool) => tool.name)).not.toContain("rc_goalSet");
    await alone.close();
    const directives = await connect({ writes: false, remoteControl: true, history: false, directives: true });
    const directiveTools = (await directives.listTools()).tools.map((tool) => tool.name);
    expect(directiveTools).toEqual(expect.arrayContaining(["rc_goalSet", "rc_compactWithInstructions", "rc_goalGet", "rc_goalClear"]));
    const set = await directives.callTool({ name: "rc_goalSet", arguments: { session: SESSION_ID, condition: "the build is green" } });
    expect(set.isError).not.toBe(true);
    expect(JSON.parse(textOf(set))).toMatchObject({ session: SESSION_ID, condition: "the build is green", superseded: null });
    await directives.close();
  });

  it("lists a pending question with its questions and options through the pending tool", async () => {
    const session = "cse_00000000-0000-4000-8000-0000000000cc";
    const observed = tracker.observeExchange({ method: "POST", url: `/v1/code/sessions/${session}/worker/heartbeat`, headers: { authorization: "Bearer b" } });
    observed?.onResponse(HTTP_STATUS.ok, {});
    observed?.onEnd();
    const questions = [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }] }];
    tracker.fileStreamEvent(session, { event_type: "control_request", sequence_num: 1, source: "worker", payload: { type: "control_request", request_id: "req_listed", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions } } } });
    const client = await connect({ writes: false, remoteControl: true, history: false });
    const listed = await client.callTool({ name: "rc_pending", arguments: { session } });
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse(textOf(listed))).toEqual({ pending: [expect.objectContaining({ sessionId: session, requestId: "req_listed", questions })] });
    await client.close();
  });

  it("answers a question through the rc_answer tool, whose input schema carries the choices", async () => {
    const client = await connect({ writes: false, remoteControl: true, history: false });
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "rc_answer");
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("choices");
    const result = await client.callTool({ name: "rc_answer", arguments: { session: SESSION_ID, request: "req_q", approve: true, choices: [["SQLite"], [1, { text: "fmt" }]] } });
    expect(result.isError).not.toBe(true);
    expect(answerDecisions.at(-1)).toEqual({ approve: true, message: undefined, choices: [["SQLite"], [1, { text: "fmt" }]] });
    const blank = await client.callTool({ name: "rc_answer", arguments: { session: SESSION_ID, request: "req_q", approve: true, choices: [[{ text: "  " }]] } });
    expect(blank.isError).toBe(true);
    await client.close();
  });

  it("follows a change of permissions on the next request, in both directions, without a new server", async () => {
    let granted: McpPermissions = { writes: false, remoteControl: false, history: false, directives: false };
    const client = await connect(() => granted);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("rc_send");

    granted = { writes: false, remoteControl: true, history: false, directives: false };
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("rc_send");
    const sent = await client.callTool({ name: "rc_send", arguments: { session: SESSION_ID, text: "now allowed" } });
    expect(sent.isError).not.toBe(true);

    granted = { writes: false, remoteControl: false, history: false, directives: false };
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("rc_send");
    const refused = await client.callTool({ name: "rc_send", arguments: { session: SESSION_ID, text: "no longer allowed" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("no tool named rc_send");
    expect(injected).not.toContain("no longer allowed");
    await client.close();
  });

  it("tells a connected client its tool list changed when the command announces it", async () => {
    let announce: (() => void) | undefined;
    const client = await connect(
      { writes: false, remoteControl: false, history: false, directives: false },
      {
        whileConnected: (announceToolListChanged) => {
          announce = announceToolListChanged;
          return () => undefined;
        },
      },
    );
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        resolve();
      });
    });
    announce?.();
    await changed;
    await client.close();
  });

  it("closes the server, and stops what the command held open, when the client's input ends", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    let release: () => void = () => undefined;
    const inputEnded = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopped = false;
    const served = serveMcp(createMcpServer({ name: "agent-shim", version: "0.0.0-test" }, portsFor(() => ({ writes: false, remoteControl: false, history: false, directives: false }))), serverSide, {
      whileConnected: () => () => {
        stopped = true;
      },
      inputEnded,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    expect(stopped).toBe(false);

    release();
    await served;

    expect(stopped).toBe(true);
    await client.close();
  });

  it("refuses an unknown tool as an error result", async () => {
    const client = await connect({ writes: false, remoteControl: false, history: false, directives: false });
    const missing = await client.callTool({ name: "nothing_here", arguments: {} });
    expect(missing.isError).toBe(true);
    await client.close();
  });
});

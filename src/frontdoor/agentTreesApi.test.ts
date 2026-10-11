import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";

import type { SessionAgentTree } from "../agents/schema";
import { SessionLookupError } from "../agents/sessions";
import { RC_ORPC_PATH_PREFIX, doorApiNodeHandlerOf } from "./rcApi";
import { createAgentTreesApiRouter, type AgentTreesApiDeps } from "./agentTreesApi";

/** The token the router under test accepts, standing in for the door's per-generation file-backed token. */
const CONTROL_TOKEN = "unit-sessions-token";

type SessionsClient = RouterClient<ReturnType<typeof createAgentTreesApiRouter>>;

const SUMMARY = {
  project: "-work-repo",
  sessionId: "aaaa1111",
  superseded: false,
  entry: "aaaa1111",
  agentCount: 2,
  workflowRunCount: 0,
  updatedAt: "2026-01-15T10:00:00.000Z",
  identities: ["work", "personal"],
} as const;

const TREE: SessionAgentTree = {
  project: "-work-repo",
  sessionId: "aaaa1111",
  superseded: false,
  agents: [
    {
      id: "a1",
      kind: "subagent",
      agentType: "Explore",
      transcript: "projects/-work-repo/aaaa1111/subagents/agent-a1.jsonl",
      children: [{ id: "a2", kind: "fork", agentType: "fork", transcript: "projects/-work-repo/aaaa1111/subagents/agent-a2.jsonl", children: [] }],
    },
  ],
  tasks: [{ id: "1", subject: "do it", status: "pending", blocks: [], blockedBy: [] }],
  workflowRuns: [],
  problems: [],
};

async function mountClient(deps: AgentTreesApiDeps, token: string): Promise<{ readonly client: SessionsClient; readonly close: () => Promise<void> }> {
  const surface = doorApiNodeHandlerOf(createAgentTreesApiRouter(deps), CONTROL_TOKEN);
  const server = http.createServer((request, response) => {
    void surface.handle(request, response).catch((error: unknown) => {
      console.error(error);
    });
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
  return {
    client: createORPCClient(new RPCLink({ origin: `http://127.0.0.1:${String(address.port)}`, url: RC_ORPC_PATH_PREFIX, headers: { authorization: `Bearer ${token}` } })),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}

describe("the door's agent trees API", () => {
  const asked: { filters?: unknown; query?: string; identity?: string | undefined } = {};
  const deps: AgentTreesApiDeps = {
    expectedToken: CONTROL_TOKEN,
    sessionList: (filters) => {
      asked.filters = filters;
      if (filters.identity === "nope") {
        throw new SessionLookupError('no identity named "nope"');
      }
      return [SUMMARY];
    },
    sessionShow: (query, identity) => {
      asked.query = query;
      asked.identity = identity;
      if (query === "zz") {
        throw new SessionLookupError('no session matches "zz"');
      }
      return { identities: ["work"], tree: TREE };
    },
  };
  let client: SessionsClient;
  let refused: SessionsClient;
  const closes: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const mounted = await mountClient(deps, CONTROL_TOKEN);
    client = mounted.client;
    closes.push(mounted.close);
    const refusedMount = await mountClient(deps, "not-the-control-token");
    refused = refusedMount.client;
    closes.push(refusedMount.close);
  });

  afterAll(async () => {
    for (const close of closes) {
      await close();
    }
  });

  it("lists sessions with the filters it was given", async () => {
    const answer = await client.agentTrees.list({ all: true });
    expect(answer).toEqual([SUMMARY]);
    expect(asked.filters).toEqual({ all: true });
  });

  it("shows one session's tree beside the identities that expose it", async () => {
    const answer = await client.agentTrees.show({ session: "aaaa", identity: "work" });
    expect(answer).toEqual({ identities: ["work"], ...TREE });
    expect(asked).toMatchObject({ query: "aaaa", identity: "work" });
  });

  it("answers a lookup the caller got wrong as a bad request carrying the reader's message", async () => {
    await expect(client.agentTrees.list({ identity: "nope" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: 'no identity named "nope"' });
    await expect(client.agentTrees.show({ session: "zz" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: 'no session matches "zz"' });
  });

  it("refuses a request without the control token", async () => {
    await expect(refused.agentTrees.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

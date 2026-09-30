import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, fakeResponse, recordingFetch } from "../codex/testing";
import { FAKE_HOME, fakeFs } from "../test-helpers";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, HOP_SECRET_HEADER, IDENTITY_HEADER, SESSION_HEADER } from "./route";
import { serveRouted, type PipelineDeps } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.claude-use/providers`;
const SETTLE_MS = 50;
const MESSAGES_BODY = JSON.stringify({ model: "claude-sonnet-4-5", stream: false, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "user-a" } });
/** The per-launch capability token the door's client-facing listeners accept in these tests. */
const LAUNCH_TOKEN = "launch-token-for-tests";
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 9, output_tokens: 2 } } },
];

/** One request the fake headroom received, body included. */
interface HopSeen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * The fake headroom: records each request it is handed, then forwards it verbatim (minus its internal headers, the way the real one strips x-headroom-*) to whatever x-headroom-base-url names, or answers itself when the header is absent. Standing in for the real daemon is exactly this much: a forwarding hop keyed by the per-request base URL.
 */
async function fakeHeadroom(): Promise<{ readonly seen: () => readonly HopSeen[]; readonly port: () => number; readonly closedRequests: () => number; readonly close: () => Promise<void> }> {
  const requests: HopSeen[] = [];
  let closedRequests = 0;
  const server = http.createServer((request, response) => {
    request.on("close", () => {
      closedRequests += 1;
    });
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers }, body });
      const base = request.headers["x-headroom-base-url"];
      if (base === undefined) {
        // No per-request upstream: the real daemon's default is Claude Code's API, which the test stands in for directly.
        response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end(JSON.stringify({ via: "default-upstream", body }));
        return;
      }
      const forward = http.request(
        `${String(base)}${request.url ?? ""}`,
        { method: request.method, headers: { ...request.headers, host: new URL(String(base)).host } },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? HTTP_STATUS.badGateway, upstream.headers);
          upstream.pipe(response);
        },
      );
      forward.on("error", () => {
        response.writeHead(HTTP_STATUS.badGateway);
        response.end("forward failed");
      });
      forward.end(body);
    });
  });
  await listen(server);
  return {
    seen: () => requests,
    port: () => portOf(server),
    closedRequests: () => closedRequests,
    close: async () => {
      await closeServer(server);
    },
  };
}

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return (address satisfies AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve(undefined);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await closeServer(server);
    }),
  );
});

/** The whole door assembly over a fake headroom: the main listener (with the hop) and the direct listener (without it), sharing one resolver whose in-process routes name the direct address. */
async function startDoor(options: { readonly files: Record<string, unknown>; readonly headroomPort: () => number | undefined }): Promise<{ readonly url: string; readonly close: () => Promise<void>; readonly directPort: () => number }> {
  const upstream = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const ports: Omit<CodexRoutePorts, "loadProvider"> = {
    upstream: { fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" },
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
  let directPort = 0;
  const resolveRoute = createProviderRouteResolver({ fs: fakeFs(options.files), providersDir: PROVIDERS_DIR, codexPorts: ports, directPort: () => directPort });
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const hopSecret = "hop-secret-for-tests";
  const buildPipeline = (clientFacing: boolean): PipelineDeps => ({
    resolveRoute,
    responseObservers: [],
    authorize: clientFacing ? (headers) => headers[AUTH_HEADER] === LAUNCH_TOKEN : (headers) => headers[HOP_SECRET_HEADER] === hopSecret,
    ...(clientFacing ? { headroom: { headroomPort: options.headroomPort, hopSecret, log } } : {}),
    log,
  });
  const direct = createFrontDoorServer(async (request) => {
    await serveRouted(request, buildPipeline(false));
  }, log);
  const directHandle = await listenFrontDoor(direct, undefined, () => undefined);
  directPort = directHandle.port;
  const main = createFrontDoorServer(async (request) => {
    await serveRouted(request, buildPipeline(true));
  }, log);
  const mainHandle = await listenFrontDoor(main, undefined, () => undefined);
  return {
    url: `http://127.0.0.1:${String(mainHandle.port)}`,
    close: async () => {
      await mainHandle.close();
      await directHandle.close();
    },
    directPort: () => directPort,
  };
}


const codexProvider = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } };

/** Lets the event loop turn once, so an unwanted background request would have landed in the recorder. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

describe("the headroom hop", () => {
  it("sits before the translator: headroom receives the Anthropic-shaped request, and the translator serves what headroom forwards back through the direct listener", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: headroom.port });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
      });
      if (response.status !== HTTP_STATUS.ok) {
        throw new Error(`door answered ${String(response.status)}: ${await response.text()}`);
      }
      const body = (await response.json()) as { readonly content?: readonly { readonly text?: string }[] };
      expect(body.content?.[0]?.text).toBe("Hello");
      // Exactly one headroom request, exactly one codex upstream call: the loop through the direct listener cannot double-apply anything.
      expect(headroom.seen()).toHaveLength(1);
      const seen = headroom.seen()[0];
      expect(seen?.url).toBe("/providers/codex/v1/messages");
      expect(JSON.parse(seen?.body ?? "{}")).toMatchObject({ model: "claude-sonnet-4-5" });
      expect(seen?.headers["x-headroom-base-url"]).toBe(`http://127.0.0.1:${String(door.directPort())}`);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("re-sets the project identity on the hop and forwards no session header to it, or beyond", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: headroom.port });
    try {
      await fetch(`${door.url}/providers/codex/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, "x-headroom-project-id": "/repo" },
        body: MESSAGES_BODY,
      });
      const seen = headroom.seen()[0];
      expect(seen?.headers["x-headroom-project-id"]).toBe("/repo");
      expect(seen?.headers[IDENTITY_HEADER]).toBeUndefined();
      expect(seen?.headers[SESSION_HEADER]).toBeUndefined();
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("answers 502 rather than bypassing headroom while the daemon is between restarts", async () => {
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: () => undefined });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    } finally {
      await door.close();
    }
  });

  it("aborts the hop the moment the client disconnects, which is what cancels the daemon's request", async () => {
    // This headroom never answers: it holds the request open, so the only way the test ends is the client's abort unwinding the hop.
    const server = http.createServer(() => undefined);
    await listen(server);
    const holdingPort = portOf(server);
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: () => holdingPort });
    try {
      const abort = new AbortController();
      const pending = fetch(`${door.url}/providers/codex/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY, signal: abort.signal });
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      abort.abort();
      await pending.then(
        () => undefined,
        () => undefined,
      );
    } finally {
      await door.close();
      await closeServer(server);
    }
  });

  it("serves a headroom-ineligible or flag-less session directly, never through the hop", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: headroom.port });
    try {
      // No headroom flag header: the session never asked for the hop, so the door serves the route itself.
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.ok);
      await settle();
      expect(headroom.seen()).toHaveLength(0);
    } finally {
      await door.close();
      await headroom.close();
    }
  });
});

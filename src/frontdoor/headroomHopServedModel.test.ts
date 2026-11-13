import http from "node:http";
import { fetch } from "undici";
import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "../codex/http";
import { launchOf, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, SERVED_MODEL_HEADER, SESSION_HEADER } from "./route";
import { PROVIDERS_DIR, KEYGEN_TIMEOUT_MS, LAUNCH_TOKEN, fakeHeadroom, listen, portOf, trusting, startDoor } from "./headroomHopTestWorld";

/** The status the provider's batch endpoint answers with, which no part of the door makes up. */
const BATCH_ANSWER_STATUS = 202;

/** A provider server whose model list and answers a test steers: its list names `serving`, and a request for a model it was told to `reject` is answered as an unknown one. */
async function liveModelUpstream(options: { readonly forgedHeader?: string; readonly listFails?: boolean } = {}): Promise<{ readonly port: number; readonly sentModels: readonly string[]; readonly serve: (model: string) => void; readonly reject: (model: string) => void; readonly otherRequests: readonly string[] }> {
  const sentModels: string[] = [];
  const otherRequests: string[] = [];
  const rejected = new Set<string>();
  let serving = "live-model";
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      if (request.url === "/v1/models") {
        response.writeHead(options.listFails === true ? HTTP_STATUS.internalServerError : HTTP_STATUS.ok, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: serving }] }));
        return;
      }
      if (request.url?.startsWith("/v1/messages/batches") === true) {
        otherRequests.push(`${request.method ?? ""} ${request.url}`);
        response.writeHead(BATCH_ANSWER_STATUS, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const parsed: unknown = JSON.parse(body);
      const model = typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string" ? parsed.model : "";
      sentModels.push(model);
      const forged = options.forgedHeader === undefined ? {} : { [SERVED_MODEL_HEADER.toUpperCase()]: options.forgedHeader };
      if (rejected.has(model)) {
        response.writeHead(HTTP_STATUS.notFound, { "content-type": "application/json", ...forged });
        response.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model: ${model} not found` } }));
        return;
      }
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json", ...forged });
      response.end(JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await listen(server);
  return { port: portOf(server), sentModels, otherRequests, serve: (model) => { serving = model; }, reject: (model) => { rejected.add(model); } };
}

/**
 * The model a request is finally sent under reaches the session's route context across the headroom hop, where the route that sends is the direct listener's and the resolution that has a listener for it is the client-facing one. Every row runs the request with the hop and without it and expects the same context.
 */
describe.each([["through the headroom hop", true], ["directly", false]] as const)("the route context of a session whose request goes %s", (_label, viaHop) => {
  const SESSION_FILES = (port: number): Record<string, unknown> => ({ [`${PROVIDERS_DIR}/spark.json`]: { displayName: "spark", baseUrl: `http://127.0.0.1:${String(port)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" } } });

  async function ask(door: Readonly<{ readonly url: string }>, model: string, extra: Readonly<Record<string, string>> = {}): Promise<Awaited<ReturnType<typeof fetch>>> {
    return await fetch(`${door.url}/v1/messages`, { dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [SESSION_HEADER]: "session-1", ...(viaHop ? { [HEADROOM_FLAG_HEADER]: "1" } : {}), [AUTH_HEADER]: LAUNCH_TOKEN, "x-claude-code-request-class": "main", ...extra }, body: JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }) });
  }

  /** The route context of the launch, after `requests`, against a door with a fake headroom when the hop is in use. */
  async function contextAfter(upstream: Awaited<ReturnType<typeof liveModelUpstream>>, requests: (door: { readonly url: string }) => Promise<void>): Promise<ReturnType<ReturnType<typeof mainLoopRoutesOfLiveSessions>["routeOf"]>> {
    const record = mainLoopRoutesOfLiveSessions();
    const headroom = viaHop ? await fakeHeadroom() : undefined;
    const door = await startDoor({ record, files: SESSION_FILES(upstream.port) });
    try {
      await requests(door);
      if (headroom !== undefined) expect(headroom.seen().length).toBeGreaterThan(0);
      return record.routeOf(launchOf(LAUNCH_TOKEN));
    } finally {
      await door.close();
      await headroom?.close();
    }
  }

  it("learns the live model of spark/auto, and nothing of the header that carried it reaches the client", async () => {
    const upstream = await liveModelUpstream();
    let carried: string | null = null;
    const context = await contextAfter(upstream, async (door) => {
      const response = await ask(door, "spark/auto");
      carried = response.headers.get(SERVED_MODEL_HEADER);
      expect(response.status).toBe(HTTP_STATUS.ok);
    });
    expect(upstream.sentModels).toEqual(["live-model"]);
    expect(context).toMatchObject({ provider: "spark", requestedModel: "spark/auto", servedModel: "live-model" });
    expect(carried).toBeNull();
  }, KEYGEN_TIMEOUT_MS);

  it("learns the live model of the bare auto on a provider context, and of a Claude name whose tier value is auto", async () => {
    const upstream = await liveModelUpstream();
    const context = await contextAfter(upstream, async (door) => {
      expect((await ask(door, "spark")).status).toBe(HTTP_STATUS.ok);
      expect((await ask(door, "auto")).status).toBe(HTTP_STATUS.ok);
    });
    expect(upstream.sentModels).toEqual(["spark-main", "live-model"]);
    expect(context).toMatchObject({ provider: "spark", servedModel: "live-model" });
  }, KEYGEN_TIMEOUT_MS);

  it("learns the model a refreshed list names, after the server answered the first as unknown", async () => {
    const upstream = await liveModelUpstream();
    const context = await contextAfter(upstream, async (door) => {
      expect((await ask(door, "spark/auto")).status).toBe(HTTP_STATUS.ok);
      upstream.serve("newer-model");
      upstream.reject("live-model");
      expect((await ask(door, "spark/auto")).status).toBe(HTTP_STATUS.ok);
    });
    expect(upstream.sentModels).toEqual(["live-model", "live-model", "newer-model"]);
    expect(context).toMatchObject({ provider: "spark", servedModel: "newer-model" });
  }, KEYGEN_TIMEOUT_MS);

  it("learns a model whose name holds characters a header value cannot, which the hop carries encoded", async () => {
    const upstream = await liveModelUpstream();
    upstream.serve("modèle-é-日本");
    const context = await contextAfter(upstream, async (door) => {
      expect((await ask(door, "spark/auto")).status).toBe(HTTP_STATUS.ok);
    });
    expect(context).toMatchObject({ provider: "spark", servedModel: "modèle-é-日本" });
  }, KEYGEN_TIMEOUT_MS);

  it("records no served model for a request that was refused before it was sent", async () => {
    const upstream = await liveModelUpstream({ listFails: true });
    const context = await contextAfter(upstream, async (door) => {
      expect((await ask(door, "spark/auto")).status).toBe(HTTP_STATUS.badGateway);
    });
    expect(upstream.sentModels).toEqual([]);
    expect(context?.servedModel).toBeUndefined();
  }, KEYGEN_TIMEOUT_MS);

  it("never takes a served model from a header a server or a client sent", async () => {
    const upstream = await liveModelUpstream({ forgedHeader: "forged-by-server" });
    let carried: string | null = null;
    const context = await contextAfter(upstream, async (door) => {
      const response = await ask(door, "spark/auto", { [SERVED_MODEL_HEADER]: "forged-by-client" });
      carried = response.headers.get(SERVED_MODEL_HEADER);
    });
    expect(context).toMatchObject({ provider: "spark", servedModel: "live-model" });
    expect(carried).toBeNull();
  }, KEYGEN_TIMEOUT_MS);
});

/** What the hop makes of a head that carries a served-model header it cannot decode: the daemon's response is the one thing it does not control, so a value that is no encoded name is ignored and the response is served as it is. */
describe("the headroom hop's reading of the served-model header", () => {
  it.each([["a malformed escape", "%E0%A4%A"], ["an empty value", ""], ["a header sent twice", ["live-model", "other-model"]]])("ignores %s, and serves the response", async (_label, value) => {
    const record = mainLoopRoutesOfLiveSessions();
    const upstream = await liveModelUpstream();
    const headroom = await fakeHeadroom({ responseHeaders: { [SERVED_MODEL_HEADER]: value } });
    const door = await startDoor({ record, files: { [`${PROVIDERS_DIR}/spark.json`]: { displayName: "spark", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "t" }] } } } });
    try {
      const response = await fetch(`${door.url}/v1/messages`, { dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, "x-claude-code-request-class": "main" }, body: JSON.stringify({ model: "spark/live-model", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }) });
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect(response.headers.get(SERVED_MODEL_HEADER)).toBeNull();
      expect(record.routeOf(launchOf(LAUNCH_TOKEN))).toMatchObject({ provider: "spark", servedModel: "live-model" });
    } finally {
      await door.close();
      await headroom.close();
    }
  }, KEYGEN_TIMEOUT_MS);
});

/**
 * A request that carries no model (a batch, its results) from a session whose route context is a provider crosses the hop like any other and reaches the provider: the resolution that carries it names the provider in its path, which the hop reads to hold the credential and the direct listener reads to route.
 */
describe.each([["through the headroom hop", true], ["directly", false]] as const)("a request with no model from a session on a provider context, going %s", (_label, viaHop) => {
  it.each([["GET", "/v1/messages/batches/abc/results"], ["GET", "/v1/messages/batches?limit=2"], ["POST", "/v1/messages/batches"]])("reaches the provider with %s %s as it was sent, and the answer is the provider's", async (method, path) => {
    const upstream = await liveModelUpstream();
    const record = mainLoopRoutesOfLiveSessions();
    const headroom = viaHop ? await fakeHeadroom() : undefined;
    const door = await startDoor({ record, files: { [`${PROVIDERS_DIR}/spark.json`]: { displayName: "spark", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "t" }] } } } });
    const headers = { [SESSION_HEADER]: "session-1", ...(viaHop ? { [HEADROOM_FLAG_HEADER]: "1" } : {}), [AUTH_HEADER]: LAUNCH_TOKEN, "x-claude-code-request-class": "main" };
    try {
      const first = await fetch(`${door.url}/v1/messages`, { dispatcher: trusting, method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "spark/live-model", max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }) });
      expect(first.status).toBe(HTTP_STATUS.ok);
      const before = record.routeOf(launchOf(LAUNCH_TOKEN));
      const answered = await fetch(`${door.url}${path}`, { dispatcher: trusting, method, headers: method === "POST" ? { ...headers, "content-type": "application/json" } : headers, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(answered.status).toBe(BATCH_ANSWER_STATUS);
      expect(upstream.otherRequests).toEqual([`${method} ${path}`]);
      expect(record.routeOf(launchOf(LAUNCH_TOKEN))).toEqual(before);
    } finally {
      await door.close();
      await headroom?.close();
    }
  }, KEYGEN_TIMEOUT_MS);
});

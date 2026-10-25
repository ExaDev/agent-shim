import { describe, expect, it } from "vitest";

import { renderContracts, normaliseTarget, summariseContracts } from "./decode-contract-core";
import { decodeExchanges, type HttpExchange, type HttpMessage } from "./decode-http-capture-core";
import { encodeChunk, type CaptureRecord } from "./rc-capture-record";

const HOST = "api.example.test";
const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;
const SAMPLES_FOR_ENUM = 3;

function message(startLine: string, headers: readonly (readonly [string, string])[], body: Buffer = Buffer.alloc(0), complete = true): HttpMessage {
  return { startLine, headers, body, complete };
}

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

function exchange(request: string, requestBody: unknown, status: number, responseBody: unknown, host = HOST): HttpExchange {
  return {
    conn: 1,
    host,
    request: message(request, [["content-type", "application/json"]], requestBody === undefined ? Buffer.alloc(0) : json(requestBody)),
    response: message(`HTTP/1.1 ${String(status)} X`, [["content-type", "application/json"]], responseBody === undefined ? Buffer.alloc(0) : json(responseBody)),
    upgraded: false,
    tail: undefined,
  };
}

function only<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) {
    throw new Error(`expected exactly one, got ${String(items.length)}`);
  }
  return first;
}

describe("normaliseTarget", () => {
  it("replaces uuids, prefixed ids and long tokens, and lists the query names once, sorted", () => {
    const target = "/api/oauth/organizations/0b9a3c1e-5d52-4b7e-9c11-2f0a8d6e4a77/code/sessions/session_01X1jsRxbPvFw1yyDtFnVw39/token/AbCdEfGh1jKlMnOpQr5tUv?b=1&a=2&b=3";
    expect(normaliseTarget(target)).toEqual({ path: "/api/oauth/organizations/{uuid}/code/sessions/{session_id}/token/{id}", query: ["a", "b"] });
  });

  it("keeps short readable segments and turns a member name before a download into a placeholder", () => {
    expect(normaliseTarget("/api/orgs/skills/docx/download").path).toBe("/api/orgs/skills/{name}/download");
    expect(normaliseTarget("/v1/environment_providers?limit=100").path).toBe("/v1/environment_providers");
  });
});

describe("summariseContracts", () => {
  it("merges samples of one endpoint into one shape, marking keys missing from some samples optional", () => {
    const summary = only(
      summariseContracts([
        exchange("POST /v1/things HTTP/1.1", { a: 1, b: "x" }, STATUS_OK, { id: "i1", ok: true }),
        exchange("POST /v1/things HTTP/1.1", { a: 2 }, STATUS_OK, { id: "i2", ok: false, note: null }),
      ]),
    );
    expect(summary.samples).toBe(2);
    expect(summary.request).toEqual({ a: "number", "b?": "string" });
    expect(only(summary.responses).body).toEqual({ id: "string", "note?": "null", ok: "boolean" });
  });

  it("joins the types of a field that differs between samples", () => {
    const summary = only(summariseContracts([exchange("POST /x HTTP/1.1", { v: 1 }, STATUS_OK, undefined), exchange("POST /x HTTP/1.1", { v: "s" }, STATUS_OK, undefined)]));
    expect(summary.request).toEqual({ v: ["number", "string"] });
  });

  it("merges every element of an array, so mixed event types in one list all appear", () => {
    const summary = only(summariseContracts([exchange("POST /e HTTP/1.1", undefined, STATUS_OK, { events: [{ type: "a", x: 1 }, { type: "b", y: true }] })]));
    expect(only(summary.responses).body).toEqual({ events: [{ type: "string", "x?": "number", "y?": "boolean" }] });
  });

  it("reports a string as an enumeration only when several samples agree on a small closed set, never from one sample", () => {
    const one = only(summariseContracts([exchange("GET /s HTTP/1.1", undefined, STATUS_OK, { type: "message" })]));
    expect(only(one.responses).body).toEqual({ type: "string" });
    const many = only(
      summariseContracts(Array.from({ length: SAMPLES_FOR_ENUM }, (_unused, index) => exchange("GET /s HTTP/1.1", undefined, STATUS_OK, { type: index === 0 ? "message" : "error" }))),
    );
    expect(only(many.responses).body).toEqual({ type: '"error"|"message"' });
  });

  it("keeps the responses of different statuses apart and an empty array as unknown elements", () => {
    const summary = only(summariseContracts([exchange("GET /r HTTP/1.1", undefined, STATUS_OK, { list: [] }), exchange("GET /r HTTP/1.1", undefined, STATUS_NOT_FOUND, { error: { type: "not_found" } })]));
    expect(summary.responses.map((response) => response.status)).toEqual([String(STATUS_OK), String(STATUS_NOT_FOUND)]);
    expect(summary.responses[0]?.body).toEqual({ list: ["unknown"] });
  });

  it("redacts credential-named fields before they reach a shape", () => {
    const summary = only(summariseContracts([exchange("POST /v1/oauth/token HTTP/1.1", { refresh_token: "secret-value" }, STATUS_OK, { access_token: "another-secret" })]));
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("separates endpoints by host and orders them by host, path, then method", () => {
    const summaries = summariseContracts([exchange("POST /b HTTP/1.1", undefined, STATUS_OK, undefined, "z.test"), exchange("GET /b HTTP/1.1", undefined, STATUS_OK, undefined, "a.test"), exchange("GET /a HTTP/1.1", undefined, STATUS_OK, undefined, "a.test")]);
    expect(summaries.map((summary) => `${summary.host} ${summary.method} ${summary.path}`)).toEqual(["a.test GET /a", "a.test GET /b", "z.test POST /b"]);
  });

  it("labels a body that is not JSON by its kind and keeps non-credential headers by name", () => {
    const target: HttpExchange = {
      conn: 1,
      host: HOST,
      request: message("GET /t HTTP/1.1", [["anthropic-beta", "oauth-2025-04-20"], ["x-custom-flag", "1"], ["authorization", "Bearer abc"], ["user-agent", "ua"]]),
      response: message("HTTP/1.1 200 OK", [["content-type", "text/plain"]], Buffer.from("plain words")),
      upgraded: false,
      tail: undefined,
    };
    const summary = only(summariseContracts([target]));
    expect(summary.requestHeaders).toEqual({ "anthropic-beta": ["oauth-2025-04-20"], "x-custom-flag": [] });
    expect(only(summary.responses).nonJson).toEqual(["text"]);
  });
});

describe("summariseContracts over a WebSocket connection", () => {
  const record = (id: number, dir: CaptureRecord["dir"], bytes: Buffer): CaptureRecord => ({ ts: "2026-01-01T00:00:00.000Z", id, conn: 1, dir, host: HOST, ...encodeChunk(bytes) });
  const frame = (value: unknown): Buffer => {
    const payload = Buffer.from(JSON.stringify(value));
    return Buffer.concat([Buffer.from("81", "hex"), Buffer.from([payload.length]), payload]);
  };

  it("groups messages by direction and discriminator and merges their shapes", () => {
    const request = Buffer.from("GET /sync HTTP/1.1\r\nUpgrade: websocket\r\n\r\n");
    const upgrade = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
    const exchanges = decodeExchanges([
      record(1, "client_to_server", request),
      record(2, "server_to_client", Buffer.concat([upgrade, frame({ kind: "roster", agents: [] }), frame({ kind: "ctrl", ver: "v1" }), frame({ kind: "roster", agents: [{ id: "a" }] })])),
    ]);
    const summary = only(summariseContracts(exchanges));
    expect(summary.websocket.map((group) => `${group.direction} ${group.kind} ${String(group.samples)}`)).toEqual(["server_to_client text:roster 2", "server_to_client text:ctrl 1"]);
    expect(summary.websocket[0]?.body).toEqual({ agents: [{ id: "string" }], kind: "string" });
  });
});

describe("renderContracts", () => {
  it("prints one block per endpoint with the shapes on single lines", () => {
    const text = renderContracts(summariseContracts([exchange("POST /v1/things?x=1 HTTP/1.1", { a: 1 }, STATUS_OK, { ok: true })]));
    expect(text).toContain("## POST api.example.test/v1/things  (1 sample)");
    expect(text).toContain("query: x");
    expect(text).toContain('request: {"a":"number"}');
    expect(text).toContain('response 200 (1): {"ok":"boolean"}');
  });
});

describe("maps keyed by names", () => {
  const MANY_KEYS = 30;
  const keyed = (offset: number): Record<string, unknown> => Object.fromEntries(Array.from({ length: MANY_KEYS }, (_unused, index) => [`flag_${String(index + offset)}`, { on: index % 2 === 0, value: index }]));

  it("shows an object with very many keys as one entry whose key is a placeholder", () => {
    const summary = only(summariseContracts([exchange("POST /eval HTTP/1.1", undefined, STATUS_OK, { features: keyed(0) }), exchange("POST /eval HTTP/1.1", undefined, STATUS_OK, { features: keyed(MANY_KEYS) })]));
    expect(only(summary.responses).body).toEqual({ features: { "<key>": { on: "boolean", value: "number" } } });
  });
});

describe("normaliseTarget for repository routes", () => {
  it("replaces the owner and repository after code/repos", () => {
    expect(normaliseTarget("/api/oauth/organizations/0b9a3c1e-5d52-4b7e-9c11-2f0a8d6e4a77/code/repos/some-owner/some-repo").path).toBe("/api/oauth/organizations/{uuid}/code/repos/{owner}/{repo}");
  });
});

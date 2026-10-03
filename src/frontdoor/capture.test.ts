import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { CHUNK_LOG_CAP_BYTES, STREAM_LOG_CAP_BYTES, createFileCapture, redactBody, redactHeaders } from "./capture";

/** The status the fake upstream answers with, named so a status literal never reads as a magic number. */
const HTTP_UNAUTHORIZED = 401;
/** A few bytes past the excerpt cap, enough to prove the cap truncates without making an oversized fixture. */
const BYTES_PAST_CAP = 10;

describe("redactHeaders", () => {
  it("replaces every credential-named header value and keeps every other header verbatim", () => {
    expect(
      redactHeaders({
        authorization: "Bearer oauth-token",
        "X-Api-Key": "sk-ant-test",
        cookie: "session=1",
        "proxy-authorization": "Basic x",
        "content-type": "application/json",
        host: "api.anthropic.com",
      }),
    ).toEqual({
      authorization: "<redacted>",
      "X-Api-Key": "<redacted>",
      cookie: "<redacted>",
      "proxy-authorization": "<redacted>",
      "content-type": "application/json",
      host: "api.anthropic.com",
    });
  });
});

describe("redactBody", () => {
  it("redacts credential-named keys in a JSON body, recursively, while keeping protocol fields like a session id", () => {
    const body = JSON.stringify({
      access_token: "eyJaaaaaaaaaaaa.bbbb.cccccccc",
      refresh_token: "opaque-refresh",
      session_id: "keep-me",
      nested: { api_key: "sk-ant-REDACTED", note: "keep" },
    });
    const redacted = JSON.parse(redactBody(Buffer.from(body))) as Record<string, unknown>;
    expect(redacted.access_token).toBe("<redacted>");
    expect(redacted.refresh_token).toBe("<redacted>");
    expect(redacted.session_id).toBe("keep-me");
    expect((redacted.nested as Record<string, unknown>).api_key).toBe("<redacted>");
    expect((redacted.nested as Record<string, unknown>).note).toBe("keep");
  });

  it("redacts credential-shaped substrings in a non-JSON body, keeping the surrounding protocol lines", () => {
    const body = `data: {"type":"command"}\nAuthorization: Bearer abcdefghijklm\nkey: sk-ant-REDACTED\n`;
    expect(redactBody(Buffer.from(body))).toBe(`data: {"type":"command"}\nAuthorization: Bearer <redacted>\nkey: <redacted>\n`);
  });

  it("leaves a body carrying no credential shapes untouched", () => {
    expect(redactBody(Buffer.from("plain bytes"))).toBe("plain bytes");
  });
});

describe("createFileCapture", () => {
  it("writes one JSON line per event, correlating chunks with their request by id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-capture-"));
    const file = path.join(dir, "nested", "frontdoor-capture.jsonl");
    const capture = createFileCapture(file, () => new Date("2026-10-03T12:00:00.000Z"));

    capture.connect({ host: "api.anthropic.com", port: 443 }, true);
    const observer = capture.observePassthrough({ method: "POST", url: "/api/oauth/token", headers: { authorization: "Bearer oauth-token", host: "api.anthropic.com" } });
    const requestBody = '{"refresh_token":"secret"}';
    observer.onRequestChunk(Buffer.from(requestBody));
    observer.onResponse(HTTP_UNAUTHORIZED, { "content-type": "text/plain", "set-cookie": ["session=1"] });
    observer.onResponseChunk(Buffer.from("denied"));
    observer.onEnd();

    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.kind)).toEqual(["connect", "request", "request-chunk", "response", "response-chunk", "end"]);
    expect(lines[0]).toMatchObject({ ts: "2026-10-03T12:00:00.000Z", host: "api.anthropic.com", port: 443, intercepted: true });
    expect(lines[1]).toMatchObject({ id: 1, method: "POST", url: "/api/oauth/token", headers: { authorization: "<redacted>", host: "api.anthropic.com" } });
    expect(lines[2]).toMatchObject({ id: 1, seq: 1, bytes: requestBody.length, body: '{"refresh_token":"<redacted>"}' });
    expect(lines[3]).toMatchObject({ id: 1, status: HTTP_UNAUTHORIZED, headers: { "content-type": "text/plain", "set-cookie": "<redacted>" } });
    expect(lines[4]).toMatchObject({ id: 1, seq: 1, body: "denied" });
    expect(lines[5]).toMatchObject({ id: 1, requestBytesCapped: false, responseBytesCapped: false });
  });

  it("truncates a chunk past the excerpt cap and stops storing a direction past the stream cap, while still counting nothing further", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-capture-"));
    const file = path.join(dir, "frontdoor-capture.jsonl");
    const capture = createFileCapture(file);

    const oversized = Buffer.alloc(CHUNK_LOG_CAP_BYTES + BYTES_PAST_CAP, "a");
    const observer = capture.observePassthrough({ method: "POST", url: "/x", headers: {} });
    observer.onRequestChunk(oversized);
    for (let chunk = 0; chunk <= Math.floor(STREAM_LOG_CAP_BYTES / CHUNK_LOG_CAP_BYTES); chunk += 1) {
      observer.onResponseChunk(Buffer.alloc(CHUNK_LOG_CAP_BYTES, "b"));
    }
    observer.onEnd();

    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const requestChunk = lines.find((line) => line.kind === "request-chunk");
    expect(requestChunk).toMatchObject({ bytes: oversized.length, stored: CHUNK_LOG_CAP_BYTES, truncated: true });
    // The stream cap is a whole number of full chunks, so exactly the chunks that fit are stored and none after.
    const responseChunks = lines.filter((line) => line.kind === "response-chunk");
    expect(responseChunks).toHaveLength(STREAM_LOG_CAP_BYTES / CHUNK_LOG_CAP_BYTES);
    expect(lines[lines.length - 1]).toMatchObject({ kind: "end", responseBytesCapped: true, requestBytesCapped: false });
  });

  it("records an upgrade request separately from piped exchanges", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-capture-"));
    const file = path.join(dir, "frontdoor-capture.jsonl");
    const capture = createFileCapture(file);
    capture.upgrade({ method: "GET", url: "/remote/ws", headers: { upgrade: "websocket" } });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "upgrade", method: "GET", url: "/remote/ws", headers: { upgrade: "websocket" } });
  });
});

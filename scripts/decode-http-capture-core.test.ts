import * as zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  decodeContent,
  decodeExchanges,
  matchesRequest,
  parseCapture,
  redactJson,
  renderExchange,
  shapeOf,
  type HttpExchange,
} from "./decode-http-capture-core";
import { encodeChunk, type CaptureRecord } from "./rc-capture-record";

const HOST = "api.example.test";
const HEX_RADIX = 16;

/** Cut points inside the request below: through its request line, then through the middle of its body. */
const FIRST_CUT = 12;
const SECOND_CUT = 40;

/** Long enough that every compression format shrinks it, so a body left undecoded cannot equal the original by accident. */
const COMPRESSIBLE_CHARS = 300;

/** A masked client frame and a server frame of an upgraded protocol, and bytes that are not valid UTF-8. */
const CLIENT_FRAME = Buffer.from("818000000000", "hex");
const SERVER_FRAME = Buffer.from("81026869", "hex");
const INVALID_UTF8 = Buffer.from("fffefd", "hex");

/** One capture record per piece, numbered in the order given, so a test controls how a stream is split and how connections interleave. */
function records(pieces: readonly { conn: number; dir: CaptureRecord["dir"]; bytes: Buffer }[]): CaptureRecord[] {
  return pieces.map((piece, index) => ({ ts: "2026-01-01T00:00:00.000Z", id: index + 1, conn: piece.conn, dir: piece.dir, host: HOST, ...encodeChunk(piece.bytes) }));
}

const client = (conn: number, text: string | Buffer) => ({ conn, dir: "client_to_server" as const, bytes: Buffer.from(text) });
const server = (conn: number, text: string | Buffer) => ({ conn, dir: "server_to_client" as const, bytes: Buffer.from(text) });

function only(exchanges: readonly HttpExchange[]): HttpExchange {
  const [first] = exchanges;
  if (first === undefined || exchanges.length !== 1) {
    throw new Error(`expected exactly one exchange, got ${String(exchanges.length)}`);
  }
  return first;
}

function chunked(parts: readonly Buffer[]): Buffer {
  return Buffer.concat([...parts.flatMap((part) => [Buffer.from(`${part.length.toString(HEX_RADIX)}\r\n`), part, Buffer.from("\r\n")]), Buffer.from("0\r\n\r\n")]);
}

describe("decodeExchanges", () => {
  it("pairs a content-length request with its response", () => {
    const exchange = only(
      decodeExchanges(
        records([
          client(1, 'POST /v1/things HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}'),
          server(1, 'HTTP/1.1 201 Created\r\nContent-Length: 8\r\n\r\n{"ok":1}'),
        ]),
      ),
    );
    expect(exchange.request.startLine).toBe("POST /v1/things HTTP/1.1");
    expect(exchange.request.body.toString()).toBe('{"a":1}');
    expect(exchange.response?.startLine).toBe("HTTP/1.1 201 Created");
    expect(exchange.response?.body.toString()).toBe('{"ok":1}');
    expect(exchange.upgraded).toBe(false);
  });

  it("reassembles a message split across several records", () => {
    const wire = Buffer.from('POST /p HTTP/1.1\r\nContent-Length: 10\r\n\r\n0123456789');
    const exchange = only(
      decodeExchanges(
        records([
          client(1, wire.subarray(0, FIRST_CUT)),
          client(1, wire.subarray(FIRST_CUT, SECOND_CUT)),
          client(1, wire.subarray(SECOND_CUT)),
          server(1, "HTTP/1.1 204 No Content\r\n\r\n"),
        ]),
      ),
    );
    expect(exchange.request.body.toString()).toBe("0123456789");
  });

  it("keeps interleaved connections apart", () => {
    const exchanges = decodeExchanges(
      records([
        client(1, "GET /one HTTP/1.1\r\n\r\n"),
        client(2, "GET /two HTTP/1.1\r\n\r\n"),
        server(2, "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"),
        server(1, "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"),
      ]),
    );
    expect(exchanges.map((exchange) => [exchange.request.startLine, exchange.response?.body.toString()])).toEqual([
      ["GET /one HTTP/1.1", "one"],
      ["GET /two HTTP/1.1", "two"],
    ]);
  });

  it("reads two keep-alive exchanges on one connection in order", () => {
    const exchanges = decodeExchanges(
      records([
        client(1, "GET /a HTTP/1.1\r\n\r\nGET /b HTTP/1.1\r\n\r\n"),
        server(1, "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nAHTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nB"),
      ]),
    );
    expect(exchanges.map((exchange) => exchange.response?.body.toString())).toEqual(["A", "B"]);
  });

  it("removes chunked framing from a response", () => {
    const body = chunked([Buffer.from("hello "), Buffer.from("world")]);
    const exchange = only(
      decodeExchanges(records([client(1, "GET /c HTTP/1.1\r\n\r\n"), server(1, Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"), body]))])),
    );
    expect(exchange.response?.body.toString()).toBe("hello world");
    expect(exchange.response?.complete).toBe(true);
  });

  it("gives a HEAD response no body whatever its length header says", () => {
    const exchanges = decodeExchanges(
      records([client(1, "HEAD /h HTTP/1.1\r\n\r\nGET /g HTTP/1.1\r\n\r\n"), server(1, "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi")]),
    );
    expect(exchanges.map((exchange) => exchange.response?.body.toString())).toEqual(["", "hi"]);
  });

  it("skips a 100 Continue and takes the final response", () => {
    const exchange = only(
      decodeExchanges(
        records([client(1, "POST /x HTTP/1.1\r\nContent-Length: 1\r\n\r\nz"), server(1, "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")]),
      ),
    );
    expect(exchange.response?.startLine).toBe("HTTP/1.1 200 OK");
    expect(exchange.response?.body.toString()).toBe("ok");
  });

  it("stops at a 101 and leaves the upgraded frames unread", () => {
    const exchange = only(
      decodeExchanges(
        records([
          client(1, Buffer.concat([Buffer.from("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"), CLIENT_FRAME])),
          server(1, Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"), SERVER_FRAME])),
        ]),
      ),
    );
    expect(exchange.upgraded).toBe(true);
    expect(exchange.response?.startLine).toBe("HTTP/1.1 101 Switching Protocols");
  });

  it("flags a body the capture ends in the middle of", () => {
    const exchange = only(decodeExchanges(records([client(1, "GET /t HTTP/1.1\r\n\r\n"), server(1, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc")])));
    expect(exchange.response?.complete).toBe(false);
    expect(exchange.response?.body.toString()).toBe("abc");
  });

  it("reports a request with no response", () => {
    const exchange = only(decodeExchanges(records([client(1, "GET /n HTTP/1.1\r\n\r\n")])));
    expect(exchange.response).toBeUndefined();
    expect(renderExchange(exchange, { shape: false })).toContain("(no response captured)");
  });

  it("reads a response with no length to the end of the connection", () => {
    const exchange = only(decodeExchanges(records([client(1, "GET /e HTTP/1.1\r\n\r\n"), server(1, "HTTP/1.1 200 OK\r\n\r\nuntil close")])));
    expect(exchange.response?.body.toString()).toBe("until close");
  });
});

describe("decodeContent", () => {
  const payload = Buffer.from(JSON.stringify({ message: "x".repeat(COMPRESSIBLE_CHARS) }));
  const withEncoding = (encoding: string, body: Buffer) => ({ startLine: "HTTP/1.1 200 OK", headers: [["content-encoding", encoding]] as const, body, complete: true });

  it.each([
    ["gzip", zlib.gzipSync(payload)],
    ["deflate", zlib.deflateSync(payload)],
    ["br", zlib.brotliCompressSync(payload)],
    ["zstd", zlib.zstdCompressSync(payload)],
  ])("decodes %s", (encoding, compressed) => {
    expect(decodeContent(withEncoding(encoding, compressed)).equals(payload)).toBe(true);
  });

  it("applies a list of encodings in reverse", () => {
    expect(decodeContent(withEncoding("gzip, br", zlib.brotliCompressSync(zlib.gzipSync(payload)))).equals(payload)).toBe(true);
  });

  it("passes an identity body through", () => {
    expect(decodeContent(withEncoding("identity", payload)).equals(payload)).toBe(true);
  });

  it("refuses an encoding it cannot decode", () => {
    expect(() => decodeContent(withEncoding("compress", payload))).toThrow("unsupported content-encoding: compress");
  });
});

describe("rendering", () => {
  const wire = (body: string) => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`;

  it("redacts credential headers and credential-named JSON fields", () => {
    const accessToken = "made-up-access";
    const exchange = only(
      decodeExchanges(
        records([
          client(1, "POST /oauth HTTP/1.1\r\nAuthorization: Bearer made-up-value\r\nCookie: sid=made-up\r\nX-Other: kept\r\nContent-Length: 0\r\n\r\n"),
          server(1, wire(`{"access_token":"${accessToken}","refresh_token":"made-up-refresh","expires_in":3600,"scope":"a b"}`)),
        ]),
      ),
    );
    const text = renderExchange(exchange, { shape: false });
    expect(text).toContain("> authorization: <redacted>");
    expect(text).toContain("> cookie: <redacted>");
    expect(text).toContain("> x-other: kept");
    expect(text).toContain(`"access_token":"<redacted ${String(accessToken.length)} chars>"`);
    expect(text).toContain('"expires_in":3600');
    expect(text).not.toContain("made-up");
  });

  it("prints a body's shape, keeping short strings and abbreviating long ones", () => {
    const exchange = only(
      decodeExchanges(
        records([client(1, "GET /s HTTP/1.1\r\n\r\n"), server(1, wire(JSON.stringify({ type: "session", id: "a-very-long-identifier-that-exceeds-the-literal-limit", items: [{ n: 1 }, { n: 2 }], flag: true })))]),
      ),
    );
    expect(renderExchange(exchange, { shape: true })).toContain('{"type":"session","id":"string","items":[{"n":"number"}],"flag":"boolean"}');
  });

  it("prints a binary body as its size", () => {
    const exchange = only(decodeExchanges(records([client(1, "GET /b HTTP/1.1\r\n\r\n"), server(1, Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n"), INVALID_UTF8]))])));
    expect(renderExchange(exchange, { shape: false })).toContain("(binary, 3 bytes)");
  });

  it("decodes a compressed body before printing it", () => {
    const body = zlib.brotliCompressSync(Buffer.from('{"decoded":true}'));
    const exchange = only(
      decodeExchanges(records([client(1, "GET /z HTTP/1.1\r\n\r\n"), server(1, Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: ${String(body.length)}\r\n\r\n`), body]))])),
    );
    expect(renderExchange(exchange, { shape: false })).toContain('{"decoded":true}');
  });

  it("matches on the request line", () => {
    const exchange = only(decodeExchanges(records([client(1, "POST /v1/sessions HTTP/1.1\r\nContent-Length: 0\r\n\r\n")])));
    expect(matchesRequest(exchange, "POST /v1/sessions")).toBe(true);
    expect(matchesRequest(exchange, "GET /v1/sessions")).toBe(false);
  });
});

describe("redactJson and shapeOf", () => {
  it("redacts at any depth and leaves non-secret fields alone", () => {
    expect(redactJson({ outer: [{ apiKey: "made-up", name: "kept" }] })).toEqual({ outer: [{ apiKey: "<redacted 7 chars>", name: "kept" }] });
  });

  it("reduces an empty array and null to themselves", () => {
    expect(shapeOf({ none: [], nothing: null })).toEqual({ none: [], nothing: null });
  });
});

describe("parseCapture", () => {
  it("skips blank lines and rejects a pre-lossless record, naming its line", () => {
    const good = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", id: 1, conn: 1, dir: "client_to_server", host: HOST, enc: "utf8", data: "x" });
    expect(parseCapture(`${good}\n\n`)).toHaveLength(1);
    const older = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", id: 1, dir: "client_to_server", host: HOST, data: "x" });
    expect(() => parseCapture(`${good}\n${older}\n`)).toThrow("capture line 2");
  });
});

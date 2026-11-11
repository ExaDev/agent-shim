import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { MAX_LOGGED_TOOLS, editingHttpRequest } from "./httpRequestEdits";
import { MAX_LOGGED_TEXT_CHARS } from "./loggedText";
import { MESSAGES_BODY_LIMIT_BYTES } from "./messagesBodyLimit";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
/** The documented maximum request size of the Messages endpoint, in MiB (the larger reading of the page's MB). */
const DOCUMENTED_MESSAGES_LIMIT_MIB = 128;
const MANY_TOOLS = 2000;
const NAME_BYTES = 1024;
/** Chunks of an error answer longer than the held-answer bound, and their size. */
const ERROR_CHUNKS = 40;
const ERROR_CHUNK_BYTES = 4096;

function requestOf(body: Buffer, url = "/v1/messages", method = "POST"): RoutedRequest {
  return { method, url, headers: {}, body: Readable.from([body]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
}

function recording(): { readonly response: RoutedResponse; readonly status: () => number | undefined; readonly text: () => string; readonly writes: () => number } {
  let status: number | undefined;
  const chunks: Buffer[] = [];
  return {
    response: {
      headersSent: false,
      start: (code) => {
        status = code;
      },
      flush: () => undefined,
      write: async (chunk) => {
        chunks.push(Buffer.from(chunk));
        await Promise.resolve();
      },
      end: () => undefined,
      destroy: () => undefined,
    },
    status: () => status,
    text: () => Buffer.concat(chunks).toString("utf8"),
    writes: () => chunks.length,
  };
}

/** A route over a provider with `serverTools: drop` that records the bytes of the body it was handed, and the log lines. */
function dropping(inner?: FrontDoorRoute["serve"], mode: "drop" | "forward" = "drop"): { readonly route: FrontDoorRoute; readonly received: () => Buffer | undefined; readonly logs: string[] } {
  let received: Buffer | undefined;
  const logs: string[] = [];
  const base: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve:
      inner ??
      (async (served) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        received = Buffer.concat(chunks);
      }),
  };
  const route = editingHttpRequest(base, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1", serverTools: mode },
    served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    droppedLogged: new Set<string>(),
    droppedLoggedLimit: 1,
    log: (line) => {
      logs.push(line);
    },
    bodyLimitBytes: MESSAGES_BODY_LIMIT_BYTES,
  });
  return { route, received: () => received, logs };
}

/** Bytes that are no UTF-8 text: a lone continuation byte, an invalid lead byte and a truncated sequence. */
/** The first printable code point: everything below it is a control character. */
const SPACE_CODE_POINT = " ".codePointAt(0) ?? 0;

const NOT_UTF8 = Buffer.from("ff fe c3 28".replaceAll(" ", ""), "hex");

const CLIENT_TOOL = '{"name":"edit","input_schema":{"type":"object"}}';
const SERVER_TOOL = '{"type":"web_search_20250305","name":"web_search"}';

describe("serverTools drop leaves every byte it is not removing as it arrived", () => {
  it("forwards a body that is not UTF-8 byte for byte", async () => {
    const { route, received } = dropping();
    const body = Buffer.concat([Buffer.from('{"model":"m","note":"'), NOT_UTF8, Buffer.from('","tools":[]}')]);
    await route.serve(requestOf(body), recording().response);
    expect(received()?.equals(body)).toBe(true);
  });

  it("forwards a body with nothing to drop byte for byte, numbers a re-serialisation would change included", async () => {
    const { route, received } = dropping();
    const body = Buffer.from(`{"model":"m","tools":[${CLIENT_TOOL}],"messages":[{"role":"assistant","content":[{"type":"tool_use","input":{"big":12345678901234567890,"f":1.0,"e":1e400}}]}]}`);
    await route.serve(requestOf(body), recording().response);
    expect(received()?.equals(body)).toBe(true);
  });

  it("removes only the server tool's span, the rest of the body (big numbers, spacing, non-UTF-8 bytes) untouched", async () => {
    const { route, received } = dropping();
    const before = Buffer.from(`{ "big":12345678901234567890,"f":1.0, "tools" : [ ${CLIENT_TOOL} , ${SERVER_TOOL} ] ,"note":"`);
    const after = Buffer.from('","tail":1e400}');
    await route.serve(requestOf(Buffer.concat([before, NOT_UTF8, after])), recording().response);
    const expected = Buffer.concat([Buffer.from(`{ "big":12345678901234567890,"f":1.0, "tools" : [ ${CLIENT_TOOL}  ] ,"note":"`), NOT_UTF8, after]);
    expect(received()?.toString("latin1")).toBe(expected.toString("latin1"));
  });

  it("removes the tools field and a tool_choice when no client tool is left, and a tool_choice that names a removed tool", async () => {
    const none = dropping();
    await none.route.serve(requestOf(Buffer.from(`{"model":"m","tools":[${SERVER_TOOL}],"tool_choice":{"type":"auto"},"max_tokens":5}`)), recording().response);
    expect(none.received()?.toString()).toBe('{"model":"m","max_tokens":5}');
    const named = dropping();
    await named.route.serve(requestOf(Buffer.from(`{"tools":[${CLIENT_TOOL},${SERVER_TOOL}],"tool_choice":{"type":"tool","name":"web_search"},"model":"m"}`)), recording().response);
    expect(named.received()?.toString()).toBe(`{"tools":[${CLIENT_TOOL}],"model":"m"}`);
    const kept = dropping();
    await kept.route.serve(requestOf(Buffer.from(`{"tools":[${CLIENT_TOOL},${SERVER_TOOL}],"tool_choice":{"type":"tool","name":"edit"},"model":"m"}`)), recording().response);
    expect(kept.received()?.toString()).toBe(`{"tools":[${CLIENT_TOOL}],"tool_choice":{"type":"tool","name":"edit"},"model":"m"}`);
  });

  it.each([
    ["every other tool of several", `{"model":"m","tools":[${SERVER_TOOL},${CLIENT_TOOL},${SERVER_TOOL},${CLIENT_TOOL},${SERVER_TOOL}]}`, `{"model":"m","tools":[${CLIENT_TOOL},${CLIENT_TOOL}]}`],
    ["a tools member and a tool_choice before a kept member", `{"tools":[${SERVER_TOOL}],"tool_choice":{"type":"auto"},"model":"m"}`, '{"model":"m"}'],
    ["a tools member and a tool_choice that end the object", `{"model":"m","tools":[${SERVER_TOOL}],"tool_choice":{"type":"auto"}}`, '{"model":"m"}'],
    ["the only member", `{"tools":[${SERVER_TOOL}]}`, "{}"],
  ])("removes %s and nothing else", async (_label, body, expected) => {
    const { route, received } = dropping();
    await route.serve(requestOf(Buffer.from(body)), recording().response);
    expect(received()?.toString()).toBe(expected);
  });

  it("refuses a body naming tools twice, forwarding nothing", async () => {
    const { route, received } = dropping();
    const answered = recording();
    await route.serve(requestOf(Buffer.from(`{"tools":[${SERVER_TOOL}],"tools":[],"model":"m"}`)), answered.response);
    expect(answered.status()).toBe(HTTP_STATUS.badRequest);
    expect(received()).toBeUndefined();
  });

  it("forwards a body naming tools twice as it came when serverTools is not drop, since nothing is edited", async () => {
    const { route, received } = dropping(undefined, "forward");
    const body = Buffer.from(`{"tools":[${SERVER_TOOL}],"tools":[],"model":"m"}`);
    await route.serve(requestOf(body), recording().response);
    expect(received()?.equals(body)).toBe(true);
  });

  it.each([["a model list", "/v1/models", "GET"], ["a batch", "/v1/messages/batches", "POST"], ["a Messages path read with another method", "/v1/messages", "GET"]])("passes %s unread", async (_label, url, method) => {
    let served = 0;
    const { route } = dropping(async () => {
      served += 1;
      await Promise.resolve();
    });
    const pending = new Readable({ read: () => undefined });
    await route.serve({ ...requestOf(Buffer.alloc(0), url, method), body: pending }, recording().response);
    expect(served).toBe(1);
  });
});

describe("one decision for every shape of model field, in both modes", () => {
  /** What each body should get, whatever serverTools says: a refusal, or the bytes it came as (a body whose first field is not auto is never rewritten, and the model auto is not rewritten here without a served model to rewrite it to). */
  const BODIES: readonly (readonly [label: string, body: string, outcome: "refused" | "as it came"])[] = [
    ["a first field that names auto, then another", '{"model":"auto","pad":1,"model":"x"}', "refused"],
    ["a first field that names another model, then auto", '{"model":"x","pad":1,"model":"auto"}', "as it came"],
    ["a first field that names another model, and no auto", '{"model":"x","pad":1}', "as it came"],
    ["a doubled field that names two other models", '{"model":"x","model":"y"}', "as it came"],
    ["a member that is no key, after a model that names auto", '{"model":"auto",garbage,"tools":[]}', "refused"],
    ["a member that is no key, after another model", '{"model":"m",garbage,"tools":[]}', "as it came"],
    ["a missing closing brace, after a model that names auto", '{"model":"auto","max_tokens":5', "refused"],
  ];
  const cases = BODIES.flatMap(([label, body, outcome]) => (["drop", "forward"] as const).map((mode) => ({ label, body, outcome, mode })));
  it.each(cases)("$outcome: $label, under serverTools $mode", async ({ body, outcome, mode }) => {
    // The wrapper has no served model here, so a body it would rewrite is refused too: what is pinned is that both modes agree.
    const { route, received } = dropping(undefined, mode);
    const answered = recording();
    const bytes = Buffer.from(body);
    await route.serve(requestOf(bytes), answered.response);
    if (outcome === "refused") {
      expect(answered.status()).toBe(HTTP_STATUS.badRequest);
      expect(received()).toBeUndefined();
    } else {
      expect(answered.status()).toBeUndefined();
      expect(received()?.equals(bytes)).toBe(true);
    }
  });
});

describe("the record of dropped tools", () => {
  it("names a bounded number of tools, each cut and quoted, for any number of tools of any name length", async () => {
    const { route, logs } = dropping();
    const tools = Array.from({ length: MANY_TOOLS }, (_unused, index) => `{"type":"t${String(index)}","name":"${"n".repeat(NAME_BYTES)}"}`);
    await route.serve(requestOf(Buffer.from(`{"model":"m","tools":[${tools.join(",")}]}`)), recording().response);
    expect(logs).toHaveLength(1);
    const line = logs[0] ?? "";
    expect(line).toContain(`and ${String(MANY_TOOLS - MAX_LOGGED_TOOLS)} more`);
    expect(line.length).toBeLessThan(MAX_LOGGED_TOOLS * (MAX_LOGGED_TEXT_CHARS + "\"\", ".length) + line.indexOf(":") + "and  more".length + String(MANY_TOOLS).length + MAX_LOGGED_TEXT_CHARS);
  });

  it("keeps a control character in a name inside one line", async () => {
    const { route, logs } = dropping();
    await route.serve(requestOf(Buffer.from('{"model":"m","tools":[{"type":"x","name":"a\\nb\\u001b[31m"}]}')), recording().response);
    expect(logs).toHaveLength(1);
    expect(Buffer.from(logs[0] ?? "", "utf8").every((byte) => byte >= SPACE_CODE_POINT)).toBe(true);
  });
});

describe("an error answer on the auto path", () => {
  it("is streamed through once it passes the held-answer bound, not buffered whole", async () => {
    const answered = recording();
    let writesWhenInnerEnded = 0;
    const { route } = dropping(async (_served, response) => {
      response.start(HTTP_STATUS.badRequest, {});
      for (let index = 0; index < ERROR_CHUNKS; index += 1) {
        await response.write(Buffer.alloc(ERROR_CHUNK_BYTES, "x"));
      }
      writesWhenInnerEnded = answered.writes();
      response.end();
    });
    await route.serve(requestOf(Buffer.from('{"model":"auto"}')), answered.response);
    expect(answered.status()).toBe(HTTP_STATUS.badRequest);
    expect(writesWhenInnerEnded).toBeGreaterThan(0);
    expect(answered.text()).toHaveLength(ERROR_CHUNKS * ERROR_CHUNK_BYTES);
  });
});

describe("the body limit", () => {
  it("is the documented Messages maximum request size", () => {
    expect(MESSAGES_BODY_LIMIT_BYTES).toBe(DOCUMENTED_MESSAGES_LIMIT_MIB * BYTES_PER_MIB);
  });
});

describe("the dropped tools of one request, named in the log", () => {
  it.each([
    [MAX_LOGGED_TOOLS, false],
    [MAX_LOGGED_TOOLS + 1, true],
  ])("says how many more than the bound there were only when there were some (%i tools)", async (count, more) => {
    const { route, logs } = dropping();
    const tools = Array.from({ length: count }, (_unused, index) => `{"type":"t${String(index)}","name":"n${String(index)}"}`);
    await route.serve(requestOf(Buffer.from(`{"model":"m","tools":[${tools.join(",")}]}`)), recording().response);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(more ? "and 1 more" : "n15");
    expect(logs[0]).not.toContain(more ? "n16\"" : " more");
  });
});

describe("the content-length of a body the door changed", () => {
  it("is dropped whatever its case", async () => {
    const seen: RoutedRequest["headers"][] = [];
    const { route } = dropping(async (served) => {
      seen.push(served.headers);
      served.body.resume();
      await new Promise<void>((resolve) => {
        served.body.once("end", resolve);
      });
    });
    const body = '{"model":"m","tools":[{"type":"x","name":"a"}]}';
    await route.serve({ ...requestOf(Buffer.from(body)), headers: { "Content-Length": String(body.length), "x-kept": "1" } }, recording().response);
    expect(seen[0]).toEqual({ "x-kept": "1" });
  });
});

describe("a body no JSON parser accepts, with a tool_choice that is not JSON", () => {
  it("is edited when the same body is valid, so the test below could have failed", async () => {
    const { route, received } = dropping();
    await route.serve(requestOf(Buffer.from('{"model":"m","tools":[{"type":"web_search_20250305"}],"tool_choice":{"type":"auto"}}')), recording().response);
    expect(received()?.toString("utf8")).toBe('{"model":"m"}');
  });

  it.each([
    ["a leading zero", '"tool_choice":01'],
    ["a trailing comma", '"tool_choice":{"type":"auto",}'],
    ["a misspelt literal", '"tool_choice":[ull]'],
  ])("is forwarded as it came under drop, never edited into one a parser accepts (%s)", async (_label, choice) => {
    const { route, received } = dropping();
    const body = `{"model":"m","tools":[{"type":"web_search_20250305"}],${choice}}`;
    await route.serve(requestOf(Buffer.from(body)), recording().response);
    expect(received()?.toString("utf8")).toBe(body);
  });
});

describe("the model auto beside the removal of the last member, under drop", () => {
  it.each([
    ["the model first and the tools last", '{"model":"auto","tools":[{"type":"web_search_20250305"}]}', '{"model":"served"}'],
    ["the tools first and the model last", '{"tools":[{"type":"web_search_20250305"}],"model":"auto"}', '{"model":"served"}'],
    ["the model between members with the tools last", '{"a":1,"model":"auto","tools":[{"type":"web_search_20250305"}]}', '{"a":1,"model":"served"}'],
    ["the model last and the tools before it with a kept tool", '{"tools":[{"name":"k","input_schema":{}},{"type":"web_search_20250305"}],"model":"auto"}', '{"tools":[{"name":"k","input_schema":{}}],"model":"served"}'],
  ])("sends valid JSON with exactly the model replaced and the tools removed: %s", async (_label, body, expected) => {
    const { route, received } = dropping();
    await route.serve(requestOf(Buffer.from(body)), recording().response);
    const sent = received()?.toString("utf8") ?? "";
    expect(sent).toBe(expected);
    expect(() => {
      JSON.parse(sent);
    }).not.toThrow();
  });
});

describe("the model auto after a multi-byte character", () => {
  it("is replaced at its byte offset, so the bytes before it and after it are untouched", async () => {
    const { route, received } = dropping();
    const body = '{"note":"caf\u00e9 \u65e5\u672c \u{1f600}","model":"auto","tools":[{"type":"web_search_20250305"}]}';
    await route.serve(requestOf(Buffer.from(body, "utf8")), recording().response);
    expect(received()?.toString("utf8")).toBe('{"note":"caf\u00e9 \u65e5\u672c \u{1f600}","model":"served"}');
  });
});

describe("the model auto with server tools, on a provider that forwards them", () => {
  it("replaces the model alone and leaves every tool in the body", async () => {
    const { route, received } = dropping(undefined, "forward");
    const body = '{"model":"auto","tools":[{"type":"web_search_20250305"},{"name":"k","input_schema":{}}],"tool_choice":{"type":"auto"}}';
    await route.serve(requestOf(Buffer.from(body)), recording().response);
    expect(received()?.toString("utf8")).toBe(body.replace('"auto","tools"', '"served","tools"'));
  });
});

describe("the model auto in a body that opens with a UTF-8 byte order mark", () => {
  const MARK = Buffer.from("\uFEFF", "utf8");

  it.each([["drop" as const], ["forward" as const]])("is replaced like any other, the mark kept, under serverTools %s", async (mode) => {
    const { route, received } = dropping(undefined, mode);
    const body = '{"model":"auto","max_tokens":1}';
    await route.serve(requestOf(Buffer.concat([MARK, Buffer.from(body)])), recording().response);
    expect(received()).toEqual(Buffer.concat([MARK, Buffer.from(body.replace('"auto"', '"served"'))]));
  });

  it.each([["drop" as const], ["forward" as const]])("is refused with a 400 when the body names the model twice, under serverTools %s", async (mode) => {
    const { route, received } = dropping(undefined, mode);
    const answer = recording();
    await route.serve(requestOf(Buffer.concat([MARK, Buffer.from('{"model":"auto","model":"other"}')])), answer.response);
    expect(answer.status()).toBe(HTTP_STATUS.badRequest);
    expect(received()).toBeUndefined();
  });

  it.each([["drop" as const], ["forward" as const]])("leaves a body that names another model alone, byte for byte, under serverTools %s", async (mode) => {
    const { route, received } = dropping(undefined, mode);
    const body = Buffer.concat([MARK, Buffer.from('{"model":"claude-sonnet-5-5"}')]);
    await route.serve(requestOf(body), recording().response);
    expect(received()).toEqual(body);
  });
});

import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { editingHttpRequest } from "./httpRequestEdits";
import { MESSAGES_BODY_LIMIT_BYTES } from "./messagesBodyLimit";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import * as members from "./topLevelMembers";
import * as models from "./topLevelModel";

// The structural walks are counted, not timed: the work an edit costs is how many times it walks the body.
vi.mock("./topLevelModel", async (importOriginal) => {
  const actual = await importOriginal<typeof models>();
  return { ...actual, endOfString: vi.fn(actual.endOfString) };
});

const SERVER_TOOL = '{"type":"web_search_20250305","name":"web_search"}';
const CLIENT_TOOL = '{"name":"edit","input_schema":{"type":"object"}}';

function requestOf(body: string): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([Buffer.from(body)]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
}

const silent: RoutedResponse = { headersSent: false, start: () => undefined, flush: () => undefined, write: async () => { await Promise.resolve(); }, end: () => undefined, destroy: () => undefined };

function routeOver(serverTools: "drop" | undefined, keep = true): { readonly route: FrontDoorRoute; readonly received: () => string } {
  let received = "";
  const inner: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async (served) => {
      if (!keep) {
        served.body.resume();
        await once(served.body, "end");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of served.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      received = Buffer.concat(chunks).toString("utf8");
    },
  };
  const route = editingHttpRequest(inner, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1", ...(serverTools === undefined ? {} : { serverTools }) },
    served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    droppedLogged: new Set<string>(),
    droppedLoggedLimit: 1,
    log: () => undefined,
    bodyLimitBytes: MESSAGES_BODY_LIMIT_BYTES,
  });
  return { route, received: () => received };
}

/** A body whose messages are far larger than everything else, so a pass over the whole body costs far more than one over its tools. */
const FILLER_MESSAGES = 400;
const messagesOf = (count: number): string => Array.from({ length: count }, (_unused, index) => `{"role":"user","content":"turn ${String(index)}"}`).join(",");
const bodyOf = (model: string): string => `{"model":"${model}","messages":[${messagesOf(FILLER_MESSAGES)}],"tools":[${CLIENT_TOOL},${SERVER_TOOL}],"max_tokens":16}`;

/** The characters handed to `JSON.parse` and the strings the structural walk read, during `run`. */
async function measured(run: () => Promise<void>): Promise<{ readonly parsedChars: number; readonly strings: number }> {
  let parsedChars = 0;
  const parse = JSON.parse.bind(JSON);
  const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    parsedChars += text.length;
    return parse(text, reviver) as unknown;
  });
  vi.mocked(models.endOfString).mockClear();
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return { parsedChars, strings: vi.mocked(models.endOfString).mock.calls.length };
}

describe("the work a whole-body edit costs", () => {
  it.each([
    ["drop, tools to drop and the model auto", "drop" as const, "auto"],
    ["drop, tools to drop and another model", "drop" as const, "m"],
    ["forward, the model auto", undefined, "auto"],
  ])("reads the body's strings in one pass, and parses only the tools: %s", async (_label, serverTools, model) => {
    const body = bodyOf(model);
    // The reference: one structural walk over the body, and one over the tools array alone (under `drop`), which is all the planning re-reads.
    const reference = await measured(async () => {
      members.walkTopLevelMembers(body);
      if (serverTools === "drop") {
        const toolsAt = body.indexOf('"tools":[') + '"tools":'.length;
        members.arrayElements(body, toolsAt, body.indexOf("],", toolsAt) + 1);
      }
      await Promise.resolve();
    });
    const { route } = routeOver(serverTools);
    const edit = await measured(async () => {
      await route.serve(requestOf(body), silent);
    });
    // Equal, not at most: a second pass over the body, however it is made, adds strings read, and a parse of the body adds characters parsed.
    expect(edit.strings).toBe(reference.strings);
    expect(edit.parsedChars).toBeLessThan(body.length / 2);
  });

  it("walks nothing for a request that is not read whole", async () => {
    const { route, received } = routeOver(undefined);
    const body = bodyOf("m");
    const edit = await measured(async () => {
      await route.serve(requestOf(body), silent);
    });
    expect(edit.strings).toBe(0);
    expect(received()).toBe(body);
  });
});

/** What a request's own small allocations (header lines, the model name's quotes) may add to the counted copies. */
const SLACK_BYTES = 4096;

/** The bytes the edit path allocates for a body: the concatenations, copies and string conversions it makes, read from what each call returned. */
async function bytesAllocatedFor(run: () => Promise<void>): Promise<number> {
  const concat = vi.spyOn(Buffer, "concat");
  const from = vi.spyOn(Buffer, "from");
  const toString = vi.spyOn(Buffer.prototype, "toString");
  try {
    await run();
    const lengthOf = (value: unknown): number => (typeof value === "string" || value instanceof Uint8Array ? value.length : 0);
    return [concat, from, toString].reduce((total, spy) => total + spy.mock.results.reduce((sum, result) => sum + lengthOf(result.value), 0), 0);
  } finally {
    concat.mockRestore();
    from.mockRestore();
    toString.mockRestore();
  }
}

/** The copies of a body the edit path may hold at once: the bytes read, the one-byte-per-character view the walk reads, and the one output. */
const COPIES_OF_THE_BODY = 3;

describe("the memory an edit of a whole body costs", () => {
  it.each([
    ["drop, a server tool to remove", "drop" as const, "m"],
    ["drop, the model auto", "drop" as const, "auto"],
    ["forward, the model auto", undefined, "auto"],
  ])("allocates at most the bytes read, a view and one output: %s", async (_label, serverTools, model) => {
    const body = bodyOf(model);
    const { route } = routeOver(serverTools, false);
    const request = requestOf(body);
    const allocated = await bytesAllocatedFor(async () => {
      await route.serve(request, silent);
    });
    // The body's own bytes are the test's input and the stand-in route's read of the output is its own: what is counted is the edit path, which may allocate a few copies of the body and no more.
    expect(allocated).toBeLessThanOrEqual(COPIES_OF_THE_BODY * body.length + SLACK_BYTES);
  });
});

describe("tool_choice follows the tool the removal removed", () => {
  it("is kept when a kept tool shares the name of a removed one, and goes when only removed tools carry it", async () => {
    const shared = routeOver("drop");
    await shared.route.serve(requestOf(`{"model":"m","tools":[{"name":"x","input_schema":{}},{"type":"web","name":"x"}],"tool_choice":{"type":"tool","name":"x"}}`), silent);
    expect(shared.received()).toBe('{"model":"m","tools":[{"name":"x","input_schema":{}}],"tool_choice":{"type":"tool","name":"x"}}');
    const only = routeOver("drop");
    await only.route.serve(requestOf(`{"model":"m","tools":[{"name":"y","input_schema":{}},{"type":"web","name":"x"}],"tool_choice":{"type":"tool","name":"x"}}`), silent);
    expect(only.received()).toBe('{"model":"m","tools":[{"name":"y","input_schema":{}}]}');
  });
});

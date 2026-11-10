import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { withModel, withModelInHead } from "./mainLoopRoute";
import { scanRequestHead } from "./requestScan";
import type { RoutedRequest } from "./route";
import { topLevelModel } from "./topLevelModel";

/** Sizes in bytes: a chunk, how much of a large body is written before the scan settles (past its cap), the filler that puts the model beyond the head, and a body long enough to stream. */
const CHUNK = 16384;
const MESSAGES = 400;
const WRITTEN = 81920;
const LARGE_FILLER = 102400;
const STREAMED = 307200;

function requestOf(body: Readable): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers: { "content-length": "1" }, body, signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
}

async function textOf(request: RoutedRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Every body shape the top-level model field can sit in, with the name it has and where a rewrite must land. */
const BODIES: readonly { readonly name: string; readonly body: string; readonly model: string | undefined }[] = [
  { name: "first and plain", body: '{"model":"claude-sonnet-5-5","messages":[]}', model: "claude-sonnet-5-5" },
  { name: "after other fields", body: '{"max_tokens":5,"stream":false,"model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "with spaces around the colon", body: '{ "model" :  "claude-sonnet-5-5" }', model: "claude-sonnet-5-5" },
  { name: "after a nested model", body: '{"messages":[{"role":"user","model":"claude-haiku-5-5"}],"model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "after a nested object holding a model", body: '{"metadata":{"model":"claude-haiku-5-5","a":[{"model":"x"}]},"model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "only nested", body: '{"messages":[{"model":"claude-haiku-5-5"}]}', model: undefined },
  { name: "with braces in a string before it", body: '{"system":"a { b [ c } d ] \\" e","model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "with a string that looks like the pair before it", body: '{"system":"{\\"model\\":\\"claude-haiku-5-5\\"}","model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "with an escaped quote in its value", body: '{"model":"a\\"b"}', model: 'a\\"b' },
  { name: "as the value of another key", body: '{"x":"model","y":"claude-haiku-5-5","model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "not a string", body: '{"model":null,"messages":[]}', model: undefined },
  { name: "empty", body: '{"model":"","messages":[]}', model: undefined },
  { name: "in a body that is no object", body: '["model","claude-sonnet-5-5"]', model: undefined },
  { name: "in an array written like an object", body: '["model":"claude-sonnet-5-5"]', model: undefined },
  { name: "right after a key's string with no space", body: '{"a":"b","model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "right after a closing bracket with no space", body: '{"a":[],"model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "in a body that is no JSON", body: 'model: "claude-sonnet-5-5"', model: undefined },
  { name: "multi-byte text before it", body: '{"system":"héllo wörld 日本語","model":"claude-sonnet-5-5"}', model: "claude-sonnet-5-5" },
  { name: "after a large messages array", body: `{"messages":[${Array.from({ length: MESSAGES }, () => '{"role":"user","content":"hello world"}').join(",")}],"model":"claude-sonnet-5-5"}`, model: "claude-sonnet-5-5" },
];

describe("the top-level model field of a request body", () => {
  it.each(BODIES)("is found, or not, in a body with the model $name", ({ body, model }) => {
    expect(topLevelModel(body)?.value).toBe(model);
  });

  it("is located by offsets that cut exactly the value's quoted string, in the text it was found in", () => {
    for (const { body, model } of BODIES) {
      const found = topLevelModel(body);
      if (model === undefined) {
        expect(found).toBeUndefined();
        continue;
      }
      expect(found).toBeDefined();
      expect(body.slice(found?.start, found?.end)).toBe(`"${model}"`);
    }
  });
});

describe("scanning a body for its model", () => {
  it.each(BODIES)("reads the same name in a body with the model $name", async ({ body, model }) => {
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(scan.model).toBe(model);
  });

  it("reads a model that arrives after the first chunk, whichever way the chunks split the body", async () => {
    const body = '{"messages":[{"model":"claude-haiku-5-5"}],"model":"claude-sonnet-5-5"}';
    for (let cut = 1; cut < body.length; cut += 1) {
      const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body.slice(0, cut)), Buffer.from(body.slice(cut))])));
      expect(scan.model, `cut at ${String(cut)}`).toBe("claude-sonnet-5-5");
    }
  });

  it("finds no model beyond the head, and settles at the cap without waiting for the rest of a large body", async () => {
    const body = `{"system":"${"x".repeat(LARGE_FILLER)}","model":"claude-sonnet-5-5"}`;
    const stream = new PassThrough();
    const scanning = scanRequestHead(requestOf(stream));
    for (let offset = 0; offset < WRITTEN; offset += CHUNK) {
      stream.write(Buffer.from(body.slice(offset, offset + CHUNK)));
    }
    const scan = await scanning;
    expect(scan.model).toBeUndefined();
    expect(scan.headBytes).toBeLessThan(body.length);
    stream.end(Buffer.from(body.slice(WRITTEN)));
    expect(await textOf(scan.replayed ?? requestOf(stream))).toBe(body);
  });

  it("streams a 300 KB body through unread past the head, byte for byte", async () => {
    const body = `{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"${"y".repeat(STREAMED)}"}]}`;
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(scan.model).toBe("claude-sonnet-5-5");
    expect(await textOf(scan.replayed ?? requestOf(Readable.from([])))).toBe(body);
  });
});

describe("rewriting the model field", () => {
  const CASES = BODIES.filter((entry) => entry.model !== undefined);

  it.each(CASES)("changes only the top-level field of a body with the model $name, in the head", async ({ body, model }) => {
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    const request = scan.replayed ?? requestOf(Readable.from([Buffer.from(body)]));
    const rewritten = await textOf(withModelInHead(request, scan.headBytes, model ?? "", "glm-4.5-air"));
    const found = topLevelModel(rewritten);
    expect(found?.value).toBe("glm-4.5-air");
    // Every other byte is as it was: the same text with the one quoted value swapped.
    const before = topLevelModel(body);
    expect(rewritten).toBe(`${body.slice(0, before?.start)}"glm-4.5-air"${body.slice(before?.end)}`);
  });

  it.each(CASES)("changes only the top-level field of a body with the model $name, in the whole text", async ({ body, model }) => {
    const rewritten = await textOf(withModel(requestOf(Readable.from([])), body, model ?? "", "glm-4.5-air"));
    const before = topLevelModel(body);
    expect(rewritten).toBe(`${body.slice(0, before?.start)}"glm-4.5-air"${body.slice(before?.end)}`);
  });

  it("leaves a body with no top-level model alone, though a nested one names the very name asked to change", async () => {
    const body = '{"messages":[{"model":"claude-haiku-5-5"}]}';
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(await textOf(withModelInHead(scan.replayed ?? requestOf(Readable.from([])), scan.headBytes, "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
    expect(await textOf(withModel(requestOf(Readable.from([])), body, "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
  });

  it("leaves a body alone when the name asked to change is not the top-level field's", async () => {
    const body = '{"model":"claude-sonnet-5-5","messages":[]}';
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(await textOf(withModelInHead(scan.replayed ?? requestOf(Readable.from([])), scan.headBytes, "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
    expect(await textOf(withModel(requestOf(Readable.from([])), body, "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
  });

  it("rewrites a name that is not valid JSON text of its own, as a JSON string, whatever the replacement holds", async () => {
    const body = '{"model":"claude-sonnet-5-5"}';
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    const out = await textOf(withModelInHead(scan.replayed ?? requestOf(Readable.from([])), scan.headBytes, "claude-sonnet-5-5", 'a"b\\c$&'));
    expect(JSON.parse(out)).toEqual({ model: 'a"b\\c$&' });
  });
});

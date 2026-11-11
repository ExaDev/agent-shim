import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { withModel, withModelInHead } from "./mainLoopRoute";
import { scanRequestHead } from "./requestScan";
import type { RoutedRequest } from "./route";
import { hasSeveralTopLevelModels, topLevelModel, topLevelModels, walkAllTopLevelModels, walkFirstTopLevelModel } from "./topLevelModel";

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
  { name: "with an escaped quote in its value", body: '{"model":"a\\"b"}', model: 'a"b' },
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
    expect(topLevelModel(body)?.decoded).toBe(model);
  });

  it("is located by offsets that cut exactly the value's quoted string, in the text it was found in", () => {
    for (const { body, model } of BODIES) {
      const found = topLevelModel(body);
      if (model === undefined) {
        expect(found).toBeUndefined();
        continue;
      }
      expect(found).toBeDefined();
      // The span is the source spelling, which decodes to the name: that is how a rewrite and a decision agree.
      expect(JSON.parse(body.slice(found?.start, found?.end))).toBe(model);
    }
  });
});

describe("a body with more than one top-level model key, whatever their values", () => {
  const VALUES = ["null", "7", '""', "true", '{"id":"x"}', '["x"]', '"other"'];

  it.each(VALUES)("is several when the second is %s", (value) => {
    expect(hasSeveralTopLevelModels(`{"model":"auto","model":${value}}`)).toBe(true);
    expect(walkAllTopLevelModels(`{"model":"auto","model":${value}}`).keys).toBe(2);
  });

  it.each(VALUES)("is several when the first is %s", (value) => {
    expect(hasSeveralTopLevelModels(`{"model":${value},"model":"auto"}`)).toBe(true);
  });

  it("counts a key spelt with an escape, and leaves out a nested one and one that is no key", () => {
    expect(hasSeveralTopLevelModels('{"model":"a","mod\\u0065l":null}')).toBe(true);
    expect(hasSeveralTopLevelModels('{"model":"a","messages":[{"model":"b"}],"note":"\\"model\\":1"}')).toBe(false);
  });

  it("is not several with one, of any value", () => {
    for (const value of VALUES) {
      expect(hasSeveralTopLevelModels(`{"model":${value}}`)).toBe(false);
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
    expect(await textOf(scan.replayed)).toBe(body);
  });

  it("streams a 300 KB body through unread past the head, byte for byte", async () => {
    const body = `{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"${"y".repeat(STREAMED)}"}]}`;
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(scan.model).toBe("claude-sonnet-5-5");
    expect(await textOf(scan.replayed)).toBe(body);
  });
});

describe("rewriting the model field", () => {
  const CASES = BODIES.filter((entry) => entry.model !== undefined);

  it.each(CASES)("changes only the top-level field of a body with the model $name, in the head", async ({ body, model }) => {
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    const request = scan.replayed;
    const rewritten = await textOf(withModelInHead(request, scan.headBytes, model ?? "", "glm-4.5-air"));
    const found = topLevelModel(rewritten);
    expect(found?.decoded).toBe("glm-4.5-air");
    // Every other byte is as it was: the same text with the one quoted value swapped.
    const before = topLevelModel(body);
    expect(rewritten).toBe(`${body.slice(0, before?.start)}"glm-4.5-air"${body.slice(before?.end)}`);
  });

  it.each(CASES)("changes only the top-level field of a body with the model $name, in the whole text", async ({ body, model }) => {
    const rewritten = await textOf(withModel(requestOf(Readable.from([])), Buffer.from(body), model ?? "", "glm-4.5-air"));
    const before = topLevelModel(body);
    expect(rewritten).toBe(`${body.slice(0, before?.start)}"glm-4.5-air"${body.slice(before?.end)}`);
  });

  it("leaves a body with no top-level model alone, though a nested one names the very name asked to change", async () => {
    const body = '{"messages":[{"model":"claude-haiku-5-5"}]}';
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(await textOf(withModelInHead(scan.replayed, scan.headBytes, "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
    expect(await textOf(withModel(requestOf(Readable.from([])), Buffer.from(body), "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
  });

  it("leaves a body alone when the name asked to change is not the top-level field's", async () => {
    const body = '{"model":"claude-sonnet-5-5","messages":[]}';
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    expect(await textOf(withModelInHead(scan.replayed, scan.headBytes, "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
    expect(await textOf(withModel(requestOf(Readable.from([])), Buffer.from(body), "claude-haiku-5-5", "glm-4.5-air"))).toBe(body);
  });

  it("rewrites a name that is not valid JSON text of its own, as a JSON string, whatever the replacement holds", async () => {
    const body = '{"model":"claude-sonnet-5-5"}';
    const scan = await scanRequestHead(requestOf(Readable.from([Buffer.from(body)])));
    const out = await textOf(withModelInHead(scan.replayed, scan.headBytes, "claude-sonnet-5-5", 'a"b\\c$&'));
    expect(JSON.parse(out)).toEqual({ model: 'a"b\\c$&' });
  });
});

describe("the top-level model field as a request edit reads it", () => {
  it("finds the value of the top-level key, however the body spells its numbers, strings and spacing", () => {
    const body = '{ "max_tokens":16 ,"big":12345678901234567890,"f":1.0,"s":"a\\u00e9\\n\\"model\\":\\"x\\"","nested":{"model":"inner"},  "model" : "auto" ,"messages":[{"model":"deep"}]}';
    expect(topLevelModel(body)?.decoded).toBe("auto");
  });

  it("matches a key spelled with an escape", () => {
    expect(topLevelModel('{"mod\\u0065l":"auto"}')?.decoded).toBe("auto");
  });

  it("finds nothing when the top level has no model string, or the body is not an object", () => {
    expect(topLevelModel('{"nested":{"model":"auto"}}')).toBeUndefined();
    expect(topLevelModel('{"model":5}')).toBeUndefined();
    expect(topLevelModel('["model","auto"]')).toBeUndefined();
    expect(topLevelModel('{"model":"unterminated')).toBeUndefined();
    expect(topLevelModel("")).toBeUndefined();
  });
});

describe("every top-level model field of a body", () => {
  it("lists each in order, with the name it decodes to", () => {
    const body = '{"model":"auto","messages":[{"model":"nested"}],"mod\\u0065l":"a\\"b"}';
    expect(topLevelModels(body).map((field) => field.decoded)).toEqual(["auto", 'a"b']);
  });

  it("lists a duplicated key in order, and skips nested ones", () => {
    expect(topLevelModels('{"model":"a","x":{"model":"n"},"model":"b"}').map((span) => span.decoded)).toEqual(["a", "b"]);
  });

  it("lists none for a body that is no object, and the first of several as the one model", () => {
    expect(topLevelModels('["model","auto"]')).toEqual([]);
    expect(topLevelModel('{"model":"first","model":"second"}')?.decoded).toBe("first");
  });
});

describe("the work a model walk costs", () => {
  it("stops the first-only walk at the first field, however long the body behind it, while the all-fields walk reads on", () => {
    const head = '{"model":"m","messages":[';
    const text = `${head}${'{"role":"user","content":"x"},'.repeat(MESSAGES)}{}],"model":"second"}`;
    expect(walkFirstTopLevelModel(text).walked).toBe('{"model":"m"'.length);
    expect(walkFirstTopLevelModel(text).models).toHaveLength(1);
    expect(walkAllTopLevelModels(text).walked).toBe(text.lastIndexOf("}"));
    expect(walkAllTopLevelModels(text).models).toHaveLength(2);
  });
});

describe("a whole-text rewrite keeps the bytes it does not change", () => {
  it("leaves bytes that are not UTF-8 as they came, as the wrapper does", async () => {
    const bytes = Buffer.concat([Buffer.from('{"note":"'), Buffer.from("ff fe c3 28".replaceAll(" ", ""), "hex"), Buffer.from('","model":"claude-haiku-5-5"}')]);
    const rewritten = withModel(requestOf(Readable.from([])), bytes, "claude-haiku-5-5", "glm-4.5-air");
    const chunks: Buffer[] = [];
    for await (const chunk of rewritten.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const expected = Buffer.concat([bytes.subarray(0, bytes.indexOf('"claude-haiku-5-5"')), Buffer.from('"glm-4.5-air"'), Buffer.from("}")]);
    expect(Buffer.concat(chunks).equals(expected)).toBe(true);
  });
});

describe("the whitespace the walk skips between tokens", () => {
  it.each([[" "], ["\t"], ["\n"], ["\r"]])("is %j before and after the key, the colon and the value", (space) => {
    const text = `{${space}"model"${space}:${space}"m"${space}}`;
    expect(topLevelModel(text)?.decoded).toBe("m");
  });
});

describe("a body that opens with a byte order mark", () => {
  const MARKS = [["the decoded text", "\uFEFF"], ["the bytes viewed one character each", "\u00EF\u00BB\u00BF"]] as const;

  it.each(MARKS)("has its model found in %s, after the mark and any whitespace, at its own offsets", (_label, mark) => {
    const body = `${mark} \n{"model":"auto"}`;
    const found = topLevelModel(body);
    expect(found?.decoded).toBe("auto");
    expect(found === undefined ? undefined : body.slice(found.start, found.end)).toBe('"auto"');
    expect(topLevelModels(`${mark}{"model":"auto","model":"x"}`).map((model) => model.decoded)).toEqual(["auto", "x"]);
  });

  it("is no object when the mark is followed by something else, and a mark that is not the first character is no mark", () => {
    expect(topLevelModel("\uFEFF[1]")).toBeUndefined();
    expect(topLevelModel('x\uFEFF{"model":"auto"}')).toBeUndefined();
    // A mark further in does not move the start of the body: this one is no object, though skipping a character would land on a brace.
    expect(topLevelModel('x{"model":"auto"}\uFEFF')).toBeUndefined();
    expect(topLevelModel(' \n\uFEFF{"model":"auto"}')).toBeUndefined();
    expect(topLevelModel(' \n{"model":"auto"}')?.decoded).toBe("auto");
  });
});

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { HAIKU_NAME, send, startWorld, tokenOf, type World } from "./mainLoopRouteTestWorld";
import { AUTH_HEADER, SESSION_HEADER } from "./route";

/** A body naming its model twice, as a client that wants a server's last-wins parse to read another model than the door rewrote would send. */
const twice = (first: string): string => `{"model":"${first}","model":"other","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`;

/** The calls of `withModel` in `providerRoute.ts` (the name-resolving scan and the routes list) and of `withModelInHead` in `mainLoopRoute.ts` (the Anthropic way back, the tier mapping and the renaming of a selector or an overridden name), each of which has a row above. */
const PROVIDER_ROUTE_CALLS = 2;
const MAIN_LOOP_CALLS = 3;

interface Site {
  /** Where the rewrite is made: the file and the call it uses. */
  readonly rewrite: string;
  readonly drive: (world: World) => Promise<{ readonly status: number; readonly text: string }>;
}

/** A Claude name the worlds below override to provider `z`, which no other row names. */
const OVERRIDDEN = "claude-opus-5-1";

/** Puts the session's main loop on provider `z`, then sends the request of the site. */
const underZ = async (world: World, request: Parameters<typeof send>[1]): ReturnType<typeof send> => {
  await send(world, { model: "z/glm-5.3", requestClass: "main" });
  return await send(world, request);
};

/**
 * Every place the door rewrites a request's model field, each driven with a body naming the model twice. A site added without the refusal fails its own row, and a call of a rewrite function with no row here fails the count below.
 */
const SITES: Readonly<Record<string, Site>> = {
  "a bare provider name": { rewrite: "providerRoute.ts: withModel", drive: async (world) => await send(world, { model: "", rawBody: twice("spark"), requestClass: "main" }) },
  "a provider-qualified name": { rewrite: "providerRoute.ts: withModel", drive: async (world) => await send(world, { model: "", rawBody: twice("spark/chosen"), requestClass: "main" }) },
  "a route's model rewrite": { rewrite: "providerRoute.ts: withModel", drive: async (world) => await send(world, { model: "", rawBody: twice("claude-sonnet-4-5"), provider: "rw" }) },
  "the main loop's Claude name under a provider context": { rewrite: "mainLoopRoute.ts: withModelInHead", drive: async (world) => await underZ(world, { model: "", rawBody: twice("claude-opus-5-5"), requestClass: "main" }) },
  "a helper's Claude name under a provider context": { rewrite: "mainLoopRoute.ts: withModelInHead", drive: async (world) => await underZ(world, { model: "", rawBody: twice(HAIKU_NAME), requestClass: "auxiliary" }) },
  "the main loop's anthropic/ name": { rewrite: "mainLoopRoute.ts: withModelInHead", drive: async (world) => await underZ(world, { model: "", rawBody: twice("anthropic/claude-opus-5-5"), requestClass: "main" }) },
  "a route override's target": { rewrite: "mainLoopRoute.ts: withModelInHead", drive: async (world) => await send(world, { model: "", rawBody: twice(OVERRIDDEN), requestClass: "main" }) },
  "a selector's expansion": { rewrite: "mainLoopRoute.ts: withModelInHead", drive: async (world) => await send(world, { model: "", rawBody: twice("auto/provider:z/sonnet"), requestClass: "main" }) },
  "a helper's anthropic/ name": { rewrite: "mainLoopRoute.ts: withModelInHead", drive: async (world) => await underZ(world, { model: "", rawBody: twice("anthropic/claude-haiku-5-5"), requestClass: "auxiliary" }) },
};

/** Chunk sizes, in bytes, the doubled-field decision is checked under: one byte at a time, a few bytes and a block. */
const ONE_BYTE = 1;
const FEW_BYTES = 7;
const A_BLOCK = 64;
const CHUNK_SIZES = [ONE_BYTE, FEW_BYTES, A_BLOCK] as const;

/** Sends a body to the door in chunks of `chunkBytes`, as a client that frames it that way would, and answers with what came back. */
async function sendChunked(world: World, body: string, chunkBytes: number, requestClass: string): Promise<{ readonly status: number; readonly text: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request(`${world.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: tokenOf("s-1"), [SESSION_HEADER]: "s-1", "x-claude-code-request-class": requestClass, "transfer-encoding": "chunked" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, text });
      });
    });
    request.on("error", reject);
    for (let at = 0; at < body.length; at += chunkBytes) {
      request.write(body.slice(at, at + chunkBytes));
    }
    request.end();
  });
}

describe("a doubled model field gets the same decision however the client chunks the body", () => {
  it.each([
    ["the main loop's Claude name", "claude-opus-5-5", "main"],
    ["a helper's anthropic/ name", "anthropic/claude-haiku-5-5", "auxiliary"],
  ])("at the head sites: %s", async (_label, name, requestClass) => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions());
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      const decisions = await Promise.all([...CHUNK_SIZES, twice(name).length].map(async (chunk) => (await sendChunked(world, twice(name), chunk, requestClass)).status));
      expect(new Set(decisions)).toEqual(new Set([HTTP_STATUS.badRequest]));
    } finally {
      await world.close();
    }
  });
});

describe("every rewrite of the model field refuses a body that names it twice", () => {
  it.each(Object.entries(SITES))("refuses %s with the 400, forwarding nothing", async (_name, site) => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), undefined, undefined, undefined, undefined, { routeOverrides: () => ({ table: { schemaVersion: 1, global: { [OVERRIDDEN]: "z/glm-5.3" } } }) });
    try {
      world.setProvider("spark", { displayName: "Spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" } });
      world.setProvider("rw", { displayName: "Rw", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*sonnet.*" } }, provider: "z", model: "glm-9" }] });
      const before = world.upstream.seen.length;
      const answered = await site.drive(world);
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("more than one top-level model field");
      // `underZ` made one served request first; nothing the site sent after it reached an upstream or the Anthropic stand-in.
      expect(world.upstream.seen.length - before).toBeLessThanOrEqual(1);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("has a row for every call of a rewrite function", () => {
    const calls = (file: string, name: string): number => {
      const text = fs.readFileSync(path.join(__dirname, file), "utf8");
      return [...text.matchAll(new RegExp(`(?<![A-Za-z.])${name}\\(`, "g"))].length - [...text.matchAll(new RegExp(`function ${name}\\(`, "g"))].length;
    };
    const rows = (rewrite: string): number => Object.values(SITES).filter((site) => site.rewrite === rewrite).length;
    // A call site may serve several rows (the helper and the main loop share one), but a call with no row is an undriven site: it fails here until a row for it is added.
    expect(calls("providerRoute.ts", "withModel")).toBe(PROVIDER_ROUTE_CALLS);
    expect(calls("mainLoopRoute.ts", "withModelInHead")).toBe(MAIN_LOOP_CALLS);
    expect(rows("providerRoute.ts: withModel")).toBeGreaterThanOrEqual(PROVIDER_ROUTE_CALLS);
    expect(rows("mainLoopRoute.ts: withModelInHead")).toBeGreaterThanOrEqual(MAIN_LOOP_CALLS);
  });
});

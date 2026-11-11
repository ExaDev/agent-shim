import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOGUE_BODY_LIMIT_BYTES } from "./providerCatalogue";
import { realCatalogueFetch } from "./realCatalogueRefresh";

const REDIRECT_STATUS = 302;
const SECONDS = 5;
const MS_PER_SECOND = 1000;
/** The status a redirect answers with. */
const FOUND_STATUS = 302;
const TIMEOUT_MS = SECONDS * MS_PER_SECOND;
const OK = 200;
/** The UTF-8 byte order mark, as the bytes `EF BB BF`. */
const BYTE_ORDER_MARK = "efbbbf";
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve(undefined);
        });
      });
    }),
  );
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${String((server.address() satisfies AddressInfo | string | null as AddressInfo).port)}`;
}

describe("the live model-list read", () => {
  it("never follows a redirect, so the provider's credential reaches no second origin", async () => {
    const seenByOther: http.IncomingHttpHeaders[] = [];
    const other = await listen((request, response) => {
      seenByOther.push(request.headers);
      response.end("{}");
    });
    const provider = await listen((_request, response) => {
      response.writeHead(REDIRECT_STATUS, { location: `${other}/v1/models` });
      response.end();
    });
    const answered = await realCatalogueFetch(`${provider}/v1/models`, { "x-api-key": "provider-secret" }, TIMEOUT_MS);
    expect(answered.status).toBe(REDIRECT_STATUS);
    expect(seenByOther).toEqual([]);
  });

  it("refuses a body past the limit a model list can have, instead of buffering it", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(OK, { "content-type": "application/json" });
      response.end(Buffer.alloc(CATALOGUE_BODY_LIMIT_BYTES + 1, "a"));
    });
    await expect(realCatalogueFetch(`${url}/v1/models`, {}, TIMEOUT_MS)).rejects.toThrow(/limit/);
  });

  it("reads a list of exactly the limit, and refuses one a byte over it", async () => {
    const prefix = '{"data":[{"id":"m"}],"pad":"';
    const suffix = '"}';
    const padded = (bytes: number): Buffer => Buffer.from(`${prefix}${"a".repeat(bytes - prefix.length - suffix.length)}${suffix}`);
    const url = await listen((request, response) => {
      response.writeHead(OK, { "content-type": "application/json" });
      response.end(padded(request.url?.endsWith("/over") === true ? CATALOGUE_BODY_LIMIT_BYTES + 1 : CATALOGUE_BODY_LIMIT_BYTES));
    });
    expect((await realCatalogueFetch(`${url}/v1/models`, {}, TIMEOUT_MS)).body).toMatchObject({ data: [{ id: "m" }] });
    await expect(realCatalogueFetch(`${url}/v1/over`, {}, TIMEOUT_MS)).rejects.toThrow(/limit/);
  });

  it("reads a list within the limit", async () => {
    const url = await listen((_request, response) => {
      response.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    expect(await realCatalogueFetch(`${url}/v1/models`, {}, TIMEOUT_MS)).toEqual({ status: OK, body: { data: [{ id: "m" }] }, located: false });
  });

  it.each([[true, { location: "https://elsewhere.example/models" }], [false, {}]])("says whether a list that parsed carried a Location (%s) too", async (located, headers) => {
    const url = await listen((_request, response) => {
      response.writeHead(OK, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    expect(await realCatalogueFetch(`${url}/v1/models`, {}, TIMEOUT_MS)).toMatchObject({ status: OK, located });
  });

  it("parses a model list that opens with a byte order mark, which the read strips as response.text() did", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(OK, { "content-type": "application/json" });
      response.end(Buffer.concat([Buffer.from(BYTE_ORDER_MARK, "hex"), Buffer.from('{"data":[{"id":"m"}]}')]));
    });
    expect((await realCatalogueFetch(`${url}/v1/models`, {}, TIMEOUT_MS)).body).toEqual({ data: [{ id: "m" }] });
  });

  it("cancels a body it refuses for its size, so the connection is not left streaming", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        controller.enqueue(new Uint8Array(CATALOGUE_BODY_LIMIT_BYTES + 1));
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: OK }));
    try {
      await expect(realCatalogueFetch("http://127.0.0.1:1/v1/models", {}, TIMEOUT_MS)).rejects.toThrow(/limit/);
    } finally {
      spy.mockRestore();
    }
    expect(cancelled).toBe(true);
  });
  it("refuses a body that is read as anything but bytes", async () => {
    const body = new ReadableStream({
      start: (controller) => {
        controller.enqueue("a list");
        controller.close();
      },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: OK }));
    try {
      await expect(realCatalogueFetch("http://127.0.0.1:1/v1/models", {}, TIMEOUT_MS)).rejects.toThrow("the model list body is not bytes");
    } finally {
      spy.mockRestore();
    }
  });

  it.each([[true, { location: "https://elsewhere.example/models" }], [false, {}]])("says whether the answer carried a Location (%s), for a redirect that is never followed", async (located, headers) => {
    const url = await listen((_request, response) => {
      response.writeHead(FOUND_STATUS, headers);
      response.end();
    });
    expect(await realCatalogueFetch(`${url}/v1/models`, {}, TIMEOUT_MS)).toEqual({ status: FOUND_STATUS, body: undefined, located });
  });

});

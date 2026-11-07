import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { RcSelfHostCredentialRecord } from "./rcSelfHost";
import { createRcSelfHostLocal } from "./rcSelfHostLocal";

/**
 * The local answers' routing split and their refusal of an unattributable mint, over the bare local surface behind a loopback server standing in for the connect surface: the surface is only ever handed requests of sessions the connect surface already attributed to the mode, so these tests hand it requests directly.
 */

/** The 503 the surface refuses with while the mint names no identity. */
const HTTP_SERVICE_UNAVAILABLE = 503;

const RECORD: RcSelfHostCredentialRecord = { accessToken: "sk-ant-oat1", refreshToken: "selfhost-refresh", organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222", identityId: "lab" };

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }
});

/** Serves `host`'s requests through the local surface over `record`, recording each request's routing decision; a declined request gets an empty 404 here, as the connect surface would route it instead. */
async function serveLocal(host: string, record: RcSelfHostCredentialRecord): Promise<{ readonly port: number; readonly decisions: Record<string, boolean> }> {
  const local = createRcSelfHostLocal({
    now: () => 0,
    credentialRecord: () => record,
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    ownsLaunch: () => true,
  });
  const decisions: Record<string, boolean> = {};
  const server = http.createServer((request, response) => {
    void local.serve(host, request, response).then((matched) => {
      decisions[`${request.url ?? "?"} ${request.headers["x-agent-shim-provider"] === undefined ? "native" : "provider"}`] = matched;
      if (!matched) {
        response.writeHead(HTTP_STATUS.notFound);
        response.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  return { port: (server.address() as { port: number }).port, decisions };
}

async function call(port: number, method: string, path: string, body?: unknown, headers: Readonly<Record<string, string>> = {}): Promise<{ readonly status: number; readonly body: string }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.once("error", reject);
    request.end(text);
  });
}

describe("the self-hosted mode's routing split on the API host", () => {
  it("leaves the session family and a provider session's /v1/ calls to the routed pipeline, and answers every other /v1/ call itself", async () => {
    const { port, decisions } = await serveLocal("api.anthropic.com", RECORD);
    await call(port, "GET", "/v1/code/sessions");
    await call(port, "GET", "/v1/mcp_servers");
    await call(port, "POST", "/v1/messages", {});
    await call(port, "POST", "/v1/messages", {}, { "x-agent-shim-provider": "mock" });
    expect(decisions).toEqual({ "/v1/code/sessions native": false, "/v1/mcp_servers native": true, "/v1/messages native": true, "/v1/messages provider": false });
  });
});

describe("a mint that names no identity", () => {
  it("is refused on every call, with the instruction to mint again", async () => {
    const { accessToken, refreshToken, organizationUuid, accountUuid } = RECORD;
    const { port } = await serveLocal("platform.claude.com", { accessToken, refreshToken, organizationUuid, accountUuid });
    const refused = await call(port, "POST", "/v1/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken });
    expect(refused.status).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(refused.body).toContain("mint <identity> again");
  });
});

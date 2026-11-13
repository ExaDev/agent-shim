import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { malformedTargetClass } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import type { PipelineRequest } from "./pipeline";

const servers: { readonly close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await server.close();
  }));
});

/** Request targets the door cannot read, each with the class of the failure it must be named by. */
const MALFORMED: readonly (readonly [string, string, string])[] = [
  ["a provider segment that is one percent sign", "/providers/%/v1/messages", "URIError"],
  ["a provider segment with a bad escape", "/providers/%ZZ/v1/messages", "URIError"],
  ["an absolute-form target with a port that is too large", "http://127.0.0.1:99999/v1/messages", "TypeError"],
  ["an absolute-form target with an unclosed address", "http://[::1/v1/messages", "TypeError"],
  ["an absolute-form target with no host", "http://", "TypeError"],
];

/** Targets that read, which must reach the pipeline as they did. */
const READABLE = ["/v1/messages", "/providers/z/v1/messages", "/providers/a%20b/v1/messages", "/v1/messages?x=%", "/providers/z", "http://127.0.0.1:8080/v1/messages"] as const;

/** A door whose pipeline answers 200 and notes the targets it was handed, with a keep-alive agent over one socket so that a second request shows the connection survived. */
async function door(): Promise<{ readonly port: number; readonly reached: string[]; readonly agent: http.Agent }> {
  const reached: string[] = [];
  const server = createFrontDoorServer(async (request: PipelineRequest) => {
    reached.push(request.url);
    request.response.writeHead(HTTP_STATUS.ok, { "Content-Type": "text/plain" });
    request.response.end("served");
    await Promise.resolve();
  }, () => undefined);
  const handle = await listenFrontDoor(server);
  servers.push(handle);
  return { port: handle.port, reached, agent: new http.Agent({ keepAlive: true, maxSockets: 1 }) };
}

/** One request with the target exactly as given, on `agent`; resolves with the answer and the local port of the socket that carried it. */
async function ask(world: Awaited<ReturnType<typeof door>>, target: string, body?: string): Promise<{ readonly status: number; readonly text: string; readonly socketPort: number | undefined }> {
  return await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: world.port, path: target, method: body === undefined ? "GET" : "POST", agent: world.agent, headers: body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), socketPort: request.socket?.localPort });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("a request target the door cannot read", () => {
  it.each(MALFORMED)("is class-named by malformedTargetClass for %s", (_label, target, className) => {
    expect(malformedTargetClass(target)).toBe(className);
  });

  it.each(READABLE)("is none of them: %s reads", (target) => {
    expect(malformedTargetClass(target)).toBeUndefined();
  });

  it.each(MALFORMED)("is answered 400 naming the class and nothing of the target, without reaching the pipeline, for %s, and the connection serves the next request", async (_label, target, className) => {
    const world = await door();
    try {
      const refused = await ask(world, target, '{"model":"x"}');
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain(`(${className})`);
      expect(refused.text).not.toContain("99999");
      expect(refused.text).not.toContain("%ZZ");
      expect(refused.text).not.toContain("internal error");
      expect(world.reached).toEqual([]);
      const next = await ask(world, "/v1/messages", '{"model":"x"}');
      expect(next.status).toBe(HTTP_STATUS.ok);
      expect(next.text).toBe("served");
      expect(next.socketPort).toBe(refused.socketPort);
      expect(world.reached).toEqual(["/v1/messages"]);
    } finally {
      world.agent.destroy();
    }
  });

  it.each(READABLE)("reaches the pipeline as it was sent when it reads: %s", async (target) => {
    const world = await door();
    try {
      expect((await ask(world, target)).status).toBe(HTTP_STATUS.ok);
      expect(world.reached).toEqual([target]);
    } finally {
      world.agent.destroy();
    }
  });
});

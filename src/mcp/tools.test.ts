import { describe, expect, it } from "vitest";

import { REMOTE_CONTROL_TAG, toolsFromOpenApiDocument } from "./tools";

const READ_ONLY = { writes: false, remoteControl: false } as const;

/** A document in the shape the door's generator produces: a query-parameter read, a body write, a Remote Control write and a stream. */
const DOCUMENT = {
  openapi: "3.2.0",
  paths: {
    "/rest/usage/windows": {
      get: {
        operationId: "usage.effectiveWindow",
        summary: "Read one identity's effective quota windows",
        tags: ["usage"],
        parameters: [
          { in: "query", name: "identity", required: true, schema: { type: "string", minLength: 1 } },
          { in: "query", name: "provider", schema: { type: "string", minLength: 1 } },
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/rest/config/pools": {
      post: {
        operationId: "pool.add",
        summary: "Add a pool",
        tags: ["config"],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/rest/rc/send": {
      post: {
        operationId: "rc.send",
        summary: "Send one message into a session",
        tags: [REMOTE_CONTROL_TAG],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { session: { type: "string" } }, required: ["session"] } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/rest/rc/events": {
      get: {
        operationId: "rc.subscribe",
        summary: "Stream a session's events",
        tags: [REMOTE_CONTROL_TAG],
        responses: { "200": { content: { "text/event-stream": { schema: {} } } } },
      },
    },
  },
};

describe("toolsFromOpenApiDocument", () => {
  it("exposes reads only by default, typed by the operation's own schema, and never a stream", () => {
    const tools = toolsFromOpenApiDocument(DOCUMENT, READ_ONLY);
    expect(tools.map((tool) => tool.name)).toEqual(["usage_effectiveWindow"]);
    expect(tools[0]).toMatchObject({
      description: "Read one identity's effective quota windows",
      procedure: ["usage", "effectiveWindow"],
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { identity: { type: "string", minLength: 1 }, provider: { type: "string", minLength: 1 } },
        required: ["identity"],
        additionalProperties: false,
      },
    });
  });

  it("adds configuration writes on their own opt-in, taking the request body's schema as the input", () => {
    const tools = toolsFromOpenApiDocument(DOCUMENT, { writes: true, remoteControl: false });
    expect(tools.map((tool) => tool.name)).toEqual(["usage_effectiveWindow", "pool_add"]);
    expect(tools[1]).toMatchObject({ readOnly: false, procedure: ["pool", "add"], inputSchema: { type: "object", required: ["name"] } });
  });

  it("keeps Remote Control writes behind their own opt-in, separate from configuration writes", () => {
    const remote = toolsFromOpenApiDocument(DOCUMENT, { writes: false, remoteControl: true });
    expect(remote.map((tool) => tool.name)).toEqual(["usage_effectiveWindow", "rc_send"]);
    const all = toolsFromOpenApiDocument(DOCUMENT, { writes: true, remoteControl: true });
    expect(all.map((tool) => tool.name)).toEqual(["usage_effectiveWindow", "pool_add", "rc_send"]);
  });

  it("refuses two operations that map to one tool name", () => {
    const document = {
      paths: {
        "/a": { get: { operationId: "x.y", responses: {} } },
        "/b": { get: { operationId: "x_y", responses: {} } },
      },
    };
    expect(() => toolsFromOpenApiDocument(document, READ_ONLY)).toThrow(/x_y/);
  });

  it("refuses a document without the OpenAPI shape instead of answering an empty list", () => {
    expect(() => toolsFromOpenApiDocument({ nothing: true }, READ_ONLY)).toThrow();
  });

  it("treats a POST that declares the read-only extension as a read, without any write permission", () => {
    const document = {
      paths: {
        "/rest/launch/resolve": {
          post: {
            operationId: "launch.resolve",
            summary: "Resolve a launch without performing it",
            tags: ["launch"],
            "x-agent-shim-read-only": true,
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } } },
            responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
          },
        },
        "/rest/config/pools": DOCUMENT.paths["/rest/config/pools"],
      },
    };
    const tools = toolsFromOpenApiDocument(document, READ_ONLY);
    expect(tools.map((tool) => tool.name)).toEqual(["launch_resolve"]);
    expect(tools[0]).toMatchObject({ readOnly: true, procedure: ["launch", "resolve"] });
  });
});

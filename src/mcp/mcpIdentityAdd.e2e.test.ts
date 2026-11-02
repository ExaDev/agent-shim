import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RPCLink } from "@orpc/client/fetch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountRouterClient } from "../frontdoor/apiTestMount";
import { createConfigApiRouter } from "../frontdoor/configApi";
import { RC_ORPC_PATH_PREFIX } from "../frontdoor/rcApi";
import { identityExists } from "../identityStore";
import { createFakeKeychain, type FakeKeychain } from "../keychainTestWorld";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import type { AsyncRun } from "../replayRun";
import { claudeCodeKeychainService } from "../usage/signIn";
import { createMcpServer, serveMcp, type McpServerPorts } from "./server";
import { toolsFromOpenApiDocument, type McpPermissions } from "./tools";

const CONTROL_TOKEN = "unit-mcp-identity-add-token";

/** A made-up login, which no message or call of the check may carry. */
const LOGIN_BLOB = "a-made-up-login-blob";

const WRITES: McpPermissions = { writes: true, remoteControl: false, history: false };

/** The text of the first block of a tool result. */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const { content } = result;
  if (!Array.isArray(content)) {
    throw new Error("expected a content array");
  }
  const first: unknown = content[0];
  if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") {
    throw new Error("expected a text block");
  }
  return first.text;
}

describe("the MCP tool that adds an identity, over the door's configuration router", () => {
  let root: string;
  let paths: LayoutPaths;
  let keychain: FakeKeychain;
  let origin: string;
  let close: () => Promise<void>;
  /** When true, `security` gives no answer at all, as when it is killed after its time limit or cannot be started. */
  let unanswering: boolean;

  const service = (name: string): string => claudeCodeKeychainService(path.join(paths.identitiesDir, name));

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-mcp-identity-add-"));
    paths = buildLayoutPaths(root);
    keychain = createFakeKeychain();
    unanswering = false;
    const runAsync: AsyncRun = async (command, args) => await Promise.resolve(unanswering ? { status: null, stdout: "", stderr: "" } : keychain.run.run(command, args));
    const mounted = await mountRouterClient(createConfigApiRouter({ expectedToken: CONTROL_TOKEN, paths, keychain: { runAsync, platform: "darwin" } }), CONTROL_TOKEN, CONTROL_TOKEN);
    origin = new URL(mounted.url).origin;
    close = mounted.close;
  });

  afterEach(async () => {
    await close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The server's ports over plain HTTP to the mounted router, the same shape the command has over the door's pinned TLS link. */
  function portsFor(permissions: McpPermissions): McpServerPorts {
    const link = new RPCLink({ origin, url: RC_ORPC_PATH_PREFIX, headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    return {
      listTools: async () => {
        const answered = await fetch(`${origin}${RC_ORPC_PATH_PREFIX}/openapi.json`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
        return toolsFromOpenApiDocument(await answered.json(), permissions);
      },
      callProcedure: async (procedure, input) => await link.call([...procedure], input, { context: {} }),
    };
  }

  async function connect(permissions: McpPermissions): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void serveMcp(createMcpServer({ name: "agent-shim", version: "0.0.0-test" }, portsFor(permissions)), serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("is offered only when writes are allowed", async () => {
    const readOnly = await connect({ writes: false, remoteControl: false, history: false });
    expect((await readOnly.listTools()).tools.map((tool) => tool.name)).not.toContain("config_identity_add");
    await readOnly.close();
    const writing = await connect(WRITES);
    expect((await writing.listTools()).tools.map((tool) => tool.name)).toContain("config_identity_add");
    await writing.close();
  });

  it("refuses to create an identity over a Keychain login left behind, as an error result that names the entry and the commands", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const client = await connect(WRITES);
    const refused = await client.callTool({ name: "config_identity_add", arguments: { name: "work" } });
    expect(refused.isError).toBe(true);
    const text = textOf(refused);
    expect(text).toContain("CONFLICT");
    expect(text).toContain(`security delete-generic-password -s '${service("work")}' -a 'alex'`);
    expect(text).toContain("agent-shim identity add work --keep-keychain-login");
    expect(text).not.toContain(LOGIN_BLOB);
    expect(identityExists(paths, "work")).toBe(false);
    await client.close();
  });

  it("reports a Keychain that could not be asked as a retryable SERVICE_UNAVAILABLE, not as the conflict a leftover login is", async () => {
    unanswering = true;
    const client = await connect(WRITES);
    const failed = await client.callTool({ name: "config_identity_add", arguments: { name: "work" } });
    expect(failed.isError).toBe(true);
    const text = textOf(failed);
    expect(text).toContain("SERVICE_UNAVAILABLE");
    expect(text).not.toContain("CONFLICT");
    expect(identityExists(paths, "work")).toBe(false);
    unanswering = false;
    const retried = await client.callTool({ name: "config_identity_add", arguments: { name: "work" } });
    expect(retried.isError).not.toBe(true);
    expect(identityExists(paths, "work")).toBe(true);
    await client.close();
  });

  it("reads attributes only: the login is never requested, however the refusal came about", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const client = await connect(WRITES);
    await client.callTool({ name: "config_identity_add", arguments: { name: "work" } });
    expect(keychain.calls).toEqual([{ command: "security", args: ["find-generic-password", "-s", service("work")] }]);
    expect(keychain.calls.some((call) => call.args.includes("-w") || call.args.includes("-g") || call.args[0] === "-i")).toBe(false);
    await client.close();
  });

  it("creates the identity with keepKeychainLogin, asking the Keychain nothing, and without it once the entry is deleted", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const client = await connect(WRITES);
    const kept = await client.callTool({ name: "config_identity_add", arguments: { name: "work", keepKeychainLogin: true } });
    expect(kept.isError).not.toBe(true);
    expect(JSON.parse(textOf(kept))).toMatchObject({ action: "created", kind: "identity", name: "work" });
    expect(keychain.calls).toEqual([]);
    expect(keychain.items.has(service("work"))).toBe(true);

    keychain.items.delete(service("other"));
    const plain = await client.callTool({ name: "config_identity_add", arguments: { name: "other" } });
    expect(plain.isError).not.toBe(true);
    expect(identityExists(paths, "other")).toBe(true);
    await client.close();
  });
});

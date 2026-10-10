import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { McpToolSpec } from "./tools";

/** What the MCP server needs from the door, injected so it serves against fakes in tests and against the real door in the command. */
export interface McpServerPorts {
  /** The current tool list, read from the door at the moment of each request so a restarted or upgraded door is reflected. */
  readonly listTools: () => Promise<readonly McpToolSpec[]>;
  /** Calls one procedure of the door's typed API with the tool's arguments and resolves to its output. */
  readonly callProcedure: (procedure: readonly string[], input: unknown) => Promise<unknown>;
}

/** The server name and version a client sees. */
export interface McpServerIdentity {
  readonly name: string;
  readonly version: string;
}

const CallArgumentsSchema = z.record(z.string(), z.unknown());

/** Reads a thrown value as the message a tool result carries: an oRPC error names its code beside its message so a caller can tell a refusal from a failure. */
function failureText(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error instanceof Error) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the MCP server that exposes the door's typed API as tools. A call's arguments pass to the procedure unchanged, since the door validates them through the same Zod schemas the tool's input schema was derived from; a refusal or failure comes back as an error result the agent can read, never as a protocol error.
 */
export function createMcpServer(identity: Readonly<McpServerIdentity>, ports: McpServerPorts): McpServer {
  // The tool list is dynamic (it is the door's current document), so the low-level request handlers are set directly on the protocol server the high-level one wraps, and the tools capability is declared up front because no registered tool would declare it lazily.
  const mcp = new McpServer(identity, { capabilities: { tools: {} } });
  const { server } = mcp;
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await ports.listTools();
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tools = await ports.listTools();
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return { isError: true, content: [{ type: "text" as const, text: `no tool named ${request.params.name} is exposed by this server` }] };
    }
    const args = CallArgumentsSchema.parse(request.params.arguments ?? {});
    try {
      const output = await ports.callProcedure(tool.procedure, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    } catch (error: unknown) {
      return { isError: true, content: [{ type: "text" as const, text: failureText(error) }] };
    }
  });
  return mcp;
}

/** Connects a server to a transport and resolves once the transport has closed, so a stdio command stays alive exactly as long as its client does. */
export async function serveMcp(mcp: McpServer, transport: Readonly<Transport>): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    mcp.server.onclose = resolve;
  });
  await mcp.connect(transport);
  await closed;
}

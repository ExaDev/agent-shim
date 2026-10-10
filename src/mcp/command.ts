import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Command } from "commander";

import { withExamples, type CommandDeps } from "../cli/commandDeps";
import { fetchFrontDoorOpenApiDocument, frontDoorApiLink } from "../frontdoor/rcApi";
import { readFrontDoorControlMaterial } from "../frontdoor/doorClient";
import type { LayoutPaths } from "../paths";
import packageJson from "../../package.json";
import { realFarmFs } from "../realPorts";
import { createMcpServer, serveMcp, type McpServerPorts } from "./server";
import { toolsFromOpenApiDocument, type McpWritePermissions } from "./tools";

/**
 * The server's ports over the serving door: the tool list is the door's current OpenAPI document and a call is one procedure of its typed API. The control material is read at each request, because the token belongs to one door generation and a restart replaces it; a link is reused while the port and token are unchanged.
 */
function doorMcpPorts(paths: LayoutPaths, permissions: McpWritePermissions): McpServerPorts {
  const material = () => readFrontDoorControlMaterial(realFarmFs, paths, "the MCP server");
  let cached: { readonly key: string; readonly link: ReturnType<typeof frontDoorApiLink> } | undefined;
  return {
    listTools: async () => {
      const { port, ca, token } = material();
      return toolsFromOpenApiDocument(await fetchFrontDoorOpenApiDocument(port, ca, token), permissions);
    },
    callProcedure: async (procedure, input) => {
      const { port, ca, token } = material();
      const key = `${String(port)}:${token}`;
      if (cached?.key !== key) {
        cached = { key, link: frontDoorApiLink(port, ca, token) };
      }
      return await cached.link.call([...procedure], input, { context: {} });
    },
  };
}

/** Registers `agent-shim mcp`: an MCP server on standard input and output that exposes the serving door's typed API as tools. */
export function registerMcpCommand(program: Command, deps: CommandDeps): void {
  withExamples(
    program
      .command("mcp")
      .description("Serve the front door's typed API as MCP tools on standard input and output, so an agent can read quota and door state and, when allowed, act on it.")
      .option("--allow-writes", "Also expose the operations that change the door's configuration and lifecycle. Read-only without it.")
      .option("--allow-remote-control", "Also expose the Remote Control operations that send into, answer for and end other sessions.")
      .action(async (options: Readonly<{ allowWrites?: boolean; allowRemoteControl?: boolean }>) => {
        const permissions: McpWritePermissions = { writes: options.allowWrites === true, remoteControl: options.allowRemoteControl === true };
        const server = createMcpServer({ name: "agent-shim", version: packageJson.version }, doorMcpPorts(deps.paths, permissions));
        await serveMcp(server, new StdioServerTransport());
      }),
    ["agent-shim mcp", "agent-shim mcp --allow-writes"],
  );
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Command } from "commander";

import { UsageError } from "../cliError";
import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { fetchFrontDoorOpenApiDocument, frontDoorApiLink } from "../frontdoor/rcApi";
import { readFrontDoorControlMaterial } from "../frontdoor/doorClient";
import type { LayoutPaths } from "../paths";
import packageJson from "../../package.json";
import { realFarmFs } from "../realPorts";
import { createMcpServer, serveMcp, type McpServerPorts } from "./server";
import { effectiveMcpPermissions, readStoredMcpPermissions, watchMcpPermissions, writeStoredMcpPermissions } from "./permissions";
import { toolsFromOpenApiDocument, type McpPermissions } from "./tools";

/**
 * The server's ports over the serving door: the tool list is the door's current OpenAPI document and a call is one procedure of its typed API. The control material is read at each request, because the token belongs to one door generation and a restart replaces it; a link is reused while the port and token are unchanged.
 */
function doorMcpPorts(paths: LayoutPaths, permissions: () => McpPermissions): McpServerPorts {
  const material = () => readFrontDoorControlMaterial(realFarmFs, paths, "the MCP server");
  let cached: { readonly key: string; readonly link: ReturnType<typeof frontDoorApiLink> } | undefined;
  return {
    listTools: async () => {
      const { port, ca, token } = material();
      return toolsFromOpenApiDocument(await fetchFrontDoorOpenApiDocument(port, ca, token), permissions());
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

/** The permission names the `mcp permissions` verbs take, each the field of the stored permissions it sets. */
const PERMISSION_FIELDS = { writes: "writes", "remote-control": "remoteControl", history: "history" } as const;
type PermissionName = keyof typeof PERMISSION_FIELDS;

function permissionName(value: string): PermissionName {
  if (value !== "writes" && value !== "remote-control" && value !== "history") {
    throw new UsageError(`unknown permission "${value}": expected writes, remote-control or history`);
  }
  return value;
}

/** Registers `agent-shim mcp`: an MCP server on standard input and output that exposes the serving door's typed API as tools, and `agent-shim mcp permissions`, which changes what its agents may do while it runs. */
export function registerMcpCommand(program: Command, deps: CommandDeps): void {
  const mcp = program
    .command("mcp")
    .description("Serve the front door's typed API as MCP tools on standard input and output, so an agent can read quota and door state and, when allowed, act on it.")
    .option("--allow-writes", "Also expose the operations that change the door's configuration and lifecycle, whatever `mcp permissions` says. Read-only without it or a stored permission.")
    .option("--allow-remote-control", "Also expose the Remote Control operations that send into, answer for and end other sessions, whatever `mcp permissions` says.")
    .option("--allow-history", "Also expose the reads of session history (agents, tasks and workflow runs across every identity), whatever `mcp permissions` says.")
    .action(async (options: Readonly<{ allowWrites?: boolean; allowRemoteControl?: boolean; allowHistory?: boolean }>) => {
      const flags: McpPermissions = { writes: options.allowWrites === true, remoteControl: options.allowRemoteControl === true, history: options.allowHistory === true };
      // Re-read on every request, so `agent-shim mcp permissions allow` takes effect on a server that is already running.
      const inForce = (): McpPermissions => effectiveMcpPermissions(flags, readStoredMcpPermissions(deps.paths));
      const server = createMcpServer({ name: "agent-shim", version: packageJson.version }, doorMcpPorts(deps.paths, inForce));
      await serveMcp(server, new StdioServerTransport(), {
        whileConnected: (announce) => watchMcpPermissions(deps.paths, announce),
        inputEnded: new Promise<void>((resolve) => {
          process.stdin.once("end", resolve);
        }),
      });
    });
  withExamples(mcp, ["agent-shim mcp", "agent-shim mcp --allow-writes"]);

  const permissions = withExamples(
    mcp.command("permissions").description("Show or change what the MCP server's agents may do. A running server picks a change up on its next request, with no restart."),
    ["agent-shim mcp permissions show", "agent-shim mcp permissions allow writes"],
  );
  withExamples(
    permissions
      .command("show")
      .description("Print the permissions the stored file grants.")
      .option("--json", "Print them as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const stored = readStoredMcpPermissions(deps.paths);
        if (options.json === true) {
          printJson(stored);
          return;
        }
        console.log(`writes: ${stored.writes ? "allowed" : "not allowed"}`);
        console.log(`remote-control: ${stored.remoteControl ? "allowed" : "not allowed"}`);
        console.log(`history: ${stored.history ? "allowed" : "not allowed"}`);
      }),
    ["agent-shim mcp permissions show"],
  );
  for (const [verb, granted] of [["allow", true], ["deny", false]] as const) {
    withExamples(
      permissions
        .command(`${verb} <permission>`)
        .description(`${verb === "allow" ? "Allow" : "Stop allowing"} \`writes\` (configuration and lifecycle operations), \`remote-control\` (operations on other sessions) or \`history\` (reads of session history across identities) for the MCP server's agents.`)
        .action((permission: string) => {
          const field = PERMISSION_FIELDS[permissionName(permission)];
          writeStoredMcpPermissions(deps.paths, { ...readStoredMcpPermissions(deps.paths), [field]: granted });
          console.log(`${permission}: ${granted ? "allowed" : "not allowed"}`);
        }),
      [`agent-shim mcp permissions ${verb} writes`],
    );
  }
}

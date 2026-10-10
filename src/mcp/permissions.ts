import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { readJson, writeJsonAtomic } from "../config/store";
import type { LayoutPaths } from "../paths";
import type { McpWritePermissions } from "./tools";

/**
 * The permissions the person has given the MCP server's agents, kept in the state root so they can change while the server runs.
 *
 * The file is written only by `agent-shim mcp permissions allow|deny`, which an agent using the MCP server cannot reach: no door procedure writes it and no tool is derived for it. The server grants the union of this file and its own startup flags, so a flag is a floor the file can raise but never lower.
 */
const StoredMcpPermissionsSchema = z.strictObject({
  writes: z.boolean(),
  remoteControl: z.boolean(),
});

/** The file's mode: readable and writable by its owner alone, so no other user can raise what an agent may do. */
const OWNER_ONLY_MODE = 0o600;

/** What no permission file means: reads only. */
const NONE: McpWritePermissions = { writes: false, remoteControl: false };

/** Reads the stored permissions: none granted when the file does not exist. A file that exists but is not valid throws `ConfigValidationError`, so a damaged file fails the request loudly instead of silently granting or denying. */
export function readStoredMcpPermissions(paths: LayoutPaths): McpWritePermissions {
  return readJson(paths.mcpPermissionsFile, StoredMcpPermissionsSchema) ?? NONE;
}

/** Writes the stored permissions atomically and owner-only, so no other user can raise them. */
export function writeStoredMcpPermissions(paths: LayoutPaths, permissions: McpWritePermissions): void {
  writeJsonAtomic(paths.mcpPermissionsFile, { writes: permissions.writes, remoteControl: permissions.remoteControl });
  fs.chmodSync(paths.mcpPermissionsFile, OWNER_ONLY_MODE);
}

/** The permissions in force: what the startup flags grant plus what the file grants. */
export function effectiveMcpPermissions(flags: McpWritePermissions, stored: McpWritePermissions): McpWritePermissions {
  return { writes: flags.writes || stored.writes, remoteControl: flags.remoteControl || stored.remoteControl };
}

/**
 * Calls `onChange` when the permission file may have changed, until the returned function is called. Watches the file's directory (created if absent) because the file itself may not exist yet and is replaced by a rename on every write.
 */
export function watchMcpPermissions(paths: LayoutPaths, onChange: () => void): () => void {
  const directory = path.dirname(paths.mcpPermissionsFile);
  fs.mkdirSync(directory, { recursive: true });
  const watcher = fs.watch(directory, (_event, filename) => {
    if (filename === null || filename === path.basename(paths.mcpPermissionsFile)) {
      onChange();
    }
  });
  return () => {
    watcher.close();
  };
}

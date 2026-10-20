import path from "node:path";
import { z } from "zod";

import type { StatuslinePorts } from "./ports";

/** What the session's configuration holds that shapes its context, as counts. */
export interface ConfigCounts {
  /** CLAUDE.md and CLAUDE.local.md files, in the configuration directory and the project. */
  readonly claudeMd: number;
  /** Markdown files under a `rules` directory, at any depth. */
  readonly rules: number;
  /** MCP servers configured for the user and for the project, a server named in both scopes counting in each. */
  readonly mcpServers: number;
  /** Hook events with at least an entry in a settings file: the keys of its `hooks` object, not the commands under them. */
  readonly hookEvents: number;
}

/** A list of names, with anything in it that is not a name left out. */
const nameList = z
  .array(z.unknown())
  .catch([])
  .transform((items) => items.filter((item): item is string => typeof item === "string"));

/** The parts of a settings or global configuration file the counts read; fields of another type read as absent, and the rest of the file is left unread. */
const ConfigFileSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional().catch(undefined),
  hooks: z.record(z.string(), z.unknown()).optional().catch(undefined),
  disabledMcpServers: nameList.optional(),
  disabledMcpjsonServers: nameList.optional(),
});
type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** The most directories and the most entries a rules tree walk visits: a rules directory is a handful of files, so the bounds only matter when one points at a tree it should not, which every refresh would otherwise walk. */
const MAX_RULE_DIRECTORIES = 1_000;
const MAX_RULE_ENTRIES = 10_000;

/** The largest configuration file read, in bytes: the global file Claude Code keeps grows with the history of every project, and each draw of the environment row parses what it reads whole, so a bound keeps the work of a draw bounded. A typical file is a small fraction of it. A file over the bound is read as holding nothing, so the MCP servers and hook events only it names are not counted. */
const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_CONFIG_FILE_MEBIBYTES = 8;
const MAX_CONFIG_FILE_BYTES = MAX_CONFIG_FILE_MEBIBYTES * BYTES_PER_MEBIBYTE;

function readConfigFile(ports: StatuslinePorts, file: string): ConfigFile | undefined {
  // A range of no bytes reports the file's size without reading any of it.
  const size = ports.readRange(file, 0, 0)?.size;
  if (size === undefined || size > MAX_CONFIG_FILE_BYTES) {
    return undefined;
  }
  const text = ports.readText(file);
  if (text === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function namesOf(file: ConfigFile | undefined): Set<string> {
  return new Set(file?.mcpServers === undefined ? [] : Object.keys(file.mcpServers));
}

function hookEventsOf(file: ConfigFile | undefined): number {
  return file?.hooks === undefined ? 0 : Object.keys(file.hooks).length;
}

function removeNames(servers: Set<string>, names: readonly string[] | undefined): void {
  if (names === undefined) {
    return;
  }
  for (const name of names) {
    servers.delete(name);
  }
}

/** What a path names with its links followed: `directory`, `other` for a file, or undefined for nothing. The ports' own `entryKind` does not follow a final link, and the configuration directory of a session is often a farm of links. */
function followedKind(ports: StatuslinePorts, target: string): "directory" | "other" | undefined {
  const real = ports.realPath(target);
  return real === undefined ? undefined : ports.entryKind(real);
}

function isFile(ports: StatuslinePorts, file: string): boolean {
  return followedKind(ports, file) === "other";
}

/** The Markdown files under a rules directory, each file counted once however many links reach it, and no directory walked twice, which is what stops a link back up the tree from looping. */
function countRules(ports: StatuslinePorts, root: string): number {
  const visited = new Set<string>();
  let entries = 0;
  let directories = 0;
  const walk = (directory: string): number => {
    const real = ports.realPath(directory);
    if (real === undefined || visited.has(real) || directories >= MAX_RULE_DIRECTORIES) {
      return 0;
    }
    visited.add(real);
    directories += 1;
    const names = ports.listDirectory(real);
    if (names === undefined) {
      return 0;
    }
    let count = 0;
    for (const name of names) {
      if (entries >= MAX_RULE_ENTRIES) {
        break;
      }
      entries += 1;
      const entry = path.join(real, name);
      const kind = followedKind(ports, entry);
      if (kind === "directory") {
        count += walk(entry);
      } else if (kind === "other" && name.endsWith(".md")) {
        const target = ports.realPath(entry);
        if (target !== undefined && !visited.has(target)) {
          visited.add(target);
          count += 1;
        }
      }
    }
    return count;
  };
  return walk(root);
}

/** Whether two paths are one place, links resolved; a path that does not exist is compared as written. */
function sameLocation(ports: StatuslinePorts, left: string, right: string): boolean {
  return (ports.realPath(left) ?? path.resolve(left)) === (ports.realPath(right) ?? path.resolve(right));
}

/** The directory Claude Code keeps the session's user-scope configuration in: the one the launch pinned, else `.claude` in the home directory. */
function configDirectoryOf(ports: StatuslinePorts): string {
  const pinned = ports.env.CLAUDE_CONFIG_DIR;
  return pinned === undefined || pinned === "" ? path.join(ports.homeDirectory, ".claude") : pinned;
}

/**
 * Counts what the session's configuration holds, as Claude Code finds it: in the user's configuration directory, and in `projectDirectory` when one is given. A project's `.claude` directory that is the user's own (a session started in the configuration directory) is read once, as the user scope. Nothing is cached: the files are small and read only when the environment row is drawn.
 */
export function countConfiguration(ports: StatuslinePorts, projectDirectory: string | undefined): ConfigCounts {
  const userDirectory = configDirectoryOf(ports);
  const userSettings = readConfigFile(ports, path.join(userDirectory, "settings.json"));
  // The global configuration file sits inside a pinned directory, and beside the home directory's `.claude` otherwise.
  const globalFile = ports.env.CLAUDE_CONFIG_DIR === undefined || ports.env.CLAUDE_CONFIG_DIR === "" ? path.join(ports.homeDirectory, ".claude.json") : path.join(userDirectory, ".claude.json");
  const global = readConfigFile(ports, globalFile);

  const userServers = new Set([...namesOf(userSettings), ...namesOf(global)]);
  removeNames(userServers, global?.disabledMcpServers);
  const projectServers = new Set<string>();
  let claudeMd = isFile(ports, path.join(userDirectory, "CLAUDE.md")) ? 1 : 0;
  let rules = countRules(ports, path.join(userDirectory, "rules"));
  let hookEvents = hookEventsOf(userSettings);

  if (projectDirectory !== undefined) {
    const projectClaude = path.join(projectDirectory, ".claude");
    const projectIsUser = sameLocation(ports, projectClaude, userDirectory);
    const claudeMdFiles = [path.join(projectDirectory, "CLAUDE.md"), path.join(projectDirectory, "CLAUDE.local.md"), path.join(projectClaude, "CLAUDE.local.md"), ...(projectIsUser ? [] : [path.join(projectClaude, "CLAUDE.md")])];
    claudeMd += claudeMdFiles.filter((file) => isFile(ports, file)).length;
    const mcpJson = namesOf(readConfigFile(ports, path.join(projectDirectory, ".mcp.json")));
    if (!projectIsUser) {
      rules += countRules(ports, path.join(projectClaude, "rules"));
      const settings = readConfigFile(ports, path.join(projectClaude, "settings.json"));
      const local = readConfigFile(ports, path.join(projectClaude, "settings.local.json"));
      hookEvents += hookEventsOf(settings) + hookEventsOf(local);
      for (const name of [...namesOf(settings), ...namesOf(local)]) {
        projectServers.add(name);
      }
      removeNames(mcpJson, local?.disabledMcpjsonServers);
    }
    for (const name of mcpJson) {
      projectServers.add(name);
    }
  }
  return { claudeMd, rules, mcpServers: userServers.size + projectServers.size, hookEvents };
}

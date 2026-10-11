import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { buildProgram } from "../program";
import { fakeCommandDeps } from "../test-helpers";
import { readStoredMcpPermissions } from "./permissions";

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-mcp-command-"));
  paths = buildLayoutPaths(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Runs one `agent-shim` invocation against the throwaway layout and returns what it printed. */
async function run(argv: readonly string[]): Promise<string> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn<(args: readonly string[]) => Promise<void>>() }).parseAsync([...argv], { from: "user" });
  return out.join("\n");
}

describe("agent-shim mcp permissions", () => {
  it("allows and denies each permission in the stored file, one at a time", async () => {
    expect(await run(["mcp", "permissions", "allow", "writes"])).toBe("writes: allowed");
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: true, remoteControl: false, history: false });
    expect(await run(["mcp", "permissions", "allow", "remote-control"])).toBe("remote-control: allowed");
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: true, remoteControl: true, history: false });
    expect(await run(["mcp", "permissions", "deny", "writes"])).toBe("writes: not allowed");
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: false, remoteControl: true, history: false });
    expect(await run(["mcp", "permissions", "allow", "history"])).toBe("history: allowed");
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: false, remoteControl: true, history: true });
  });

  it("shows the stored permissions as text and as JSON", async () => {
    await run(["mcp", "permissions", "allow", "writes"]);
    expect(await run(["mcp", "permissions", "show"])).toBe("writes: allowed\nremote-control: not allowed\nhistory: not allowed");
    expect(JSON.parse(await run(["mcp", "permissions", "show", "--json"]))).toEqual({ writes: true, remoteControl: false, history: false });
  });

  it("refuses a permission it does not know, leaving the file untouched", async () => {
    await expect(run(["mcp", "permissions", "allow", "everything"])).rejects.toThrow('unknown permission "everything"');
    expect(fs.existsSync(paths.mcpPermissionsFile)).toBe(false);
  });
});

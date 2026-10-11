import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigValidationError } from "../config/load";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { effectiveMcpPermissions, readStoredMcpPermissions, watchMcpPermissions, writeStoredMcpPermissions } from "./permissions";

const MODE_BITS = 0o777;
const OWNER_ONLY_MODE = 0o600;
/** Long enough for a file-system event to have arrived had one been going to, which a negative assertion needs. */
const QUIET_PERIOD_MS = 100;

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-mcp-permissions-"));
  paths = buildLayoutPaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stored MCP permissions", () => {
  it("grants nothing when no file exists", () => {
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: false, remoteControl: false, history: false });
  });

  it("round-trips what was written, owner-only", () => {
    writeStoredMcpPermissions(paths, { writes: true, remoteControl: false, history: false });
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: true, remoteControl: false, history: false });
    expect(fs.statSync(paths.mcpPermissionsFile).mode & MODE_BITS).toBe(OWNER_ONLY_MODE);
  });

  it("reads a file written before the history grant existed as not allowed", () => {
    fs.mkdirSync(path.dirname(paths.mcpPermissionsFile), { recursive: true });
    fs.writeFileSync(paths.mcpPermissionsFile, JSON.stringify({ writes: true, remoteControl: true }));
    expect(readStoredMcpPermissions(paths)).toEqual({ writes: true, remoteControl: true, history: false });
  });

  it("fails loudly on a damaged file instead of granting or denying", () => {
    fs.mkdirSync(path.dirname(paths.mcpPermissionsFile), { recursive: true });
    fs.writeFileSync(paths.mcpPermissionsFile, JSON.stringify({ writes: "yes" }));
    expect(() => readStoredMcpPermissions(paths)).toThrow(ConfigValidationError);
  });
});

describe("effectiveMcpPermissions", () => {
  it("grants the union of the startup flags and the file, so a flag is a floor the file only raises", () => {
    const none = { writes: false, remoteControl: false, history: false };
    expect(effectiveMcpPermissions(none, none)).toEqual(none);
    expect(effectiveMcpPermissions({ writes: true, remoteControl: false, history: false }, none)).toEqual({ writes: true, remoteControl: false, history: false });
    expect(effectiveMcpPermissions(none, { writes: false, remoteControl: true, history: false })).toEqual({ writes: false, remoteControl: true, history: false });
    expect(effectiveMcpPermissions({ writes: true, remoteControl: false, history: false }, { writes: false, remoteControl: true, history: false })).toEqual({ writes: true, remoteControl: true, history: false });
  });
});

describe("watchMcpPermissions", () => {
  it("reports a write to the permission file, including one that creates it, and stops when asked", async () => {
    const changed = vi.fn();
    const stop = watchMcpPermissions(paths, () => {
      changed();
    });
    // A watcher does not see writes made before it is registered with the operating system, and how long that takes depends on machine load, so a single write straight after `watchMcpPermissions` can be lost. Writing again on each poll until an event arrives makes the test wait for registration instead of racing it.
    let writes = false;
    await vi.waitFor(() => {
      writes = !writes;
      writeStoredMcpPermissions(paths, { writes, remoteControl: false, history: false });
      expect(changed).toHaveBeenCalled();
    });
    stop();
    changed.mockClear();
    writeStoredMcpPermissions(paths, { writes: false, remoteControl: false, history: false });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, QUIET_PERIOD_MS);
    });
    expect(changed).not.toHaveBeenCalled();
  });
});

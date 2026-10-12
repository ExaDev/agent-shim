import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UsageError } from "../cliError";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { scriptedPrompts } from "../test-helpers";
import { readRoutingSetting } from "./routingSetting";
import { registerHeadroomRoutingCommands } from "./routingCommands";

describe("headroom enable and disable", () => {
  let root: string;
  let paths: LayoutPaths;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-commands-"));
    paths = buildLayoutPaths(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(args: readonly string[]): Promise<void> {
    const program = new Command().exitOverride();
    const headroom = program.command("headroom");
    registerHeadroomRoutingCommands(headroom, { paths, prompts: scriptedPrompts([]), isInteractive: () => false, exit: (code) => { throw new Error(`exit ${String(code)}`); } });
    await program.parseAsync(["headroom", ...args], { from: "user" });
  }

  it("records a global disable, which needs no running door", async () => {
    await run(["disable"]);
    expect(readRoutingSetting(paths)).toEqual({ schemaVersion: 1, global: { viaHeadroom: false }, sessions: {} });
  });

  it("records a session's own disable with the immediate marker under --now", async () => {
    await run(["disable", "--session", "abc", "--now"]);
    const choice = readRoutingSetting(paths).sessions.abc;
    expect(choice?.viaHeadroom).toBe(false);
    expect(typeof choice?.force).toBe("number");
  });

  it("refuses to enable while no front door is serving, and writes nothing", async () => {
    await expect(run(["enable"])).rejects.toBeInstanceOf(UsageError);
    expect(fs.existsSync(paths.headroomRoutingFile)).toBe(false);
  });
});

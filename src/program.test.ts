import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-use-program-"));
  paths = buildLayoutPaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildProgram", () => {
  it("registers every top-level command without parsing or launching anything", () => {
    const runClaude = vi.fn<(args: readonly string[]) => Promise<void>>();
    const program = buildProgram({ paths, runClaude });

    expect(program.commands.map((command) => command.name()).sort()).toEqual(
      ["__headroom-supervisor", "check", "configure", "doctor", "headroom", "identity", "profile", "provider", "rules", "run", "shim"].sort(),
    );
    expect(runClaude).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("forwards run's arguments verbatim to the injected launcher", async () => {
    const runClaude = vi.fn<(args: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const program = buildProgram({ paths, runClaude }).exitOverride();

    await program.parseAsync(["run", "@work", "-p", "hi", "--", "--version"], { from: "user" });

    expect(runClaude).toHaveBeenCalledWith(["@work", "-p", "hi", "--", "--version"]);
  });
});

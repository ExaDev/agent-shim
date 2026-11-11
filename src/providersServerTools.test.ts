import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { registerProviderCommand } from "./providers";
import { readProvider } from "./providersStore";
import { fakeCommandDeps } from "./test-helpers";

describe("a provider's server-tools setting in every JSON the provider commands print", () => {
  let root: string;
  let paths: LayoutPaths;
  let printed: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-server-tools-"));
    paths = buildLayoutPaths(root);
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(...argv: readonly string[]): Promise<unknown> {
    printed = [];
    const program = new Command().exitOverride();
    registerProviderCommand(program, fakeCommandDeps(paths));
    await program.parseAsync(["provider", ...argv], { from: "user" });
    return argv.includes("--json") ? (JSON.parse(printed.join("\n")) as unknown) : undefined;
  }

  const ADD = ["add", "spark", "--display-name", "Spark", "--base-url", "http://127.0.0.1:18080", "--credential", "literal:dummy", "--server-tools", "drop", "--json"] as const;

  it("is printed by add, show and list, and absent while the setting is unset", async () => {
    expect(await run(...ADD)).toMatchObject({ value: { serverTools: "drop" } });
    expect(await run("show", "spark", "--json")).toMatchObject({ serverTools: "drop" });
    expect(await run("list", "--json")).toMatchObject([{ name: "spark", serverTools: "drop" }]);
    await run("add", "plain", "--display-name", "Plain", "--base-url", "http://127.0.0.1:18081", "--credential", "literal:dummy");
    expect(await run("show", "plain", "--json")).not.toHaveProperty("serverTools");
  });

  it("round-trips: the value show prints is one provider set takes back, and set prints the new value", async () => {
    await run(...ADD);
    const shown = await run("show", "spark", "--json");
    const value = typeof shown === "object" && shown !== null && "serverTools" in shown ? String(shown.serverTools) : "";
    expect(await run("set", "spark", "--server-tools", "forward", "--json")).toMatchObject({ value: { serverTools: "forward" } });
    await run("set", "spark", "--server-tools", value);
    expect(readProvider(paths, "spark")).toMatchObject({ serverTools: "drop" });
    expect(await run("show", "spark", "--json")).toMatchObject({ serverTools: "drop" });
  });

  it("is printed by the text form of show as a line of its own, and not while unset", async () => {
    await run(...ADD);
    await run("add", "plain", "--display-name", "Plain", "--base-url", "http://127.0.0.1:18081", "--credential", "literal:dummy");
    await run("show", "spark");
    expect(printed.join("\n")).toContain("Server tools: drop");
    await run("show", "plain");
    expect(printed.join("\n")).not.toContain("Server tools");
  });
});

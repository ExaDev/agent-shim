import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigValidationError } from "./config/load";
import { MAX_TIMER_DELAY_MS } from "./config/schema";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { registerProviderCommand } from "./providers";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "./providerReachability";
import { ProviderKindMismatchError, addProvider, readProvider, updateProvider } from "./providersStore";
import { fakeCommandDeps } from "./test-helpers";

describe("a provider's connect timeout", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-connect-timeout-"));
    paths = buildLayoutPaths(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Runs one `agent-shim provider ...` command line against the temporary root. */
  async function run(...argv: readonly string[]): Promise<void> {
    const program = new Command().exitOverride();
    registerProviderCommand(program, fakeCommandDeps(paths));
    await program.parseAsync(["provider", ...argv], { from: "user" });
  }

  it("is stored in milliseconds from --connect-timeout's duration on add and set, and removed by --unset-connect-timeout", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", "http://127.0.0.1:4000", "--credential", "literal:dummy", "--connect-timeout", "3s");
    expect(readProvider(paths, "local")).toMatchObject({ connectTimeoutMs: 3_000 });
    await run("set", "local", "--connect-timeout", "500ms");
    expect(readProvider(paths, "local")).toMatchObject({ connectTimeoutMs: 500 });
    await run("set", "local", "--unset-connect-timeout");
    expect(readProvider(paths, "local")).not.toHaveProperty("connectTimeoutMs");
  });

  it("is printed by provider show --json and provider list --json, and left out of the view of a provider without one", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", "http://127.0.0.1:4000", "--credential", "literal:dummy", "--connect-timeout", "3s");
    await run("add", "plain", "--display-name", "Plain", "--base-url", "http://127.0.0.1:4001", "--credential", "literal:dummy");
    vi.mocked(console.log).mockClear();
    const logged = (): unknown[] => vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
    await run("show", "local", "--json");
    await run("show", "plain", "--json");
    await run("list", "--json");
    const [shownLocal, shownPlain, listed] = logged();
    expect(shownLocal).toMatchObject({ connectTimeoutMs: 3_000 });
    expect(shownPlain).not.toHaveProperty("connectTimeoutMs");
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ name: "local", connectTimeoutMs: 3_000 })]));
  });

  it("is shown by provider show as the default when none is set, and as the stored value when one is", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", "http://127.0.0.1:4000", "--credential", "literal:dummy");
    vi.mocked(console.log).mockClear();
    await run("show", "local");
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line))).toContain(`Connect timeout: ${String(DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS)}ms (the default)`);
    await run("set", "local", "--connect-timeout", "3s");
    vi.mocked(console.log).mockClear();
    await run("show", "local");
    expect(vi.mocked(console.log).mock.calls.map(([line]) => String(line))).toContain("Connect timeout: 3000ms");
  });

  it("is refused above the longest delay a timer can hold, which Node would otherwise cut to 1 ms", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", "http://127.0.0.1:4000", "--credential", "literal:dummy");
    await expect(run("set", "local", "--connect-timeout", "30d")).rejects.toThrow(ConfigValidationError);
    expect(readProvider(paths, "local")).not.toHaveProperty("connectTimeoutMs");
    await run("set", "local", "--connect-timeout", `${String(MAX_TIMER_DELAY_MS)}ms`);
    expect(readProvider(paths, "local")).toMatchObject({ connectTimeoutMs: MAX_TIMER_DELAY_MS });
  });

  it("is refused on a provider kind that dials no base URL", () => {
    expect(() => addProvider(paths, "c", { kind: "codex", displayName: "Codex", sources: [{ literal: "x" }], connectTimeoutMs: 1_000 })).toThrow(ProviderKindMismatchError);
    addProvider(paths, "c", { kind: "codex", displayName: "Codex", sources: [{ literal: "x" }] });
    expect(() => updateProvider(paths, "c", { connectTimeoutMs: 1_000 })).toThrow(ProviderKindMismatchError);
  });

  it("refuses --unset-connect-timeout beside --connect-timeout", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", "http://127.0.0.1:4000", "--credential", "literal:dummy");
    await expect(run("set", "local", "--connect-timeout", "1s", "--unset-connect-timeout")).rejects.toThrow("--unset-connect-timeout cannot be combined with --connect-timeout.");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogueCachePath } from "./providerCatalogue";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { registerProviderCommand } from "./providers";
import { describeProviderEndpoint, readProvider } from "./providersStore";
import { fakeCommandDeps } from "./test-helpers";

const SECRET_BASE_URL = "http://user:hunter2@127.0.0.1:4000/v1?key=abc123";
const NAMED_BASE_URL = "http://127.0.0.1:4000/v1";

describe("a provider's base URL in what the provider commands print", () => {
  let root: string;
  let paths: LayoutPaths;
  let printed: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-base-url-redaction-"));
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

  async function run(...argv: readonly string[]): Promise<string> {
    printed = [];
    const program = new Command().exitOverride();
    registerProviderCommand(program, fakeCommandDeps(paths));
    await program.parseAsync(["provider", ...argv], { from: "user" });
    return printed.join("\n");
  }

  function expectNamedWithoutCredentials(output: string): void {
    expect(output).toContain(NAMED_BASE_URL);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("abc123");
  }

  it("names it without its userinfo or query on add, set and list, through the endpoint description", async () => {
    expectNamedWithoutCredentials(await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy"));
    expect(readProvider(paths, "local")).toMatchObject({ baseUrl: SECRET_BASE_URL });
    expectNamedWithoutCredentials(await run("set", "local", "--display-name", "Renamed"));
    expectNamedWithoutCredentials(await run("list"));
  });

  it("names it without its userinfo or query on show", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy");
    expectNamedWithoutCredentials(await run("show", "local"));
  });

  it("names it without its userinfo or query in the endpoint description", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy");
    const provider = readProvider(paths, "local");
    if (provider === undefined) {
      throw new Error("the provider was not written");
    }
    expectNamedWithoutCredentials(describeProviderEndpoint(provider));
  });
});

describe("a provider's base URL in the JSON views and the catalogue report", () => {
  let root: string;
  let paths: LayoutPaths;
  let printed: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-base-url-views-"));
    paths = buildLayoutPaths(root);
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    printed = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(...argv: readonly string[]): Promise<string> {
    printed = [];
    const program = new Command().exitOverride();
    registerProviderCommand(program, fakeCommandDeps(paths));
    await program.parseAsync(["provider", ...argv], { from: "user" });
    return printed.join("\n");
  }

  async function addWithCatalogue(): Promise<void> {
    await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy", "--catalogue-tier", "sonnet");
    fs.mkdirSync(paths.catalogueDir, { recursive: true });
    fs.writeFileSync(catalogueCachePath(paths, "local"), JSON.stringify({ fetchedAt: 1, url: SECRET_BASE_URL, models: [{ id: "m" }] }));
  }

  it("redacts it in provider list --json, which many consumers read", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy");
    const output = await run("list", "--json");
    expect(output).toContain(NAMED_BASE_URL);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("abc123");
  });

  it("redacts it in the JSON a write prints, provider add --json and provider set --json", async () => {
    const added = await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy", "--json");
    expect(added).not.toContain("hunter2");
    expect(added).not.toContain("abc123");
    expect(JSON.parse(added)).toMatchObject({ action: "created", value: { baseUrl: NAMED_BASE_URL } });
    const updated = await run("set", "local", "--display-name", "Renamed", "--json");
    expect(updated).not.toContain("hunter2");
    expect(updated).not.toContain("abc123");
    expect(JSON.parse(updated)).toMatchObject({ action: "updated", value: { baseUrl: NAMED_BASE_URL } });
    // The file keeps the value it was given.
    expect(readProvider(paths, "local")).toMatchObject({ baseUrl: SECRET_BASE_URL });
  });

  it("prints no secret in the JSON of provider add, set and rename, whatever kind of credential source the provider has", async () => {
    // A secret can sit in a literal's value or in a command's arguments; the other kinds name where a secret is and hold none, and are here to show their JSON is the summary too.
    const SECRET = "TOPSECRETVALUE";
    const sources: readonly (readonly [string, string])[] = [
      ["literal", `literal:${SECRET}`],
      ["command", `command:vault read --token ${SECRET}`],
      ["env", "env:SOME_TOKEN"],
      ["file", "file:/run/secrets/token"],
      ["op", "op:op://vault/item/field"],
      ["keychain", "keychain:service:account"],
    ];
    for (const [kind, credential] of sources) {
      const name = `p-${kind}`;
      const outputs = [
        await run("add", name, "--display-name", "P", "--base-url", SECRET_BASE_URL, "--credential", credential, "--json"),
        await run("set", name, "--display-name", "Renamed", "--json"),
        await run("rename", name, `${name}-renamed`, "--json"),
      ];
      for (const output of outputs) {
        expect(output, kind).not.toContain(SECRET);
        expect(output, kind).not.toContain("hunter2");
      }
      expect(JSON.parse(outputs[0] ?? "{}"), kind).toMatchObject({ value: { credential: { sources: [{ kind }] } } });
    }
  });

  it("gives it whole in provider show --json, which prints the file's own fields so the value round-trips", async () => {
    await run("add", "local", "--display-name", "Local", "--base-url", SECRET_BASE_URL, "--credential", "literal:dummy");
    expect(JSON.parse(await run("show", "local", "--json"))).toMatchObject({ baseUrl: SECRET_BASE_URL });
  });

  it("redacts the catalogue's URL in provider models, in text and in JSON", async () => {
    await addWithCatalogue();
    for (const output of [await run("models", "local"), await run("models", "local", "--json")]) {
      expect(output).toContain(NAMED_BASE_URL);
      expect(output).not.toContain("hunter2");
      expect(output).not.toContain("abc123");
    }
  });
});

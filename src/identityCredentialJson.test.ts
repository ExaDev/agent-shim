import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps } from "./test-helpers";

const SECRET = "TOPSECRETVALUE";

describe("the JSON an identity write prints", () => {
  let root: string;
  let paths: LayoutPaths;
  let printed: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-identity-json-"));
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
    await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn() }).parseAsync(["identity", ...argv], { from: "user" });
    return printed.join("\n");
  }

  it("names the agent of an identity it creates", async () => {
    expect(JSON.parse(await run("add", "codex-one", "--agent", "codex", "--json"))).toMatchObject({ action: "created", value: { name: "codex-one", agent: "codex" } });
  });

  it("prints no secret in identity add or identity set, whatever kind of credential source the identity has", async () => {
    // A secret can sit in a literal's value or in a command's arguments; the other kinds name where a secret is and hold none, and are here to show their JSON is the summary too.
    const sources: readonly (readonly [string, string])[] = [
      ["literal", `literal:${SECRET}`],
      ["command", `command:vault read --token ${SECRET}`],
      ["env", "env:SOME_TOKEN"],
      ["file", "file:/run/secrets/token"],
      ["op", "op:op://vault/item/field"],
      ["keychain", "keychain:service:account"],
    ];
    for (const [kind, credential] of sources) {
      const name = `i-${kind}`;
      const added = await run("add", name, "--json");
      expect(added, kind).not.toContain(SECRET);
      const set = await run("set", name, "--credential", credential, "--json");
      expect(set, kind).not.toContain(SECRET);
      expect(JSON.parse(set), kind).toMatchObject({ action: "updated", value: { name, credential: { sources: [{ kind }] } } });
      const again = await run("set", name, "--label", "renamed", "--json");
      expect(again, kind).not.toContain(SECRET);
      expect(JSON.parse(again), kind).toMatchObject({ value: { credential: { sources: [{ kind }] } } });
    }
  });
});

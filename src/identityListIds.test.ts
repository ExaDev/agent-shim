import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps } from "./test-helpers";

describe("identity list", () => {
  let root: string;
  let paths: LayoutPaths;
  let out: string[];

  /** Stores an identity named `name` under id `id`. */
  function stored(id: string, name: string): void {
    fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), JSON.stringify({ name, allowAmbientCredential: false }));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-list-ids-test-"));
    paths = buildLayoutPaths(root);
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function list(): Promise<readonly string[]> {
    await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn() }).parseAsync(["identity", "list"], { from: "user" });
    return out.map((line) => line.trim());
  }

  it("shows the id beside a name that differs from it, and nothing beside one that is its own id", async () => {
    stored("work", "client");
    stored("personal", "personal");
    expect(await list()).toEqual(["client (id: work)", "personal"]);
  });

  it("shows the id of every identity claiming a shared name, so each can be renamed by its id", async () => {
    stored("work", "work");
    stored("work-2", "work");
    expect(await list()).toEqual(["work (id: work)", "work (id: work-2)"]);
  });
});

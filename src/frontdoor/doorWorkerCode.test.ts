import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DOOR_WORKER_CODE_ASSET } from "../../scripts/bundle-options.mts";

const sea = vi.hoisted(() => ({ isSea: false, assets: new Map<string, string>() }));

vi.mock("node:sea", () => ({
  isSea: () => sea.isSea,
  getAsset: (name: string) => {
    const text = sea.assets.get(name);
    if (text === undefined) {
      throw new Error(`no asset ${name}`);
    }
    return text;
  },
}));

describe("readDoorWorkerCode", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-worker-code-"));
    sea.isSea = false;
    sea.assets.clear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the bundle file's text once when the process is not a single-executable build, so removing the file afterwards changes nothing", async () => {
    const { readDoorWorkerCode } = await import("./doorWorker");
    const bundle = path.join(dir, "cli.cjs");
    fs.writeFileSync(bundle, "the bundle text");
    const code = readDoorWorkerCode(bundle);
    fs.rmSync(bundle);
    expect(code).toBe("the bundle text");
  });

  it("reads the embedded asset of a single-executable build, never the executable's own file, which is not code a worker can evaluate", async () => {
    const { readDoorWorkerCode } = await import("./doorWorker");
    sea.isSea = true;
    sea.assets.set(DOOR_WORKER_CODE_ASSET, "the embedded text");
    expect(readDoorWorkerCode(path.join(dir, "agent-shim-sea-does-not-exist"))).toBe("the embedded text");
  });
});

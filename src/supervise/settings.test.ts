import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { realFarmFs } from "../realPorts";
import { createFakeFarmFs, paths } from "../test-helpers";
import { stageSupervisedSettings } from "./settings";

const PID = 123;
const PERMISSION_MASK = 0o777;
const OWNER_READ_WRITE = 0o600;

describe("stageSupervisedSettings", () => {
  it("writes caller settings with owner-only permissions on the real filesystem", () => {
    const directory = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-settings-test-"));
    try {
      const staged = stageSupervisedSettings(realFarmFs, { ...paths, superviseDir: directory }, "pool", "session", PID, '{"env":{"TOKEN":"fixture"}}');
      expect(nodeFs.statSync(staged.file).mode & PERMISSION_MASK).toBe(OWNER_READ_WRITE);
      staged.release();
      expect(nodeFs.existsSync(staged.file)).toBe(false);
    } finally {
      nodeFs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps the composed settings in a private store until the launch releases it", () => {
    const fs = createFakeFarmFs({});
    const contents = '{"env":{"TOKEN":"fixture"}}';
    const staged = stageSupervisedSettings(fs, paths, "pool", "session", PID, contents);
    expect(staged.file).not.toContain("fixture");
    expect(fs.readFileUtf8(staged.file)).toBe(`${contents}\n`);
    staged.release();
    expect(fs.readFileUtf8(staged.file)).toBeUndefined();
  });
});

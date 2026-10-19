import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { realStatuslinePorts } from "./ports";

describe("realStatuslinePorts", () => {
  const ports = realStatuslinePorts({ HOME: "/h" });

  it("carries the environment it was given and the home directory", () => {
    expect(ports.env).toEqual({ HOME: "/h" });
    expect(ports.homeDirectory).toBe(os.homedir());
  });

  it("reads a file's text, and reports a file it cannot read as undefined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "hello");
      expect(ports.readText(file)).toBe("hello");
      expect(ports.readText(path.join(dir, "missing.txt"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("runs a program without a shell in the directory given, and reports a failure as undefined", () => {
    expect(ports.run(process.execPath, ["-p", "process.cwd()"], os.tmpdir())).toBe(`${fs.realpathSync(os.tmpdir())}\n`);
    expect(ports.run(process.execPath, ["-e", "process.exit(3)"], os.tmpdir())).toBeUndefined();
    expect(ports.run("/nonexistent/program", [], os.tmpdir())).toBeUndefined();
    expect(ports.run("echo", ["$HOME"], os.tmpdir())).toBe("$HOME\n");
  });
});

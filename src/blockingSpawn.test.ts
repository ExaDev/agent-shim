import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { spawnSyncBlocking } from "./blockingSpawn";

/** The files of `src` that name `spawnSyncUnbounded`, by `git grep`, excluding tests. */
function filesNaming(identifier: string): readonly string[] {
  const root = path.resolve(__dirname, "..");
  const out = execFileSync("git", ["grep", "-l", "-w", identifier, "--", "src", ":!*.test.ts"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter((line) => line !== "").sort();
}

describe("spawnSyncUnbounded", () => {
  it("is used by the one caller whose run is the session itself, and by the module that defines it", () => {
    expect(filesNaming("spawnSyncUnbounded")).toEqual(["src/blockingSpawn.ts", "src/realPorts.ts"]);
  });
});

describe("spawnSyncBlocking", () => {
  it("ends a program that outlasts its timeout, which every call must name", () => {
    const result = spawnSyncBlocking("a test sleep", process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { encoding: "utf8", timeout: 200 });
    expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
  });
});

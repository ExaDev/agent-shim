import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CommandTimeout, listSuite, runCommand } from "./keptTestsIo";

/** A program that outlives any timeout the tests give it. */
const SLEEPER = "setTimeout(() => undefined, 60000)";

/** A timeout short enough that the sleeper is certain to overrun it. */
const SHORT_TIMEOUT_MS = 300;

describe("runCommand", () => {
  it("gives the standard output of a program that finishes", async () => {
    expect(await runCommand(process.execPath, ["-e", "process.stdout.write('done')"])).toBe("done");
  });

  it("stops a program that runs past its timeout and says so as a CommandTimeout, not as a failure", async () => {
    await expect(runCommand(process.execPath, ["-e", SLEEPER], { timeout: SHORT_TIMEOUT_MS })).rejects.toBeInstanceOf(CommandTimeout);
  });

  it("reports a program that fails with its error and its standard error", async () => {
    await expect(runCommand(process.execPath, ["-e", "console.error('why'); process.exit(3)"])).rejects.toThrow(/failed[\s\S]*why/u);
  });
});

const roots: string[] = [];

/** What the fake prints for `--filesOnly`: one file. */
const FILES_ONLY = 'process.stdout.write(JSON.stringify([{ file: "/x/a.test.ts" }]));';

/** A budget that a finished program is far inside and a sleeper far past (the sleeper outlives the short timeout). */
const GENEROUS_MS = 30_000;

/** A checkout whose vitest is a program that prints one test file for `--filesOnly` and, for the full listing, does what `fullListing` says. */
function fakeCheckout(fullListing: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kept-tests-io-")));
  fs.mkdirSync(path.join(root, "node_modules", "vitest"), { recursive: true });
  const program = `const filesOnly = process.argv.includes("--filesOnly");\nif (filesOnly) { ${FILES_ONLY} } else { ${fullListing} }\n`;
  fs.writeFileSync(path.join(root, "node_modules", "vitest", "vitest.mjs"), program);
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("listSuite", () => {
  it("gives the listing of a vitest that finishes inside its budget", async () => {
    const root = fakeCheckout('process.stdout.write(JSON.stringify([{ name: "d > t", file: "/x/a.test.ts" }]));');
    expect(await listSuite(root, { budgetMs: () => GENEROUS_MS })).toEqual([{ name: "d > t", file: "/x/a.test.ts" }]);
  });

  it("reports a full listing past its budget as a slow host, naming the files, and not as the timeout or a wrong table", async () => {
    const root = fakeCheckout(SLEEPER);
    await expect(listSuite(root, { budgetMs: (files) => (files === 0 ? GENEROUS_MS : SHORT_TIMEOUT_MS) })).rejects.toThrow(/suite listing of 1 test files was not finished[\s\S]*this host was too slow/u);
  });

  it("reports the call that finds the test files, past its budget, as a slow host too", async () => {
    // A vitest that never answers, even when asked only for the files.
    const root = fakeCheckout("");
    fs.writeFileSync(path.join(root, "node_modules", "vitest", "vitest.mjs"), SLEEPER);
    await expect(listSuite(root, { budgetMs: () => SHORT_TIMEOUT_MS })).rejects.toThrow(/finding the suite's test files was not finished[\s\S]*this host was too slow/u);
  });

  it("gives the failure of a vitest that fails as that failure, not as a slow host", async () => {
    const root = fakeCheckout("process.stderr.write('why'); process.exit(3);");
    const failure = await listSuite(root, { budgetMs: () => GENEROUS_MS }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/failed[\s\S]*why/u);
    expect(String(failure)).not.toContain("too slow");
  });
});

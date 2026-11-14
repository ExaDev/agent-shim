import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { reportFatalError } from "./cliReport";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { createFakeKeychain, type FakeKeychain } from "./keychainTestWorld";
import { realIdentityRenamePorts } from "./realIdentityRename";
import { fakeCommandDeps } from "./test-helpers";

/**
 * The command-line harness the program's tests share: a throwaway state root per test (its hooks register in the test file that imports this module) and `cli`, which runs one `agent-shim` invocation against it as `src/cli.ts` does.
 */

/** The fake Keychain the commands of the test running now ask, set before each test. */
export let keychain: FakeKeychain = createFakeKeychain();

/** The throwaway state root of the test running now, set before each test. */
export let root: string;
/** Its layout. */
export let paths: LayoutPaths;

beforeEach(() => {
  keychain = createFakeKeychain();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-program-"));
  paths = buildLayoutPaths(root);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunClaude = (args: readonly string[]) => Promise<void>;

export function program(runClaude: RunClaude = vi.fn<RunClaude>(), options: Parameters<typeof fakeCommandDeps>[1] = {}): Command {
  // The identity commands ask the Keychain whether a login is filed for a directory; a fake one answers, so no test runs `security` against the real Keychain, whose answer depends on the machine and whose time limit a loaded machine can exceed.
  return buildProgram({ ...fakeCommandDeps(paths, options), runClaude, identityRenamePorts: { ...realIdentityRenamePorts(paths), run: keychain.run } });
}

/** Runs one `agent-shim` invocation against the throwaway layout the way `src/cli.ts` does, capturing both streams and the exit status `reportFatalError` or the command itself decided. */
export async function cli(argv: readonly string[], options: Parameters<typeof fakeCommandDeps>[1] = {}): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
    out.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "error").mockImplementation((...args: readonly unknown[]) => {
    err.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  let code: number;
  try {
    await program(vi.fn<RunClaude>(), options).parseAsync([...argv], { from: "user" });
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    code = reportFatalError(error, {
      writeErr: (line) => {
        err.push(`${line}\n`);
      },
      env: {},
    });
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}


/** Asserts that a command succeeded, with its standard error as the failure message, so a failure says why the command failed and not only that it did. */
export function expectOk(result: Readonly<CliResult>): void {
  expect(result.code, result.stderr).toBe(0);
}

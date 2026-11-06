import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const EXECUTABLE_MODE = 0o755;
const PRIVATE_DIRECTORY_MODE = 0o700;
const FAILURE_CODE = 17;
const SIGNAL_EXIT = 143;

describe.skipIf(process.platform === "win32")("Codex CLI entrypoint", () => {
  let bundleRoot: string;
  let cli: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  beforeAll(async () => {
    bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-bundle-"));
    cli = path.join(bundleRoot, "cli.cjs");
    await build({ entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: cli, banner: { js: 'const __agentShimImportMetaUrl = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;' }, define: { "import.meta.url": "__agentShimImportMetaUrl" }, logLevel: "silent" });
  });
  afterAll(() => { fs.rmSync(bundleRoot, { recursive: true, force: true }); });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-entry-"));
    const fake = path.join(root, "codex");
    fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');\nif (process.argv.includes('wait-for-signal')) { process.on('SIGTERM', () => process.exit(143)); console.log('ready'); setInterval(() => {}, 1000); } else {\nconsole.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME })); process.exit(Number(process.env.TEST_EXIT || '0')); }\n`, { mode: EXECUTABLE_MODE });
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    // Deliberately whitelist the environment rather than inheriting a developer's credentials or shim selections.
    env = { PATH: process.env.PATH, HOME: home, AGENT_SHIM_HOME: path.join(root, "shim"), AGENT_SHIM_CODEX_BIN: fake, AGENT_SHIM_CODEX_HOME: path.join(root, "canonical") };
    execFileSync(process.execPath, [cli, "identity", "add", "work", "--agent", "codex"], { env });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("creates a typed identity and forwards the native argv through the compiled command tree", () => {
    const native = ["exec", "--profile", "native", "--", "@prompt", "--identity", "literal"];
    const output = execFileSync(process.execPath, [cli, "run", "--agent", "codex", "@work", ...native], { env, encoding: "utf8" });
    const value = JSON.parse(output) as { args: string[]; home: string; sqlite: string };
    const injected = ["-c", 'cli_auth_credentials_store="file"', "-c", `sqlite_home=${JSON.stringify(value.home)}`];
    expect(value.args).toEqual([...injected, ...native]);
    expect(value.home).toBe(path.join(root, "shim", "identities", "work"));
    expect(value.sqlite).toBe(value.home);
    expect(fs.statSync(value.home).mode & EXECUTABLE_MODE).toBe(PRIVATE_DIRECTORY_MODE);
    expect(JSON.parse(fs.readFileSync(path.join(value.home, "identity.json"), "utf8"))).toMatchObject({ name: "work", agent: "codex" });
    const shown = JSON.parse(execFileSync(process.execPath, [cli, "identity", "show", "work", "--json"], { env, encoding: "utf8" })) as { agent: string };
    expect(shown.agent).toBe("codex");
  });

  it("propagates a native child's failure status", async () => {
    const child = spawn(process.execPath, [cli, "run", "--agent=codex", "@work", "exec"], { env: { ...env, TEST_EXIT: String(FAILURE_CODE) }, stdio: "ignore" });
    expect(await new Promise((resolve) => { child.on("close", resolve); })).toBe(FAILURE_CODE);
  });

  it("forwards SIGTERM to the real child and exits after it", async () => {
    const child = spawn(process.execPath, [cli, "run", "--agent", "codex", "@work", "wait-for-signal"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise<number | null>((resolve) => { child.on("close", resolve); });
    const ready = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", () => { resolve(); });
      child.on("close", () => { reject(new Error("launcher exited before child was ready")); });
    });
    try {
      await ready;
      child.kill("SIGTERM");
      expect(await exit).toBe(SIGNAL_EXIT);
    } finally { child.kill("SIGKILL"); }
  });

  it("refuses its own executable as the Codex binary instead of recursing", () => {
    expect(() => execFileSync(process.execPath, [cli, "run", "--agent", "codex", "@work", "--version"], { env: { ...env, AGENT_SHIM_CODEX_BIN: cli }, stdio: "pipe" })).toThrow("No real Codex CLI");
  });
});

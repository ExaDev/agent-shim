import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const EXECUTABLE_MODE = 0o755;
/** What the stand-in `claude` prints on standard output: the only thing a caller piping a `--print` session may receive there. */
const CHILD_OUTPUT = "output of the child";

describe.skipIf(process.platform === "win32")("a launch's streams under --print", () => {
  let bundleRoot: string;
  let cli: string;
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-streams-bundle-"));
    cli = path.join(bundleRoot, "cli.cjs");
    await build({ entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: cli, banner: { js: 'const __agentShimImportMetaUrl = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;' }, define: { "import.meta.url": "__agentShimImportMetaUrl" }, logLevel: "silent" });
  });
  afterAll(() => {
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-streams-"));
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(CHILD_OUTPUT)}\n`, { mode: EXECUTABLE_MODE });
    // The environment is whitelisted so a developer's credentials and shim selections stay out.
    env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home, AGENT_SHIM_HOME: path.join(root, "shim"), AGENT_SHIM_CLAUDE_HOME: path.join(root, "claude-home") };
    execFileSync(process.execPath, [cli, "identity", "add", "t"], { env });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes nothing of its own to standard output, and its report to standard error", () => {
    // --no-track-usage keeps the launch off the front door, which a test has no daemon for.
    const run = spawnSync(process.execPath, [cli, "run", "@t", "--no-track-usage", "-p", "ok"], { env, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${CHILD_OUTPUT}\n`);
    expect(run.stderr).toContain("identity");
  });
});

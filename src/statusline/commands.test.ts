import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { registerStatuslineCommand } from "./commands";

/** The variables the command reads that a developer's own session, which these tests may run inside, would otherwise leak in. */
const SESSION_VARIABLES = [
  "AGENT_SHIM_STATUSLINE",
  "AGENT_SHIM_STATUSLINE_CMD",
  "AGENT_SHIM_CONFIG_PROFILE",
  "AGENT_SHIM_PROVIDER",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CONFIG_DIR",
  "COLUMNS",
] as const;

let home: string;
let paths: LayoutPaths;
let project: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "statusline-command-")));
  paths = buildLayoutPaths(path.join(home, ".agent-shim"));
  project = path.join(home, "work", "project");
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv("HOME", home);
  for (const name of SESSION_VARIABLES) {
    vi.stubEnv(name, undefined);
  }
  vi.spyOn(process, "cwd").mockReturnValue(project);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Runs one `agent-shim statusline` invocation the way the client does: the payload on standard input, the line on standard output. */
async function runStatusline(): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  const program = new Command().exitOverride();
  registerStatuslineCommand(program, { paths });
  const done = program.parseAsync(["statusline"], { from: "user" });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  process.stdin.emit("data", Buffer.from(JSON.stringify({ model: { id: "m", display_name: "Opus 5.5" } })));
  process.stdin.emit("end");
  await done;
  logSpy.mockRestore();
  errSpy.mockRestore();
  return { stdout: out.join("\n"), stderr: err.join(""), exitCode: typeof process.exitCode === "number" ? process.exitCode : 0 };
}

describe("agent-shim statusline", () => {
  it("draws a config edit made between two renders on the second", async () => {
    writeJson(paths.globalConfigFile, { launch: { statusline: { customLine: { text: "first wording" } } } });
    expect((await runStatusline()).stdout).toContain("first wording");
    writeJson(paths.globalConfigFile, { launch: { statusline: { customLine: { text: "second wording" } } } });
    const second = await runStatusline();
    expect(second.stdout).toContain("second wording");
    expect(second.stdout).not.toContain("first wording");
  });

  it("draws the settings in AGENT_SHIM_STATUSLINE over the config's when the variable is set", async () => {
    writeJson(paths.globalConfigFile, { launch: { statusline: { customLine: { text: "from the config" } } } });
    vi.stubEnv("AGENT_SHIM_STATUSLINE", JSON.stringify({ customLine: { text: "from the launch" } }));
    const run = await runStatusline();
    expect(run.stdout).toContain("from the launch");
    expect(run.stdout).not.toContain("from the config");
  });

  it("resolves the directory rules for the working directory it is run in", async () => {
    writeJson(paths.directoryRulesFile, { rules: [{ path: project, launch: { statusline: { customLine: { text: "for this project" } } } }] });
    expect((await runStatusline()).stdout).toContain("for this project");
    vi.spyOn(process, "cwd").mockReturnValue(home);
    expect((await runStatusline()).stdout).not.toContain("for this project");
  });

  it("resolves the identity's default configuration profile from the session's configuration directory", async () => {
    writeJson(path.join(paths.identitiesDir, "alice", "identity.json"), { name: "alice", defaultConfigProfile: "alice-profile" });
    writeJson(path.join(paths.configProfilesDir, "alice-profile.json"), { launch: { statusline: { customLine: { text: "for alice" } } } });
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(paths.identitiesDir, "alice"));
    expect((await runStatusline()).stdout).toContain("for alice");
  });

  it("draws with the defaults and exits 0 when the config cannot be read, saying why on standard error only", async () => {
    const withoutConfig = await runStatusline();
    fs.mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    fs.writeFileSync(paths.globalConfigFile, "{ not json");
    const run = await runStatusline();
    expect(run.stdout).toBe(withoutConfig.stdout);
    expect(run.stdout).not.toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(paths.globalConfigFile);
    expect(run.stderr).toMatch(/^agent-shim: statusline: /);
  });

  it("draws with the defaults and exits 0 when the config holds settings that cannot be drawn together", async () => {
    const withoutConfig = await runStatusline();
    writeJson(paths.globalConfigFile, { launch: { statusline: { bands: { warnAt: 95 } } } });
    const run = await runStatusline();
    expect(run.stdout).toBe(withoutConfig.stdout);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("bands.warnAt");
  });
});

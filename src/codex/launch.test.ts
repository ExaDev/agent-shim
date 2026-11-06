import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectCheckReport, checkReportToJson } from "../checkReport";
import { CheckReportJsonSchema } from "../checkReportSchema";
import { cosmiconfigReader } from "../config/load";
import { addIdentity } from "../identityStore";
import { buildLayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { realSignalPort, realSupervisedSpawnPort } from "../supervise/realPorts";
import { prepareCodexLaunch, runCodexChild, type CodexLaunchOptions } from "./launch";

const INJECTED_ARG_COUNT = 4;
const CHILD_EXIT = 7;
const SIGNAL_OFFSET = 128;
const SIGNAL_COUNT = 3;

describe("Codex native identities", () => {
  let root: string;
  let options: CodexLaunchOptions;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-codex-launch-"));
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, "project"));
    options = { paths: buildLayoutPaths(path.join(root, "shim")), argv: ["@one"], env: {}, home, cwd: path.join(home, "project"), fs: realFarmFs, read: cosmiconfigReader(), resolveBinary: () => process.execPath, now: Date.now, pid: process.pid, isRunning: () => false, sleep: () => undefined, uniqueSuffix: "test", warn: () => undefined };
    addIdentity(options.paths, "one", { agent: "codex" });
    addIdentity(options.paths, "two", { agent: "codex" });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };

  it("checks Codex ambient authentication even without a selected identity", () => {
    const report = collectCheckReport({ paths: options.paths, cwd: options.cwd, agent: "codex", env: { AGENT_SHIM_CODEX_HOME: path.join(options.home, ".codex"), CODEX_API_KEY: "test-secret" } });
    expect(report.identityName).toBeUndefined();
    expect(report.ambientCredential).toMatchObject({ ok: false, variable: "CODEX_API_KEY" });
    expect(report.claudeVersion).toBeUndefined();
  });

  it("checks Codex sharing and ambient credentials without changing the farm or probing Claude's Keychain", () => {
    write(path.join(options.home, ".codex", "auth.json"), "private");
    write(path.join(options.home, ".codex", "AGENTS.md"), "instructions");
    const report = collectCheckReport({ paths: options.paths, cwd: options.cwd, identity: "one", agent: "codex", env: { AGENT_SHIM_CODEX_HOME: path.join(options.home, ".codex"), CODEX_API_KEY: "test-secret", CLAUDE_CONFIG_DIR: "irrelevant" } });
    expect(report.resolved.decisions.get("auth.json")?.shared).toBe(false);
    expect(report.resolved.decisions.get("AGENTS.md")?.shared).toBe(true);
    expect(report.ambientCredential).toMatchObject({ ok: false, variable: "CODEX_API_KEY" });
    expect(report.keychain).toBeUndefined();
    expect(report.claudeVersion).toBeUndefined();
    expect(CheckReportJsonSchema.safeParse(checkReportToJson(report)).success).toBe(true);
    expect(fs.existsSync(path.join(options.paths.identitiesDir, "one", ".agent-shim-farm.json"))).toBe(false);
  });

  it("shares Codex configuration and knowledge, keeps logins and databases private, and preserves private data on resync", () => {
    const canonical = path.join(options.home, ".codex");
    write(path.join(canonical, "auth.json"), "canonical-secret");
    write(path.join(canonical, "state_5.sqlite"), "canonical-database");
    write(path.join(canonical, "AGENTS.md"), "instructions");
    write(path.join(canonical, "config.toml"), 'model = "test"');
    const one = prepareCodexLaunch(options);
    const oneHome = one.env.CODEX_HOME ?? "";
    write(path.join(oneHome, "auth.json"), "one-secret");
    write(path.join(oneHome, "state_5.sqlite"), "one-database");
    const two = prepareCodexLaunch({ ...options, argv: ["@two"], env: { CODEX_HOME: oneHome, CODEX_SQLITE_HOME: oneHome, CLAUDE_CONFIG_DIR: "irrelevant" } });
    expect(two.env.CODEX_HOME).not.toBe(oneHome);
    expect(two.env.CODEX_SQLITE_HOME).toBe(two.env.CODEX_HOME);
    expect(fs.existsSync(path.join(two.env.CODEX_HOME ?? "", "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(two.env.CODEX_HOME ?? "", "state_5.sqlite"))).toBe(false);
    expect(fs.readlinkSync(path.join(oneHome, "AGENTS.md"))).toBe(path.join(canonical, "AGENTS.md"));
    expect(fs.readFileSync(path.join(oneHome, "config.toml"), "utf8")).toContain('model = "test"');
    // Force a sharing change and a farm replacement, rather than merely checking the no-op path.
    prepareCodexLaunch({ ...options, argv: ["@one", "--hide", "knowledge/AGENTS.md"] });
    expect(fs.existsSync(path.join(oneHome, "AGENTS.md"))).toBe(false);
    expect(fs.readFileSync(path.join(oneHome, "auth.json"), "utf8")).toBe("one-secret");
    expect(fs.readFileSync(path.join(oneHome, "state_5.sqlite"), "utf8")).toBe("one-database");
    expect(fs.readFileSync(path.join(canonical, "auth.json"), "utf8")).toBe("canonical-secret");
  });

  it("cannot share authentication or SQLite files through broad entry overrides", () => {
    for (const name of ["auth.json", "auth.json.bak", "state_5.sqlite", "state_5.sqlite-wal"]) write(path.join(options.home, ".codex", name), "private");
    const launch = prepareCodexLaunch({ ...options, argv: ["@one", "--share", "knowledge/*"] });
    for (const name of ["auth.json", "auth.json.bak", "state_5.sqlite", "state_5.sqlite-wal"]) expect(fs.existsSync(path.join(launch.env.CODEX_HOME ?? "", name))).toBe(false);
  });

  it("forwards Codex flags, subcommands, @ prompts and -- without applying Claude's parser", () => {
    const args = ["exec", "-p", "native-profile", "--config", 'model="test"', "--remote-control", "--", "@prompt", "--identity", "literal"];
    const launch = prepareCodexLaunch({ ...options, argv: ["@one", ...args] });
    expect(launch.args.slice(INJECTED_ARG_COUNT)).toEqual(args);
    expect(launch.args.slice(0, INJECTED_ARG_COUNT)).toEqual(["-c", 'cli_auth_credentials_store="file"', "-c", `sqlite_home=${JSON.stringify(launch.env.CODEX_HOME)}`]);
    expect(prepareCodexLaunch({ ...options, argv: ["@one", "--help"] }).args.at(-1)).toBe("--help");
  });

  it("selects explicit, environment, directory and active identities in precedence order", () => {
    write(options.paths.activeIdentityFile, "one");
    write(path.join(options.cwd, ".agent-shim.json"), { identity: "two" });
    expect(prepareCodexLaunch({ ...options, argv: [] }).env.AGENT_SHIM_IDENTITY).toBe("two");
    expect(prepareCodexLaunch({ ...options, argv: [], env: { AGENT_SHIM_IDENTITY: "one" } }).env.AGENT_SHIM_IDENTITY).toBe("one");
    expect(prepareCodexLaunch({ ...options, argv: ["@two"], env: { AGENT_SHIM_IDENTITY: "one" } }).env.AGENT_SHIM_IDENTITY).toBe("two");
    fs.unlinkSync(path.join(options.cwd, ".agent-shim.json"));
    expect(prepareCodexLaunch({ ...options, argv: [] }).env.AGENT_SHIM_IDENTITY).toBe("one");
  });

  it("applies portable profiles and category overrides using the existing cascade", () => {
    write(path.join(options.home, ".codex", "skills", "test", "SKILL.md"), "skill");
    write(path.join(options.home, ".codex", "sessions", "thread.jsonl"), "history");
    write(path.join(options.paths.configProfilesDir, "private.json"), { categories: { history: false } });
    write(path.join(options.cwd, ".agent-shim.json"), { configProfile: "private" });
    const launch = prepareCodexLaunch(options);
    expect(fs.existsSync(path.join(launch.env.CODEX_HOME ?? "", "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(launch.env.CODEX_HOME ?? "", "skills", "test", "SKILL.md"))).toBe(true);
    const hidden = prepareCodexLaunch({ ...options, argv: ["@one", "--category", "knowledge=false"] });
    expect(fs.existsSync(path.join(hidden.env.CODEX_HOME ?? "", "skills"))).toBe(false);
  });

  it("refuses missing and wrong-agent identities, pools and unknown profiles", () => {
    addIdentity(options.paths, "claude");
    expect(() => prepareCodexLaunch({ ...options, argv: ["@claude"] })).toThrow("belongs to Claude");
    expect(() => prepareCodexLaunch({ ...options, argv: [] })).toThrow("No Codex identity");
    expect(() => prepareCodexLaunch({ ...options, argv: ["@missing"] })).toThrow("No identity");
    expect(() => prepareCodexLaunch({ ...options, argv: ["@pool:subs"] })).toThrow("Codex quota");
    expect(() => prepareCodexLaunch({ ...options, argv: ["@one", "--config-profile", "missing"] })).toThrow("No configuration profile");
    expect(fs.existsSync(path.join(options.paths.identitiesDir, "claude", ".agent-shim-farm.json"))).toBe(false);
  });

  it.each(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_IDENTITY_TOKEN_FILE"])("refuses %s without exposing its value, permits explicit opt-in", (key) => {
    expect(() => prepareCodexLaunch({ ...options, env: { [key]: "test-secret" } })).toThrow(key);
    try { prepareCodexLaunch({ ...options, env: { [key]: "test-secret" } }); } catch (error) { expect(String(error)).not.toContain("test-secret"); }
    expect(prepareCodexLaunch({ ...options, env: { [key]: "test-secret", AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL: "1" } }).env[key]).toBe("test-secret");
  });

  it.each([["-c", 'cli_auth_credentials_store="keyring"'], ["--config=sqlite_home='/shared'"], ["-csqlite_home='/shared'"]])("refuses config overrides of identity boundaries: %j", (...args) => {
    expect(() => prepareCodexLaunch({ ...options, argv: ["@one", ...args] })).toThrow("identity isolation owns");
  });

  it("keeps the same home when an identity's display name changes", () => {
    const before = prepareCodexLaunch(options);
    const file = path.join(before.env.CODEX_HOME ?? "", "identity.json");
    const identity = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    write(file, { ...identity, name: "renamed" });
    expect(prepareCodexLaunch({ ...options, argv: ["@renamed"] }).env.CODEX_HOME).toBe(before.env.CODEX_HOME);
  });

  it("inherits stdio, preserves child exit codes and removes signal handlers", async () => {
    const script = path.join(root, "child.cjs");
    write(script, "process.exit(7)");
    const before = process.listenerCount("SIGTERM");
    expect(await runCodexChild({ bin: process.execPath, args: [script], env: {} }, realSupervisedSpawnPort, realSignalPort)).toBe(CHILD_EXIT);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it.skipIf(process.platform === "win32")("maps child signal termination to shell status", async () => {
    const script = path.join(root, "signal.cjs");
    write(script, "process.kill(process.pid, 'SIGTERM')");
    expect(await runCodexChild({ bin: process.execPath, args: [script], env: {} }, realSupervisedSpawnPort, realSignalPort)).toBe(SIGNAL_OFFSET + os.constants.signals.SIGTERM);
  });

  it("forwards parent signals and cleans up on a spawn failure", async () => {
    const kill = vi.fn<() => void>();
    const off = vi.fn<() => void>();
    await expect(runCodexChild({ bin: "missing", args: [], env: {} }, { spawn: () => ({ signal: kill, exit: Promise.resolve({ status: null, signal: null, error: new Error("ENOENT") }) }) }, { on: (signal, handler) => { if (signal === "SIGTERM") handler(); return off; } })).rejects.toThrow("ENOENT");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(off).toHaveBeenCalledTimes(SIGNAL_COUNT);
  });
});

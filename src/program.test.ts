import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Help, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_FAILURE, EXIT_USAGE } from "./cliError";
import { reportFatalError } from "./cliReport";
import { addIdentity, readActiveIdentity, readIdentity, useIdentity } from "./identityStore";
import { createProfile, readGlobalConfig, readProfile } from "./configProfilesStore";
import { readProvider } from "./providersStore";
import { listDirectoryRules } from "./directoryRulesStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps } from "./test-helpers";

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-program-"));
  paths = buildLayoutPaths(root);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunClaude = (args: readonly string[]) => Promise<void>;

function program(runClaude: RunClaude = vi.fn<RunClaude>(), options: Parameters<typeof fakeCommandDeps>[1] = {}): Command {
  return buildProgram({ ...fakeCommandDeps(paths, options), runClaude });
}

/** Runs one `agent-shim` invocation against the throwaway layout the way `src/cli.ts` does, capturing both streams and the exit status `reportFatalError` or the command itself decided. */
async function cli(argv: readonly string[], options: Parameters<typeof fakeCommandDeps>[1] = {}): Promise<CliResult> {
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

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function subcommandNames(command: Command, name: string): string[] {
  const noun = command.commands.find((candidate) => candidate.name() === name);
  if (noun === undefined) {
    throw new Error(`no ${name} command`);
  }
  return noun.commands.map((sub) => sub.name()).sort();
}

describe("buildProgram", () => {
  it("registers every top-level command without parsing or launching anything", () => {
    const runClaude = vi.fn<RunClaude>();
    const built = program(runClaude);

    expect(built.commands.map((command) => command.name()).sort()).toEqual(
      ["__frontdoor-supervisor", "__headroom-supervisor", "account", "check", "codex", "completion", "configure", "credential", "doctor", "frontdoor", "headroom", "identity", "pool", "profile", "provider", "rule", "run", "shim", "usage"].sort(),
    );
    expect(runClaude).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("gives every noun the same verb vocabulary", () => {
    const built = program();
    expect(subcommandNames(built, "identity")).toEqual(["add", "list", "remove", "resolve-conflicts", "set", "show", "use"]);
    expect(subcommandNames(built, "pool")).toEqual(["add", "list", "pick", "remove", "set", "show", "use"]);
    expect(subcommandNames(built, "profile")).toEqual(["add", "list", "remove", "set", "show", "use"]);
    expect(subcommandNames(built, "provider")).toEqual(["add", "list", "remove", "set", "show"]);
    expect(subcommandNames(built, "rule")).toEqual(["add", "list", "remove", "set", "show"]);
    expect(subcommandNames(built, "credential")).toEqual(["forget", "push", "store", "warm"]);
  });

  it("refuses to store a credential for an identity that does not exist", async () => {
    const result = await cli(["credential", "store", "ghost"]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("ghost");
  });

  it("refuses to take a token on a terminal, so it cannot land in shell history", async () => {
    expect((await cli(["identity", "add", "work"])).code).toBe(0);
    const result = await cli(["credential", "store", "work"], { interactive: true });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("standard input");
  });

  it("forwards run's arguments verbatim to the injected launcher", async () => {
    const runClaude = vi.fn<RunClaude>().mockResolvedValue(undefined);
    await program(runClaude).parseAsync(["run", "@work", "-p", "hi", "--", "--version"], { from: "user" });
    expect(runClaude).toHaveBeenCalledWith(["@work", "-p", "hi", "--", "--version"]);
  });

  it.each([
    [["rules", "list"]],
    [["profile", "create", "x"]],
    [["profile", "wizard"]],
    [["profile", "set-default", "x"]],
    [["identity", "set-default-profile", "a", "b"]],
    [["identity", "resolve", "a"]],
    [["rule", "add", "/p", "--profile", "x"]],
    [["profile", "set", "x", "--headroom"]],
    [["profile", "set", "x", "--skip-permissions"]],
    [["check", "--identity"]],
    [["provider", "set", "z", "--token-env", "Z_API_TOKEN"]],
    [["provider", "set", "z", "--token-command", "op", "read", "ref"]],
    [["provider", "set", "z", "--auth-scheme", "apiKey"]],
  ])("rejects the removed spelling %j as a usage error", async (argv) => {
    const result = await cli(argv);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/error:/);
  });

  it("shows help with a runnable example for every visible command", async () => {
    const help = new Help();
    const commandPaths: string[][] = [];
    const walk = (command: Command, prefix: readonly string[]): void => {
      for (const sub of help.visibleCommands(command)) {
        if (sub.name() === "help" || sub.name() === "run") {
          continue;
        }
        commandPaths.push([...prefix, sub.name()]);
        walk(sub, [...prefix, sub.name()]);
      }
    };
    walk(program(), []);
    expect(commandPaths.length).toBeGreaterThan(0);
    for (const commandPath of commandPaths) {
      const result = await cli([...commandPath, "--help"]);
      expect({ commandPath, code: result.code }).toEqual({ commandPath, code: 0 });
      expect(result.stdout).toContain("Examples:");
      expect(result.stdout).toContain("$ ");
    }
  });

  it("documents run, the launch flags, the exit statuses and the double-dash terminator in the root help", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("agent-shim run [@<identity>]");
    expect(result.stdout).toContain("--identity <name>");
    expect(result.stdout).toContain("--no-provider");
    expect(result.stdout).toContain("2 usage error");
    expect(result.stdout).toContain("64");
    expect(result.stdout).toContain("`--` terminator");
  });
});

describe("identity commands", () => {
  it("adds, shows and lists an identity, as text and as JSON", async () => {
    expect((await cli(["identity", "add", "work"])).code).toBe(0);
    expect((await cli(["identity", "add", "work"])).code).toBe(EXIT_FAILURE);
    useIdentity(paths, "work");

    const shown = await cli(["identity", "show", "work", "--json"]);
    expect(parseJson(shown.stdout)).toEqual({
      name: "work",
      active: true,
      directory: path.join(paths.identitiesDir, "work"),
      allowAmbientCredential: false,
    });
    expect((await cli(["identity", "show", "work"])).stdout).toContain("Identity: work (active)");

    const listed = await cli(["identity", "list", "--json"]);
    expect(parseJson(listed.stdout)).toEqual([expect.objectContaining({ name: "work", active: true })]);
    expect((await cli(["identity", "list"])).stdout).toContain("* work");
  });

  it("sets and clears the default profile through set, refusing a missing profile without a terminal", async () => {
    addIdentity(paths, "work");
    const missing = await cli(["identity", "set", "work", "--default-profile", "ghost"]);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.stderr).toContain('agent-shim: No configuration profile named "ghost"');

    createProfile(paths, "acme");
    expect((await cli(["identity", "set", "work", "--default-profile", "acme"])).code).toBe(0);
    expect(readIdentity(paths, "work")?.defaultConfigProfile).toBe("acme");

    expect((await cli(["identity", "set", "work", "--no-default-profile"])).code).toBe(0);
    expect(readIdentity(paths, "work")?.defaultConfigProfile).toBeUndefined();
  });

  it("offers to create a missing default profile on a terminal", async () => {
    addIdentity(paths, "work");
    const result = await cli(["identity", "set", "work", "--default-profile", "fresh"], {
      interactive: true,
      answers: ["create", ["knowledge"]],
    });
    expect(result.code).toBe(0);
    expect(readProfile(paths, "fresh")).toBeDefined();
    expect(readIdentity(paths, "work")?.defaultConfigProfile).toBe("fresh");
  });

  it("treats set with nothing to change as a usage error", async () => {
    addIdentity(paths, "work");
    expect((await cli(["identity", "set", "work"])).code).toBe(EXIT_USAGE);
  });

  it("sets, retargets and removes an identity's credential, reporting it by source kind and target only", async () => {
    addIdentity(paths, "work");
    expect((await cli(["identity", "set", "work", "--credential-target", "oauthToken"])).code).toBe(EXIT_USAGE);

    const set = await cli(["identity", "set", "work", "--credential-target", "oauthToken", "--credential", "op:op://vault/claude-work/token", "--credential", "file:~/.config/agent-shim/work.token"]);
    expect(set.code).toBe(0);
    expect(readIdentity(paths, "work")?.credential).toEqual({
      target: "oauthToken",
      sources: [{ op: "op://vault/claude-work/token" }, { file: "~/.config/agent-shim/work.token" }],
    });
    expect((await cli(["identity", "show", "work"])).stdout).toContain(
      "Credential: oauthToken from op op://vault/claude-work/token, then file ~/.config/agent-shim/work.token",
    );
    expect(parseJson((await cli(["identity", "show", "work", "--json"])).stdout)).toMatchObject({
      credential: { target: "oauthToken", sources: [{ kind: "op", reference: "op://vault/claude-work/token" }, { kind: "file", path: "~/.config/agent-shim/work.token" }] },
    });

    expect((await cli(["identity", "set", "work", "--credential", "env:WORK_TOKEN"])).code).toBe(0);
    expect(readIdentity(paths, "work")?.credential).toEqual({ target: "oauthToken", sources: [{ env: "WORK_TOKEN" }] });

    expect((await cli(["identity", "set", "work", "--no-credential"])).code).toBe(0);
    expect(readIdentity(paths, "work")?.credential).toBeUndefined();
    expect((await cli(["identity", "show", "work"])).stdout).toContain("Credential: (none; uses its stored login)");
  });

  it("requires --yes to remove without a terminal, then deletes the directory and clears the active selection", async () => {
    addIdentity(paths, "work");
    useIdentity(paths, "work");

    const refused = await cli(["identity", "remove", "work"]);
    expect(refused.code).toBe(EXIT_USAGE);
    expect(refused.stderr).toContain("pass --yes");
    expect(readIdentity(paths, "work")).toBeDefined();

    expect((await cli(["identity", "remove", "work", "--yes"])).code).toBe(0);
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
    expect(readActiveIdentity(paths)).toBeUndefined();
  });

  it("asks before removing on a terminal and keeps the identity when declined", async () => {
    addIdentity(paths, "work");
    expect((await cli(["identity", "remove", "work"], { interactive: true, answers: ["keep"] })).code).toBe(EXIT_FAILURE);
    expect(readIdentity(paths, "work")).toBeDefined();
    expect((await cli(["identity", "remove", "work"], { interactive: true, answers: ["remove"] })).code).toBe(0);
    expect(readIdentity(paths, "work")).toBeUndefined();
  });

  it("fails use for a missing identity without a terminal, and offers the wizard on one", async () => {
    const refused = await cli(["identity", "use", "ghost"]);
    expect(refused.code).toBe(EXIT_FAILURE);
    expect(refused.stderr).toContain('agent-shim: No identity named "ghost"');

    const created = await cli(["identity", "use", "fresh"], { interactive: true, answers: ["create", "skip"] });
    expect(created.code).toBe(0);
    expect(readActiveIdentity(paths)).toBe("fresh");
  });
});

describe("profile commands", () => {
  it("adds a profile with a repeated --extends, and refuses a duplicate", async () => {
    expect((await cli(["profile", "add", "acme", "--extends", "base", "--extends", "strict", "--description", "Acme"])).code).toBe(0);
    expect(readProfile(paths, "acme")).toEqual({ description: "Acme", extends: ["base", "strict"] });
    expect((await cli(["profile", "add", "acme", "--extends", "base"])).code).toBe(EXIT_FAILURE);
  });

  it("creates an empty profile without a terminal, needs a name there, and runs the wizard on one", async () => {
    expect((await cli(["profile", "add", "plain"])).code).toBe(0);
    expect(readProfile(paths, "plain")).toEqual({});
    expect((await cli(["profile", "add"])).code).toBe(EXIT_USAGE);

    expect((await cli(["profile", "add", "guided"], { interactive: true, answers: [["knowledge", "settings"]] })).code).toBe(0);
    expect(readProfile(paths, "guided")?.categories).toEqual({ history: false });
  });

  it("sets categories and entries one pair per repeated flag, rejecting a comma list", async () => {
    createProfile(paths, "acme");
    const result = await cli(["profile", "set", "acme", "--category", "history=false", "--category", "knowledge=0", "--entry", "knowledge/skills/commit=true"]);
    expect(result.code).toBe(0);
    expect(readProfile(paths, "acme")).toMatchObject({
      categories: { history: false, knowledge: false },
      entries: { "knowledge/skills/commit": true },
    });

    expect((await cli(["profile", "set", "acme", "--category", "history=true,knowledge=false"])).code).toBe(EXIT_USAGE);
  });

  it("sets and clears launch settings under their own --launch-* names", async () => {
    createProfile(paths, "acme");
    await cli(["profile", "set", "acme", "--launch-headroom", "--no-launch-skip-permissions", "--launch-provider", "z"]);
    expect(readProfile(paths, "acme")?.launch).toEqual({ headroom: true, skipPermissions: false, provider: "z" });

    await cli(["profile", "set", "acme", "--no-launch-provider"]);
    expect(readProfile(paths, "acme")?.launch).toEqual({ headroom: true, skipPermissions: false });
  });

  it("sets and clears a Claude Code version pin, and refuses one that is not an exact version", async () => {
    createProfile(paths, "acme");
    await cli(["profile", "set", "acme", "--launch-claude-version", "2.1.220"]);
    expect(readProfile(paths, "acme")?.launch).toEqual({ claudeVersion: "2.1.220" });
    const refused = await cli(["profile", "set", "acme", "--launch-claude-version", "latest"]);
    expect(refused.code).toBe(EXIT_FAILURE);
    expect(readProfile(paths, "acme")?.launch).toEqual({ claudeVersion: "2.1.220" });
    await cli(["profile", "set", "acme", "--no-launch-claude-version"]);
    expect(readProfile(paths, "acme")?.launch).toBeUndefined();
  });

  it("needs something to change without a terminal", async () => {
    createProfile(paths, "acme");
    expect((await cli(["profile", "set", "acme"])).code).toBe(EXIT_USAGE);
  });

  it("shows and lists profiles as JSON, marking the global default set by use", async () => {
    createProfile(paths, "acme", ["base"]);
    expect((await cli(["profile", "use", "ghost"])).code).toBe(EXIT_FAILURE);
    expect((await cli(["profile", "use", "acme"])).code).toBe(0);
    expect(readGlobalConfig(paths)?.defaultConfigProfile).toBe("acme");

    expect(parseJson((await cli(["profile", "show", "acme", "--json"])).stdout)).toEqual({ name: "acme", globalDefault: true, extends: ["base"] });
    expect(parseJson((await cli(["profile", "list", "--json"])).stdout)).toEqual([{ name: "acme", globalDefault: true, extends: ["base"] }]);
    expect((await cli(["profile", "show", "ghost"])).code).toBe(EXIT_FAILURE);
  });

  it("removes a profile only with --yes when there is no terminal", async () => {
    createProfile(paths, "acme");
    expect((await cli(["profile", "remove", "acme"])).code).toBe(EXIT_USAGE);
    expect((await cli(["profile", "remove", "acme", "--yes"])).code).toBe(0);
    expect(readProfile(paths, "acme")).toBeUndefined();
  });
});

describe("provider commands", () => {
  const addZ = ["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic", "--credential", "env:Z_API_TOKEN"];

  it("adds, updates and shows a provider, with human text by default and JSON on request", async () => {
    expect((await cli(addZ)).code).toBe(0);
    expect((await cli([...addZ, "--env", "A=1"])).code).toBe(EXIT_FAILURE);

    expect((await cli(["provider", "set", "z", "--env", "API_TIMEOUT_MS=600000", "--env", "EXTRA=x"])).code).toBe(0);
    expect((await cli(["provider", "set", "z", "--unset-env", "EXTRA", "--display-name", "Z"])).code).toBe(0);
    expect(readProvider(paths, "z")).toEqual({
      displayName: "Z",
      baseUrl: "https://api.z.ai/api/anthropic",
      credential: { sources: [{ env: "Z_API_TOKEN" }] },
      env: { API_TIMEOUT_MS: "600000" },
    });

    const text = await cli(["provider", "show", "z"]);
    expect(text.stdout).toContain("Credential: bearer from env Z_API_TOKEN");
    expect(() => parseJson(text.stdout)).toThrow();
    expect(parseJson((await cli(["provider", "show", "z", "--json"])).stdout)).toMatchObject({
      name: "z",
      credential: { target: "bearer", sources: [{ kind: "env", variable: "Z_API_TOKEN" }] },
    });
    expect(parseJson((await cli(["provider", "list", "--json"])).stdout)).toEqual([expect.objectContaining({ name: "z" })]);
  });

  it("adds a codex provider with translation settings, merges tier updates, and refuses options that do not fit a kind", async () => {
    const addCodex = ["provider", "add", "codex", "--kind", "codex", "--display-name", "Codex", "--credential", "literal:codex", "--codex-model", "sonnet=gpt-a", "--codex-effort", "medium"];
    expect((await cli(addCodex)).code).toBe(0);
    expect((await cli(["provider", "set", "codex", "--codex-model", "haiku=gpt-b", "--codex-default-model", "gpt-c"])).code).toBe(0);
    expect(readProvider(paths, "codex")).toEqual({
      kind: "codex",
      displayName: "Codex",
      credential: { sources: [{ literal: "codex" }] },
      codex: { models: { sonnet: "gpt-a", haiku: "gpt-b" }, effort: "medium", defaultModel: "gpt-c" },
    });
    const shown = (await cli(["provider", "show", "codex"])).stdout;
    expect(shown).toContain("Kind: codex");
    expect(shown).toContain("sonnet=gpt-a");
    expect(shown).toContain("haiku=gpt-b");
    expect(shown).toContain("otherwise gpt-c");
    expect(parseJson((await cli(["provider", "show", "codex", "--json"])).stdout)).toMatchObject({ kind: "codex", codex: { effort: "medium" } });

    expect((await cli(["provider", "set", "codex", "--base-url", "https://x.example"])).code).toBe(EXIT_USAGE);
    expect((await cli(["provider", "set", "codex", "--codex-model", "gpt=nope"])).code).toBe(EXIT_USAGE);
    expect((await cli(["provider", "add", "c2", "--kind", "codex", "--display-name", "C", "--base-url", "https://x.example", "--credential", "literal:x"])).code).toBe(EXIT_USAGE);
    expect((await cli(["provider", "add", "h", "--display-name", "H", "--credential", "env:X"])).code).toBe(EXIT_USAGE);
    expect((await cli(addZ)).code).toBe(0);
    expect((await cli(["provider", "set", "z", "--codex-effort", "high"])).code).toBe(EXIT_USAGE);
  });

  it("requires --credential on add", async () => {
    expect((await cli(["provider", "add", "z", "--display-name", "z.ai", "--base-url", "https://api.z.ai/api/anthropic"])).code).toBe(EXIT_USAGE);
  });

  it("keeps repeated --credential sources in the order given, parses every short form and the JSON form, and sets the target", async () => {
    const add = [
      "provider", "add", "a", "--display-name", "Anthropic", "--base-url", "https://api.anthropic.com", "--credential-target", "apiKey",
      "--credential", "env:ANTHROPIC_KEY",
      "--credential", "file:~/.config/anthropic.key",
      "--credential", "op:op://vault/a/key",
      "--credential", "keychain:anthropic:joe",
      "--credential", "command:pass show anthropic",
      "--credential", '{"command":["my tool","--flag"],"interactive":true,"timeoutMs":5000}',
    ];
    expect((await cli(add)).code).toBe(0);
    expect(readProvider(paths, "a")?.credential).toEqual({
      target: "apiKey",
      sources: [
        { env: "ANTHROPIC_KEY" },
        { file: "~/.config/anthropic.key" },
        { op: "op://vault/a/key" },
        { keychain: { service: "anthropic", account: "joe" } },
        { command: ["pass", "show", "anthropic"] },
        { command: ["my tool", "--flag"], interactive: true, timeoutMs: 5000 },
      ],
    });
    expect((await cli(["provider", "show", "a"])).stdout).toContain(
      "Credential: apiKey from env ANTHROPIC_KEY, then file ~/.config/anthropic.key, then op op://vault/a/key, then keychain anthropic (account joe), then command pass, then command my tool",
    );

    expect((await cli(["provider", "set", "a", "--credential", "env:OTHER"])).code).toBe(0);
    expect(readProvider(paths, "a")?.credential).toEqual({ target: "apiKey", sources: [{ env: "OTHER" }] });
    expect((await cli(["provider", "set", "a", "--credential-target", "bearer"])).code).toBe(0);
    expect(readProvider(paths, "a")?.credential).toEqual({ target: "bearer", sources: [{ env: "OTHER" }] });
  });

  it("rejects a malformed --credential or an unsupported target as a usage error, leaving the file untouched", async () => {
    await cli(addZ);
    for (const bad of ["Z_API_TOKEN", "vault:x", "op:vault/item", "file:relative/path", "command:", "{not json", '{"env":"A","file":"/b"}']) {
      expect((await cli(["provider", "set", "z", "--credential", bad])).code).toBe(EXIT_USAGE);
    }
    expect((await cli(["provider", "set", "z", "--credential-target", "oauthToken"])).code).toBe(EXIT_USAGE);
    expect(readProvider(paths, "z")?.credential).toEqual({ sources: [{ env: "Z_API_TOKEN" }] });
  });

  it("never prints a literal source's value in show or --json", async () => {
    expect((await cli(["provider", "add", "local", "--display-name", "Local", "--base-url", "http://127.0.0.1:4000", "--credential", "literal:placeholder-value"])).code).toBe(0);
    const text = (await cli(["provider", "show", "local"])).stdout;
    const json = (await cli(["provider", "show", "local", "--json"])).stdout;
    expect(text).toContain("literal (non-secret placeholder)");
    expect(text + json).not.toContain("placeholder-value");
  });

  it("rejects set on a missing provider, set with nothing to change, and a malformed --env", async () => {
    expect((await cli(["provider", "set", "ghost", "--base-url", "https://example.com"])).code).toBe(EXIT_FAILURE);
    await cli(addZ);
    expect((await cli(["provider", "set", "z"])).code).toBe(EXIT_USAGE);
    expect((await cli(["provider", "set", "z", "--env", "NOEQUALS"])).code).toBe(EXIT_USAGE);
  });

  it("removes a provider only with --yes when there is no terminal", async () => {
    await cli(addZ);
    expect((await cli(["provider", "remove", "z"])).code).toBe(EXIT_USAGE);
    expect((await cli(["provider", "remove", "z", "--yes"])).code).toBe(0);
    expect(readProvider(paths, "z")).toBeUndefined();
  });
});

describe("rule commands", () => {
  it("adds a rule once, then updates it through set", async () => {
    addIdentity(paths, "work");
    createProfile(paths, "acme");
    expect((await cli(["rule", "add", "~/work/acme", "--config-profile", "acme"])).code).toBe(0);
    expect((await cli(["rule", "add", "~/work/acme", "--identity", "work"])).code).toBe(EXIT_FAILURE);

    expect((await cli(["rule", "set", "~/work/acme", "--identity", "work"])).code).toBe(0);
    expect(listDirectoryRules(paths)).toEqual([{ path: "~/work/acme", configProfile: "acme", identity: "work" }]);

    expect((await cli(["rule", "set", "~/work/acme", "--no-config-profile"])).code).toBe(0);
    expect(listDirectoryRules(paths)).toEqual([{ path: "~/work/acme", identity: "work" }]);

    expect((await cli(["rule", "set", "~/work/acme", "--no-identity"])).code).toBe(EXIT_FAILURE);
  });

  it("refuses a rule that names a missing identity or, without a terminal, a missing profile", async () => {
    expect((await cli(["rule", "add", "/p", "--identity", "ghost"])).code).toBe(EXIT_FAILURE);
    expect((await cli(["rule", "add", "/p", "--config-profile", "ghost"])).code).toBe(EXIT_FAILURE);
    expect((await cli(["rule", "add", "/p"])).code).toBe(EXIT_FAILURE);
    expect(listDirectoryRules(paths)).toEqual([]);
  });

  it("shows and lists rules as JSON, and removes one only with --yes when there is no terminal", async () => {
    createProfile(paths, "acme");
    await cli(["rule", "add", "/p", "--config-profile", "acme"]);
    expect(parseJson((await cli(["rule", "show", "/p", "--json"])).stdout)).toEqual({ path: "/p", configProfile: "acme" });
    expect(parseJson((await cli(["rule", "list", "--json"])).stdout)).toEqual([{ path: "/p", configProfile: "acme" }]);
    expect((await cli(["rule", "show", "/other"])).code).toBe(EXIT_FAILURE);

    expect((await cli(["rule", "remove", "/p"])).code).toBe(EXIT_USAGE);
    expect((await cli(["rule", "remove", "/p", "--yes"])).code).toBe(0);
    expect(listDirectoryRules(paths)).toEqual([]);
  });
});

describe("mutating commands with --json", () => {
  async function json(argv: readonly string[]): Promise<Record<string, unknown>> {
    const result = await cli(argv);
    expect(result.code, result.stderr).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`expected one JSON object, got ${result.stdout}`);
    }
    return Object.fromEntries(Object.entries(parsed));
  }

  it("prints one report object per command, naming the action, the noun and the name, with the stored value for a creation or an update", async () => {
    expect(await json(["identity", "add", "work", "--json"])).toMatchObject({ action: "created", kind: "identity", name: "work", value: { name: "work" } });
    expect(await json(["identity", "set", "work", "--allow-ambient-credential", "--json"])).toMatchObject({
      action: "updated",
      kind: "identity",
      name: "work",
      value: { allowAmbientCredential: true },
    });
    expect(await json(["identity", "use", "work", "--json"])).toEqual({ action: "selected", kind: "identity", name: "work" });

    expect(await json(["profile", "add", "base", "--description", "d", "--json"])).toMatchObject({ action: "created", kind: "profile", name: "base", value: { description: "d" } });
    expect(await json(["profile", "set", "base", "--description", "e", "--json"])).toMatchObject({ action: "updated", kind: "profile", name: "base", value: { description: "e" } });
    expect(await json(["profile", "use", "base", "--json"])).toEqual({ action: "selected", kind: "profile", name: "base" });

    expect(await json(["provider", "add", "p", "--display-name", "P", "--base-url", "https://example.com/api", "--credential", "env:TOKEN", "--json"])).toMatchObject({
      action: "created",
      kind: "provider",
      name: "p",
      value: { displayName: "P" },
    });
    expect(await json(["provider", "set", "p", "--display-name", "Q", "--json"])).toMatchObject({ action: "updated", kind: "provider", name: "p", value: { displayName: "Q" } });

    expect(await json(["pool", "add", "subs", "--identity", "work", "--json"])).toMatchObject({ action: "created", kind: "pool", name: "subs", value: { identities: ["work"] } });
    expect(await json(["pool", "set", "subs", "--identity", "work", "--json"])).toMatchObject({ action: "updated", kind: "pool", name: "subs" });
    expect(await json(["pool", "use", "subs", "--json"])).toEqual({ action: "selected", kind: "pool", name: "subs" });

    expect(await json(["rule", "add", "/tmp/acme", "--identity", "work", "--json"])).toMatchObject({ action: "created", kind: "rule", name: "/tmp/acme", value: { identity: "work" } });
    expect(await json(["rule", "set", "/tmp/acme", "--config-profile", "base", "--json"])).toMatchObject({ action: "updated", kind: "rule", name: "/tmp/acme", value: { configProfile: "base" } });

    expect(await json(["rule", "remove", "/tmp/acme", "--yes", "--json"])).toEqual({ action: "removed", kind: "rule", name: "/tmp/acme" });
    expect(await json(["pool", "remove", "subs", "--yes", "--json"])).toEqual({ action: "removed", kind: "pool", name: "subs" });
    expect(await json(["provider", "remove", "p", "--yes", "--json"])).toEqual({ action: "removed", kind: "provider", name: "p" });
    expect(await json(["profile", "remove", "base", "--yes", "--json"])).toEqual({ action: "removed", kind: "profile", name: "base" });
    expect(await json(["identity", "remove", "work", "--yes", "--json"])).toEqual({ action: "removed", kind: "identity", name: "work" });
  });

  it("still prints the usual text without --json", async () => {
    const result = await cli(["identity", "add", "work"]);
    expect(result.stdout).toBe('Created identity "work".\n');
  });

  it("does not let --json alone satisfy a set command that changes nothing", async () => {
    addIdentity(paths, "work");
    const result = await cli(["identity", "set", "work", "--json"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("Nothing to change");
  });
});

describe("configure", () => {
  it("refuses to run without a terminal, since every step is a prompt", async () => {
    addIdentity(paths, "work");
    const result = await cli(["configure", "--identity", "work"]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("needs a terminal");
  });
});

describe("completion", () => {
  it.each(["bash", "zsh", "fish"])("generates a %s script covering nouns, verbs and flags", async (shell) => {
    const result = await cli(["completion", shell]);
    expect(result.code).toBe(0);
    for (const word of ["identity", "resolve-conflicts"]) {
      expect(result.stdout).toContain(word);
    }
    for (const flag of ["json", "config-profile", "no-provider"]) {
      expect(result.stdout).toContain(shell === "fish" ? `-l '${flag}'` : `--${flag}`);
    }
    expect(result.stdout).not.toContain("__headroom-supervisor");
  });

  it("rejects an unknown shell as a usage error", async () => {
    expect((await cli(["completion", "tcsh"])).code).toBe(EXIT_USAGE);
  });

  it("produces a bash script bash itself parses", async () => {
    const file = path.join(root, "completion.bash");
    fs.writeFileSync(file, (await cli(["completion", "bash"])).stdout);
    expect(() => execFileSync("bash", ["-n", file], { stdio: "pipe" })).not.toThrow();
  });
});

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_COMMAND_TIMEOUT_MS } from "../credential";
import { KeychainLoginError } from "../keychainLogin";
import { createFakeKeychain } from "../keychainTestWorld";
import type { RunPort } from "../launcher/ports";
import { buildLayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { createFakeFarmFs } from "../test-helpers";
import { claudeCodeKeychainService } from "../usage/signIn";
import { realRcMintPorts, registerRcCommand, type RcMintPorts } from "./rcCommands";
import { RC_SELF_HOST_MINT_MARKER } from "./rcSelfHostMint";

const ROOT = "/state";
const IDENTITY_DIR = `${ROOT}/identities/rig`;

/** Parses `frontdoor rc selfhost mint rig` against the ports and returns what the command printed. */
async function runMint(ports: RcMintPorts, extra: readonly string[] = []): Promise<string[]> {
  const program = new Command().exitOverride();
  registerRcCommand(program.command("frontdoor"), buildLayoutPaths(ROOT), ports);
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  await program.parseAsync(["node", "agent-shim", "frontdoor", "rc", "selfhost", "mint", "rig", ...extra]);
  return printed;
}

describe("frontdoor rc selfhost mint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const freshFs = () => {
    const fs = createFakeFarmFs();
    fs.seed({ [`${IDENTITY_DIR}/identity.json`]: '{"name":"rig"}' });
    return fs;
  };

  it("asks the injected Keychain on the injected platform and refuses, writing nothing, when a login is filed, whatever --force says", async () => {
    const fs = freshFs();
    const keychain = createFakeKeychain();
    keychain.seed(claudeCodeKeychainService(IDENTITY_DIR), "alex", "a-made-up-login");
    const ports: RcMintPorts = { keychain: { run: keychain.run, platform: "darwin" }, login: { env: {} }, fs };
    await expect(runMint(ports, ["--force"])).rejects.toBeInstanceOf(KeychainLoginError);
    expect(fs.readFileUtf8(`${IDENTITY_DIR}/.credentials.json`)).toBeUndefined();
    expect(fs.readFileUtf8(`${IDENTITY_DIR}/${RC_SELF_HOST_MINT_MARKER}`)).toBeUndefined();
  });

  it("reads the environment it was given, refusing while the secure-storage override is set", async () => {
    const fs = freshFs();
    const ports: RcMintPorts = { keychain: { run: createFakeKeychain().run, platform: "linux" }, login: { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/example/elsewhere" } }, fs };
    await expect(runMint(ports)).rejects.toThrow("CLAUDE_SECURESTORAGE_CONFIG_DIR is set");
    expect(fs.readFileUtf8(`${IDENTITY_DIR}/.credentials.json`)).toBeUndefined();
  });

  it("mints and prints the result when nothing stands in the way", async () => {
    const fs = freshFs();
    const keychain = createFakeKeychain();
    const ports: RcMintPorts = { keychain: { run: keychain.run, platform: "darwin" }, login: { env: {} }, fs };
    const printed = await runMint(ports);
    expect(printed.join("\n")).toContain("identity:       rig");
    expect(fs.readFileUtf8(`${IDENTITY_DIR}/.credentials.json`)).toBeDefined();
    expect(keychain.calls.map((call) => call.args)).toEqual([["find-generic-password", "-s", claudeCodeKeychainService(IDENTITY_DIR)]]);
  });
});

describe("realRcMintPorts", () => {
  it("is this process's platform, environment and filesystem, with the Keychain asked under the bound a credential command has", () => {
    const runner: RunPort = { run: () => ({ status: 0, stdout: "", stderr: "" }) };
    const within = vi.fn<(timeoutMs: number) => RunPort>(() => runner);
    const ports = realRcMintPorts(within);
    expect(within).toHaveBeenCalledExactlyOnceWith(CREDENTIAL_COMMAND_TIMEOUT_MS);
    expect(ports.keychain).toEqual({ run: runner, platform: process.platform });
    expect(ports.login.env).toBe(process.env);
    expect(ports.fs).toBe(realFarmFs);
  });
});

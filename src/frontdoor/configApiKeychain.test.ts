import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addIdentity, requireIdentityAddable, identityExists } from "../identityStore";
import { nonWaitingIdentityNamesLockPorts, IdentityNamesLockBusyError } from "../identityNamesLock";
import { KEYCHAIN_CACHE_SERVICE, KEYCHAIN_ITEM_NOT_FOUND_STATUS } from "../credentialCache";
import { cacheEntryProbe, createFakeKeychain, type FakeKeychain, TEST_CLAUDE_LOGIN } from "../keychainTestWorld";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import type { AsyncRun } from "../replayRun";
import { claudeCodeKeychainService } from "../usage/signIn";
import { createConfigApiRouter } from "./configApi";
import { RC_SELF_HOST_MINT_MARKER } from "./rcSelfHostMint";
import { ConfigIdentityAddInputSchema } from "./configSchemas";
import { realFarmFs } from "../realPorts";

const TOKEN = "control-token-for-the-config-api-keychain-tests";

/** A failure `security` gives that is not an item it cannot find, as a locked Keychain gives. */
const LOCKED_KEYCHAIN_STATUS = 51;

/** A made-up login, which no message or call of the check may carry. */
const LOGIN_BLOB = "a-made-up-login-blob";

describe("config.identity.add and a Keychain login left behind for the directory", () => {
  let root: string;
  let paths: LayoutPaths;
  let keychain: FakeKeychain;

  const service = (name: string): string => claudeCodeKeychainService(path.join(paths.identitiesDir, name));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-config-api-keychain-"));
    paths = buildLayoutPaths(root);
    keychain = createFakeKeychain();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The door's own way of running `security`: asynchronously, so the event loop is never blocked, over the fake. */
  function asynchronously(): AsyncRun {
    return async (command, args) => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return keychain.run.run(command, args);
    };
  }

  function client(platform: NodeJS.Platform = "darwin", runAsync: AsyncRun = asynchronously()) {
    return createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform }, fs: realFarmFs, claudeLogin: TEST_CLAUDE_LOGIN }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
  }

  /** The code and message of the refusal a call ends with, or undefined when it did not end with one. */
  async function refusalOf(call: Readonly<Promise<unknown>>): Promise<Readonly<{ code: string; message: string }> | undefined> {
    try {
      await call;
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && "message" in error && typeof error.message === "string") {
        return { code: error.code, message: error.message };
      }
      throw error;
    }
    return undefined;
  }

  it("is refused with CONFLICT and the message the CLI gives, naming the entry and the commands, and creates nothing", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const cliMessage = ((): string => {
      try {
        requireIdentityAddable(paths, "work", { run: keychain.run, platform: "darwin" }, false);
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
      return "";
    })();
    keychain.calls.length = 0;
    const refused = await refusalOf(client().identity.add({ name: "work" }));
    expect(refused?.code).toBe("CONFLICT");
    expect(refused?.message).toBe(cliMessage);
    expect(refused?.message).toContain(`security delete-generic-password -s '${service("work")}' -a 'alex'`);
    expect(refused?.message).toContain("agent-shim identity add work --keep-keychain-login");
    expect(identityExists(paths, "work")).toBe(false);
  });

  it("asks the Keychain for attributes only, never for the login, and nothing of it reaches the refusal", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const refused = await refusalOf(client().identity.add({ name: "work" }));
    expect(keychain.calls).toEqual([cacheEntryProbe("identity work"), { command: "security", args: ["find-generic-password", "-s", service("work")] }]);
    expect(keychain.calls.some((call) => call.args.includes("-w") || call.args.includes("-g") || call.args[0] === "-i")).toBe(false);
    expect(refused?.message).not.toContain(LOGIN_BLOB);
  });

  it("is allowed with keepKeychainLogin, which says the login is wanted, asking the Keychain only, by attributes, whether it caches a credential for the id", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const created = await client().identity.add({ name: "work", keepKeychainLogin: true });
    expect(created).toMatchObject({ action: "created", kind: "identity", name: "work" });
    expect(identityExists(paths, "work")).toBe(true);
    expect(keychain.calls).toEqual([cacheEntryProbe("identity work")]);
  });

  it("reads the usage log once for the check, however often the Keychain's answers start it again, and once under the names lock", async () => {
    fs.mkdirSync(paths.usageLogDir, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at, identity: "other", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    const readdir = vi.spyOn(fs, "readdirSync");
    expect(await client().identity.add({ name: "work" })).toMatchObject({ action: "created" });
    // The cache probe and the login lookup each start the check again; the log is read by the first start that needs it and once more for the write.
    expect(keychain.calls).toHaveLength(2);
    expect(readdir.mock.calls.filter(([directory]) => directory === paths.usageLogDir)).toHaveLength(2);
    readdir.mockRestore();
  });

  it("is allowed once the entry is deleted, with the command the refusal gave", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    expect((await refusalOf(client().identity.add({ name: "work" })))?.code).toBe("CONFLICT");
    keychain.items.delete(service("work"));
    expect(await refusalOf(client().identity.add({ name: "work" }))).toBeUndefined();
    expect(identityExists(paths, "work")).toBe(true);
  });

  it("is refused as it was for a name that exists, before the Keychain is asked", async () => {
    await client("linux").identity.add({ name: "work" });
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    keychain.calls.length = 0;
    expect((await refusalOf(client().identity.add({ name: "work" })))?.code).toBe("CONFLICT");
    expect(keychain.calls).toEqual([]);
  });

  it.each([
    { case: "security killed after its time limit, or never started (no exit status)", answer: { status: null, stdout: "", stderr: "" } },
    { case: "a locked Keychain (an exit status that is not an absence)", answer: { status: 36, stdout: "", stderr: "User interaction is not allowed." } },
  ])("is SERVICE_UNAVAILABLE, which a client may retry, and not CONFLICT, when the Keychain could not be asked: $case", async ({ answer }) => {
    // The cache probe is answered, so it is the login's lookup that fails.
    const refused = await refusalOf(client("darwin", async (_command, args) => await Promise.resolve(args.includes(KEYCHAIN_CACHE_SERVICE) ? { status: KEYCHAIN_ITEM_NOT_FOUND_STATUS, stdout: "", stderr: "" } : answer)).identity.add({ name: "work" }));
    expect(refused?.code).toBe("SERVICE_UNAVAILABLE");
    expect(refused?.message).toContain(`Could not look up the Keychain item ${service("work")}`);
    expect(identityExists(paths, "work")).toBe(false);
  });

  it("is still CONFLICT for a leftover login that was found, whatever the lookup failures do", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    expect((await refusalOf(client().identity.add({ name: "work" })))?.code).toBe("CONFLICT");
  });

  it("describes keepKeychainLogin, to the typed client and the MCP tool derived from it, as sharing a login another identity holds", () => {
    expect(ConfigIdentityAddInputSchema.shape.keepKeychainLogin.description).toContain("If another identity holds that login, the two share it");
  });

  it("asks nothing of the Keychain off macOS", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    await client("linux").identity.add({ name: "work" });
    expect(keychain.calls).toEqual([]);
    expect(identityExists(paths, "work")).toBe(true);
  });
});

describe("config.identity.remove and the credential the Keychain store caches", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-config-api-remove-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prevents reusing an id until its Keychain cache deletion finishes", async () => {
    addIdentity(paths, "work");
    let refusal: unknown;
    const runAsync: AsyncRun = async () => {
      try {
        addIdentity(paths, "work", { namesLock: nonWaitingIdentityNamesLockPorts });
      } catch (error: unknown) {
        refusal = error;
      }
      return await Promise.resolve({ status: 0, stdout: "", stderr: "" });
    };
    const api = createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform: "darwin" }, fs: realFarmFs, claudeLogin: TEST_CLAUDE_LOGIN }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
    await api.identity.remove({ name: "work", confirm: true });
    expect(refusal).toBeInstanceOf(IdentityNamesLockBusyError);
  });

  it("forgets it under the removed identity's id, through the runner that does not block", async () => {
    // An identity stored under work and named client, as a rename of the name alone leaves it.
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
    const asked: (readonly string[])[] = [];
    const runAsync: AsyncRun = async (_command, args) => {
      asked.push(args);
      return await Promise.resolve({ status: 0, stdout: "", stderr: "" });
    };
    const api = createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform: "darwin" }, fs: realFarmFs, claudeLogin: TEST_CLAUDE_LOGIN }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
    expect(await api.identity.remove({ name: "client", confirm: true })).toEqual({ action: "removed", kind: "identity", name: "client" });
    expect(asked).toEqual([["delete-generic-password", "-s", "agent-shim-credential-cache", "-a", "identity work"]]);
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
  });

  it("reports a delete security refused as INTERNAL_SERVER_ERROR naming the command, with the identity removed", async () => {
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
    const runAsync: AsyncRun = async () => await Promise.resolve({ status: LOCKED_KEYCHAIN_STATUS, stdout: "", stderr: "" });
    const api = createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform: "darwin" }, fs: realFarmFs, claudeLogin: TEST_CLAUDE_LOGIN }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
    const failure: unknown = await api.identity.remove({ name: "client", confirm: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(failure).toHaveProperty("message", expect.stringContaining('Removed identity "client", but could not delete its cached credential (identity work) from the Keychain'));
    expect(failure).toHaveProperty("message", expect.stringContaining(`security delete-generic-password -s '${KEYCHAIN_CACHE_SERVICE}' -a 'identity work'`));
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
  });

  it("leaves the Claude Code login item of every identity, answering with a warning naming a self-hosted identity's leftover, asked by attributes only", async () => {
    addIdentity(paths, "lab");
    const labDir = path.join(paths.identitiesDir, "lab");
    fs.writeFileSync(path.join(labDir, RC_SELF_HOST_MINT_MARKER), `${JSON.stringify({ mintedAt: "2026-01-01T00:00:00.000Z" })}\n`);
    addIdentity(paths, "work");
    const keychain = createFakeKeychain();
    keychain.seed(claudeCodeKeychainService(labDir), "alex", "a-made-up-real-login");
    const runAsync: AsyncRun = async (command, args) => await Promise.resolve(keychain.run.run(command, args));
    const api = createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform: "darwin" }, fs: realFarmFs, claudeLogin: TEST_CLAUDE_LOGIN }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
    const removed = await api.identity.remove({ name: "lab", confirm: true });
    expect(removed.warnings?.join("\n")).toContain(`security delete-generic-password -s '${claudeCodeKeychainService(labDir)}' -a 'alex'`);
    expect(keychain.items.has(claudeCodeKeychainService(labDir))).toBe(true);
    expect(keychain.calls.filter((call) => call.args[0] === "delete-generic-password").map((call) => call.args)).toEqual([["delete-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", "identity lab"]]);
    expect(keychain.calls.some((call) => call.args.includes("-g") || call.args.includes("-w"))).toBe(false);
    expect(await api.identity.remove({ name: "work", confirm: true })).toEqual({ action: "removed", kind: "identity", name: "work" });
  });

  it("asks nothing about a self-hosted identity's login off macOS", async () => {
    addIdentity(paths, "lab");
    fs.writeFileSync(path.join(paths.identitiesDir, "lab", RC_SELF_HOST_MINT_MARKER), `${JSON.stringify({ mintedAt: "2026-01-01T00:00:00.000Z" })}\n`);
    const runAsync: AsyncRun = async () => await Promise.reject(new Error("off macOS nothing is asked of the Keychain"));
    const api = createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform: "linux" }, fs: realFarmFs, claudeLogin: TEST_CLAUDE_LOGIN }), {
      context: { headers: { authorization: `Bearer ${TOKEN}` }, afterResponse: () => undefined },
    }).config;
    expect(await api.identity.remove({ name: "lab", confirm: true })).toEqual({ action: "removed", kind: "identity", name: "lab" });
  });
});

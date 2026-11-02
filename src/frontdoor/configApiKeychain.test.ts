import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireIdentityAddable, identityExists } from "../identityStore";
import { createFakeKeychain, type FakeKeychain } from "../keychainTestWorld";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import type { AsyncRun } from "../replayRun";
import { claudeCodeKeychainService } from "../usage/signIn";
import { createConfigApiRouter } from "./configApi";
import { ConfigIdentityAddInputSchema } from "./configSchemas";

const TOKEN = "control-token-for-the-config-api-keychain-tests";

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
    return createRouterClient(createConfigApiRouter({ expectedToken: TOKEN, paths, keychain: { runAsync, platform } }), {
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
    expect(keychain.calls).toEqual([{ command: "security", args: ["find-generic-password", "-s", service("work")] }]);
    expect(keychain.calls.some((call) => call.args.includes("-w") || call.args.includes("-g") || call.args[0] === "-i")).toBe(false);
    expect(refused?.message).not.toContain(LOGIN_BLOB);
  });

  it("is allowed with keepKeychainLogin, which says the login is wanted, without asking the Keychain anything", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const created = await client().identity.add({ name: "work", keepKeychainLogin: true });
    expect(created).toMatchObject({ action: "created", kind: "identity", name: "work" });
    expect(identityExists(paths, "work")).toBe(true);
    expect(keychain.calls).toEqual([]);
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
    const refused = await refusalOf(client("darwin", async () => await Promise.resolve(answer)).identity.add({ name: "work" }));
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

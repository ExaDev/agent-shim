import { describe, expect, it } from "vitest";

import { copyKeychainLogin, deleteKeychainLogin, KeychainLoginError, planKeychainLogin } from "./keychainLogin";
import { createFakeKeychain } from "./keychainTestWorld";
import { claudeCodeKeychainService } from "./usage/signIn";

/** Sizes chosen against the 4095-character interactive line: two parts that together are too large for the hex form and fit the quoted one, a size that fits neither, and a size too large for the hex form of a login that cannot be quoted. */
const FIRST_PART_BYTES = 1800;
const SECOND_PART_BYTES = 1200;
const TOO_LARGE_FOR_ANY_FORM = 4000;
const TOO_LARGE_FOR_HEX = 2000;
const FROM_DIR = "/example/identities/work";
const TO_DIR = "/example/identities/client";
const FROM_SERVICE = claudeCodeKeychainService(FROM_DIR);
const TO_SERVICE = claudeCodeKeychainService(TO_DIR);
/** A made-up login blob shaped like the JSON Claude Code stores: quotes, braces and a backslash, but no real token. */
const SECRET = String.raw`{"claudeAiOauth":{"accessToken":"made-up-access-value","note":"a \"quoted\" word and a backslash \\ here"}}`;

function seeded(secret = SECRET) {
  const keychain = createFakeKeychain();
  keychain.items.set(FROM_SERVICE, { account: "alex", secret });
  return keychain;
}

/** Every string a call exposes through its argument list: the part any local process can read from the process table. */
function exposedArguments(calls: readonly { readonly command: string; readonly args: readonly string[] }[]): string {
  return calls.map((call) => [call.command, ...call.args].join(" ")).join("\n");
}

describe("planKeychainLogin", () => {
  it("names the services and the account of an existing login, reading attributes only", () => {
    const keychain = seeded();
    expect(planKeychainLogin(keychain.run, FROM_DIR, TO_DIR)).toEqual({ fromService: FROM_SERVICE, toService: TO_SERVICE, account: "alex" });
    expect(keychain.calls.map((call) => call.args)).toEqual([
      ["find-generic-password", "-s", FROM_SERVICE],
      ["find-generic-password", "-s", TO_SERVICE],
    ]);
  });

  it("reports no plan when the directory has no login in the Keychain", () => {
    expect(planKeychainLogin(createFakeKeychain().run, FROM_DIR, TO_DIR)).toBeUndefined();
  });

  it("refuses when the new directory's service already holds an item, which a copy would have to overwrite", () => {
    const keychain = seeded();
    keychain.items.set(TO_SERVICE, { account: "alex", secret: "left over from a removed identity" });
    expect(() => planKeychainLogin(keychain.run, FROM_DIR, TO_DIR)).toThrow(/already holds a login/);
  });
});

describe("copyKeychainLogin", () => {
  it("creates the new item with the same account and secret, and leaves the old one for the caller to delete", () => {
    const keychain = seeded();
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    expect(plan).toBeDefined();
    if (plan === undefined) {
      return;
    }
    copyKeychainLogin(keychain.run, plan);
    expect(keychain.items.get(TO_SERVICE)).toEqual({ account: "alex", secret: SECRET });
    expect(keychain.items.get(FROM_SERVICE)).toEqual({ account: "alex", secret: SECRET });
  });

  it("never puts the secret, in any encoding, on an argument list", () => {
    const keychain = seeded();
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    copyKeychainLogin(keychain.run, plan);
    const exposed = exposedArguments(keychain.calls);
    expect(exposed).not.toContain(SECRET);
    expect(exposed).not.toContain(Buffer.from(SECRET).toString("hex"));
    expect(exposed).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(exposed).not.toContain("made-up-access-value");
    const writes = keychain.calls.filter((call) => call.args[0] === "-i");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toEqual(["-i"]);
    expect(writes[0]?.input).toContain(Buffer.from(SECRET).toString("hex"));
    expect(keychain.calls.filter((call) => call.args.includes("-w"))).toHaveLength(1);
    expect(keychain.calls.find((call) => call.args.includes("-w"))?.args).toEqual(["find-generic-password", "-s", FROM_SERVICE, "-a", "alex", "-w"]);
  });

  it("verifies the new item with an existence check that asks for no secret", () => {
    const keychain = seeded();
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    keychain.calls.length = 0;
    copyKeychainLogin(keychain.run, plan);
    const last = keychain.calls.at(-1);
    expect(last?.args).toEqual(["find-generic-password", "-s", TO_SERVICE]);
    expect(last?.args).not.toContain("-w");
    expect(last?.args).not.toContain("-g");
  });

  it("falls back to a quoted password when the hex form would not fit one interactive line, and the tool reads it back intact", () => {
    const large = `{"claudeAiOauth":{"accessToken":"${"a".repeat(FIRST_PART_BYTES)}","refreshToken":"${"b".repeat(SECOND_PART_BYTES)}"}}`;
    const keychain = seeded(large);
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    copyKeychainLogin(keychain.run, plan);
    expect(keychain.items.get(TO_SERVICE)?.secret).toBe(large);
    expect(exposedArguments(keychain.calls)).not.toContain("aaaaaaaaaa");
  });

  it("refuses, before writing anything, a login too large for one interactive line in either encoding", () => {
    const keychain = seeded(`{"claudeAiOauth":{"accessToken":"${"a".repeat(TOO_LARGE_FOR_ANY_FORM)}"}}`);
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    expect(() => {
      copyKeychainLogin(keychain.run, plan);
    }).toThrow(KeychainLoginError);
    expect(keychain.calls.some((call) => call.args[0] === "-i")).toBe(false);
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
  });

  it("carries a login holding a newline in the hex form, which any bytes fit", () => {
    const withNewline = `{"note":"line one\nline two"}`;
    const keychain = seeded(withNewline);
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    copyKeychainLogin(keychain.run, plan);
    expect(keychain.items.get(TO_SERVICE)?.secret).toBe(withNewline);
  });

  it("refuses a login with a newline too large for the hex form, because a quoted word cannot carry it", () => {
    const keychain = seeded(`{"note":"line one\nline two ${"x".repeat(TOO_LARGE_FOR_HEX)}"}`);
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    expect(() => {
      copyKeychainLogin(keychain.run, plan);
    }).toThrow(KeychainLoginError);
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
  });

  it("does not echo the secret when the write fails and the tool's own message repeats the command", () => {
    const keychain = seeded();
    keychain.failNextAdd(1);
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    let message = "";
    try {
      copyKeychainLogin(keychain.run, plan);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("security exited 1");
    expect(message).not.toContain("made-up-access-value");
    expect(message).not.toContain(Buffer.from(SECRET).toString("hex"));
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
  });

  it("removes what it wrote and throws when the new item cannot be found afterwards", () => {
    const keychain = seeded();
    keychain.hideFromLookup.add(TO_SERVICE);
    const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
    if (plan === undefined) {
      throw new Error("expected a plan");
    }
    expect(() => {
      copyKeychainLogin(keychain.run, plan);
    }).toThrow(/not found afterwards/);
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
    expect(keychain.items.has(FROM_SERVICE)).toBe(true);
  });
});

describe("deleteKeychainLogin", () => {
  it("deletes one service's item by service and account, and does nothing for an absent one", () => {
    const keychain = seeded();
    deleteKeychainLogin(keychain.run, FROM_SERVICE, "alex");
    expect(keychain.items.has(FROM_SERVICE)).toBe(false);
    expect(() => {
      deleteKeychainLogin(keychain.run, FROM_SERVICE, "alex");
    }).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { deleteKeychainLogin, KeychainLoginError, planKeychainLogin, readKeychainLogin, requireNoClaudeCodeLoginForMint, selfHostedLoginLeftover, writeKeychainLogin, type KeychainLoginPlan } from "./keychainLogin";
import type { RunPort } from "./launcher/ports";
import { TEST_CLAUDE_LOGIN, createFakeKeychain } from "./keychainTestWorld";
import { claudeCodeKeychainService } from "./usage/signIn";

/** Sizes chosen against the 4095-character interactive line: two parts that together are too large for the hex form and fit the quoted one, a size that fits neither, and a size too large for the hex form of a login that cannot be quoted. */
const FIRST_PART_BYTES = 1800;
const SECOND_PART_BYTES = 1200;
const TOO_LARGE_FOR_ANY_FORM = 4000;
const TOO_LARGE_FOR_HEX = 2000;
/** How many leading hex digits of the secret the fake tool's error text quotes, a fragment of a word that a whole-form scrubber would not catch. */
const QUOTED_FRAGMENT_DIGITS = 24;
/** A failure `security` gives that is not an item it cannot find, as a locked Keychain gives. */
const LOCKED_KEYCHAIN_STATUS = 51;
const FROM_DIR = "/example/identities/work";
const TO_DIR = "/example/identities/client";
const FROM_SERVICE = claudeCodeKeychainService(FROM_DIR);
const TO_SERVICE = claudeCodeKeychainService(TO_DIR);
/** A made-up login blob shaped like the JSON Claude Code stores: quotes, braces and a backslash, but no real token. */
const SECRET = String.raw`{"claudeAiOauth":{"accessToken":"made-up-access-value","note":"a \"quoted\" word and a backslash \\ here"}}`;
/** Bytes that are not text: the real tool prints these as bare hex digits under `-w`, which a copy must not take for the password. */
const NOT_TEXT = Buffer.from("0102ff7a00800a", "hex");

function seeded(secret: string | Uint8Array = SECRET) {
  const keychain = createFakeKeychain();
  keychain.seed(FROM_SERVICE, "alex", secret);
  return keychain;
}

/** Reads the login and writes it under the new service, as the rename does with the read made earlier than the write. */
function copy(run: RunPort, plan: KeychainLoginPlan): void {
  writeKeychainLogin(run, plan, readKeychainLogin(run, plan));
}

function planOf(keychain: ReturnType<typeof seeded>) {
  const plan = planKeychainLogin(keychain.run, FROM_DIR, TO_DIR);
  if (plan === undefined) {
    throw new Error("expected a plan");
  }
  return plan;
}

/** Every string a call exposes through its argument list: the part any local process can read from the process table. */
function exposedArguments(calls: readonly { readonly command: string; readonly args: readonly string[] }[]): string {
  return calls.map((call) => [call.command, ...call.args].join(" ")).join("\n");
}

describe("planKeychainLogin", () => {
  it("names the services and the account of an existing login, reading attributes only", () => {
    const keychain = seeded();
    expect(planKeychainLogin(keychain.run, FROM_DIR, TO_DIR)).toEqual({ fromService: FROM_SERVICE, toService: TO_SERVICE, account: "alex", alreadyCopied: false });
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
    keychain.seed(TO_SERVICE, "alex", "left over from a removed identity");
    expect(() => planKeychainLogin(keychain.run, FROM_DIR, TO_DIR)).toThrow(/already holds a login/);
    // Removing an identity deletes its cached credential but not its Claude Code login, which is what is left here.
    expect(() => planKeychainLogin(keychain.run, FROM_DIR, TO_DIR)).toThrow("left by an identity stored there that was removed, since `identity remove` does not delete the Claude Code login");
  });
});

describe("planKeychainLogin for a rename being resumed", () => {
  it("takes an item already under the new service as the earlier run's copy, and plans nothing to read or write", () => {
    const keychain = seeded();
    keychain.seed(TO_SERVICE, "alex", SECRET);
    expect(planKeychainLogin(keychain.run, FROM_DIR, TO_DIR, true)).toEqual({ fromService: FROM_SERVICE, toService: TO_SERVICE, account: "alex", alreadyCopied: true });
    expect(keychain.calls.every((call) => call.args[0] === "find-generic-password" && !call.args.includes("-g") && !call.args.includes("-w"))).toBe(true);
  });

  it("plans the copy as usual when the earlier run had not reached it", () => {
    expect(planKeychainLogin(seeded().run, FROM_DIR, TO_DIR, true)).toMatchObject({ alreadyCopied: false });
  });

  it("plans nothing when the old item is gone too, as when the earlier run got as far as deleting it", () => {
    const keychain = createFakeKeychain();
    keychain.seed(TO_SERVICE, "alex", SECRET);
    expect(planKeychainLogin(keychain.run, FROM_DIR, TO_DIR, true)).toBeUndefined();
  });
});

describe("reading a login and writing it under another service", () => {
  it("creates the new item with the same account and secret, and leaves the old one for the caller to delete", () => {
    const keychain = seeded();
    copy(keychain.run, planOf(keychain));
    expect(keychain.items.get(TO_SERVICE)?.account).toBe("alex");
    expect(keychain.secretOf(TO_SERVICE)).toEqual(Buffer.from(SECRET));
    expect(keychain.secretOf(FROM_SERVICE)).toEqual(Buffer.from(SECRET));
  });

  it.each([
    ["JSON text with quotes and a backslash, which the tool prints in its hex form under -g and as text under -w", Buffer.from(SECRET)],
    ["plain printable text, which the tool prints in quotes under -g", Buffer.from("plain printable text")],
    ["bytes that are not text, which the tool prints as bare hex digits under -w", NOT_TEXT],
    ["UTF-8 beyond ASCII", Buffer.from("café and ☃")],
    ["text holding a newline", Buffer.from('{"note":"line one\nline two"}')],
  ])("copies the exact bytes of %s", (_form, bytes) => {
    const keychain = seeded(bytes);
    copy(keychain.run, planOf(keychain));
    expect(keychain.secretOf(TO_SERVICE)).toEqual(bytes);
    expect(keychain.secretOf(FROM_SERVICE)).toEqual(bytes);
  });

  it("never puts the secret, in any encoding, on an argument list", () => {
    const keychain = seeded();
    copy(keychain.run, planOf(keychain));
    const exposed = exposedArguments(keychain.calls);
    expect(exposed).not.toContain(SECRET);
    expect(exposed).not.toContain(Buffer.from(SECRET).toString("hex"));
    expect(exposed).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(exposed).not.toContain("made-up-access-value");
    const writes = keychain.calls.filter((call) => call.args[0] === "-i");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toEqual(["-i"]);
    expect(writes[0]?.input).toContain(Buffer.from(SECRET).toString("hex"));
  });

  it("reads the password once, with -g, which prints it on standard error in a form that says whether it is text", () => {
    const keychain = seeded();
    const plan = planOf(keychain);
    keychain.calls.length = 0;
    copy(keychain.run, plan);
    const reads = keychain.calls.filter((call) => call.args.includes("-g") || call.args.includes("-w"));
    expect(reads.map((call) => call.args)).toEqual([["find-generic-password", "-s", FROM_SERVICE, "-a", "alex", "-g"]]);
  });

  it("verifies the new item with an existence check that asks for no secret", () => {
    const keychain = seeded();
    const plan = planOf(keychain);
    keychain.calls.length = 0;
    copy(keychain.run, plan);
    const last = keychain.calls.at(-1);
    expect(last?.args).toEqual(["find-generic-password", "-s", TO_SERVICE]);
    expect(last?.args).not.toContain("-w");
    expect(last?.args).not.toContain("-g");
  });

  it("falls back to a quoted password when the hex form would not fit one interactive line, and the tool reads it back intact", () => {
    const large = `{"claudeAiOauth":{"accessToken":"${"a".repeat(FIRST_PART_BYTES)}","refreshToken":"${"b".repeat(SECOND_PART_BYTES)}"}}`;
    const keychain = seeded(large);
    copy(keychain.run, planOf(keychain));
    expect(keychain.secretOf(TO_SERVICE)?.toString("utf8")).toBe(large);
    expect(exposedArguments(keychain.calls)).not.toContain("aaaaaaaaaa");
  });

  it("refuses, before writing anything, a login too large for one interactive line in either encoding", () => {
    const keychain = seeded(`{"claudeAiOauth":{"accessToken":"${"a".repeat(TOO_LARGE_FOR_ANY_FORM)}"}}`);
    const plan = planOf(keychain);
    expect(() => {
      copy(keychain.run, plan);
    }).toThrow(KeychainLoginError);
    expect(keychain.calls.some((call) => call.args[0] === "-i")).toBe(false);
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
  });

  it("refuses a login that is not printable and too large for the hex form, because a quoted word cannot carry it", () => {
    const keychain = seeded(`{"note":"line one\nline two ${"x".repeat(TOO_LARGE_FOR_HEX)}"}`);
    const plan = planOf(keychain);
    expect(() => {
      copy(keychain.run, plan);
    }).toThrow(KeychainLoginError);
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
  });

  it("reports a failed write by exit status and step alone, repeating nothing the tool said", () => {
    const keychain = seeded();
    const plan = planOf(keychain);
    const hex = Buffer.from(SECRET).toString("hex");
    keychain.failNextAdd(1, `unbalanced quote near "${hex.slice(0, QUOTED_FRAGMENT_DIGITS)}" in the command`);
    let message = "";
    try {
      copy(keychain.run, plan);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(`Could not create the login under ${TO_SERVICE}: security exited 1 while adding it.`);
    expect(keychain.items.has(TO_SERVICE)).toBe(false);
  });

  it("removes what it wrote and throws when the new item cannot be found afterwards", () => {
    const keychain = seeded();
    keychain.hideFromLookup.add(TO_SERVICE);
    const plan = planOf(keychain);
    expect(() => {
      copy(keychain.run, plan);
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

describe("the self-hosted mint's Keychain checks, which refuse and never delete", () => {
  const LAB_DIR = "/example/lab/identities/lab";
  const LAB_SERVICE = claudeCodeKeychainService(LAB_DIR);
  const darwin = (keychain: ReturnType<typeof createFakeKeychain>) => ({ run: keychain.run, platform: "darwin" as const });
  const neverReadsAPassword = (keychain: ReturnType<typeof createFakeKeychain>): boolean => !keychain.calls.some((call) => call.args.includes("-g") || call.args.includes("-w"));

  it("asks nothing off macOS, and lets a mint through on macOS when no login is filed for the directory", () => {
    const keychain = createFakeKeychain();
    requireNoClaudeCodeLoginForMint({ run: keychain.run, platform: "linux" }, LAB_DIR, "lab", TEST_CLAUDE_LOGIN);
    expect(keychain.calls).toEqual([]);
    requireNoClaudeCodeLoginForMint(darwin(keychain), LAB_DIR, "lab", TEST_CLAUDE_LOGIN);
    expect(keychain.calls.map((call) => call.args)).toEqual([
      ["find-generic-password", "-s", LAB_SERVICE],
      ["find-generic-password", "-s", LAB_SERVICE, "-a", "alex"],
    ]);
  });

  it("refuses a mint over any login filed for the directory and deletes nothing: a mint, then a real /login, then a second mint", () => {
    const keychain = createFakeKeychain();
    // After the first mint the person signed in for real: the CLI wrote its Keychain item and removed the minted file. Nothing tells that item from a copy of the minted login without reading it.
    keychain.seed(LAB_SERVICE, "alex", "a-made-up-real-login");
    const second = () => {
      requireNoClaudeCodeLoginForMint(darwin(keychain), LAB_DIR, "lab", TEST_CLAUDE_LOGIN);
    };
    expect(second).toThrow(KeychainLoginError);
    expect(second).toThrow(`security delete-generic-password -s '${LAB_SERVICE}' -a 'alex'`);
    expect(second).toThrow("--force does not override this");
    expect(keychain.secretOf(LAB_SERVICE)?.toString("utf8")).toBe("a-made-up-real-login");
    expect(keychain.calls.some((call) => call.args[0] === "delete-generic-password")).toBe(false);
    expect(neverReadsAPassword(keychain)).toBe(true);
  });

  it("finds a login filed under the account Claude Code would use even when the service lookup alone misses it", () => {
    const keychain = createFakeKeychain();
    keychain.seed(LAB_SERVICE, "alex", "a-made-up-login");
    // The service-only lookup is made to miss, as when the first item of the service belongs to another account the tool lists first.
    keychain.hideFromLookup.add(LAB_SERVICE);
    const accountOnly = createFakeKeychain();
    accountOnly.seed(LAB_SERVICE, "alex", "a-made-up-login");
    const run = (command: string, args: readonly string[]) => (args.includes("-a") ? accountOnly.run.run(command, args) : keychain.run.run(command, args));
    expect(() => {
      requireNoClaudeCodeLoginForMint({ run: { run }, platform: "darwin" }, LAB_DIR, "lab", TEST_CLAUDE_LOGIN);
    }).toThrow(KeychainLoginError);
  });

  it("refuses outright, naming the variable and no item to delete, while CLAUDE_SECURESTORAGE_CONFIG_DIR is set, on every platform", () => {
    for (const value of ["/example/secure-storage", ""]) {
      for (const platform of ["darwin", "linux"] as const) {
        const keychain = createFakeKeychain();
        // The user's default login, which an empty override would point a session at: the refusal must not tell anyone to delete it.
        keychain.seed("Claude Code-credentials", "alex", "a-made-up-default-login");
        const login = { env: { USER: "alex", CLAUDE_SECURESTORAGE_CONFIG_DIR: value }, username: () => "alex" };
        const mint = () => {
          requireNoClaudeCodeLoginForMint({ run: keychain.run, platform }, LAB_DIR, "lab", login);
        };
        expect(mint).toThrow("CLAUDE_SECURESTORAGE_CONFIG_DIR is set");
        expect(mint).toThrow("Nothing was minted");
        expect(mint).not.toThrow("delete-generic-password");
        expect(keychain.calls).toEqual([]);
      }
    }
  });

  it("checks the directory's own item when the variable is not set, even with the session's other environment present", () => {
    const keychain = createFakeKeychain();
    keychain.seed(LAB_SERVICE, "alex", "a-made-up-login");
    expect(() => {
      requireNoClaudeCodeLoginForMint(darwin(keychain), LAB_DIR, "lab", { env: { USER: "alex", CLAUDE_CONFIG_DIR: "/example/elsewhere" }, username: () => "alex" });
    }).toThrow(LAB_SERVICE);
  });

  it("finds a login filed for a directory whose path is spelled decomposed, as Claude Code names it", () => {
    const keychain = createFakeKeychain();
    const decomposed = "/example/lab/identities/cafe\u0301";
    // Claude Code files the item under the NFC spelling's hash, whatever bytes the path was given in.
    keychain.seed(claudeCodeKeychainService(decomposed.normalize("NFC")), "alex", "a-made-up-login");
    expect(claudeCodeKeychainService(decomposed)).toBe(claudeCodeKeychainService(decomposed.normalize("NFC")));
    expect(() => {
      requireNoClaudeCodeLoginForMint(darwin(keychain), decomposed, "lab", TEST_CLAUDE_LOGIN);
    }).toThrow(KeychainLoginError);
  });

  it("looks a login up under claude-code-user when the user's name fails Claude Code's pattern", () => {
    const keychain = createFakeKeychain();
    keychain.seed(LAB_SERVICE, "claude-code-user", "a-made-up-login");
    keychain.hideFromLookup.add(LAB_SERVICE);
    const login = { env: { USER: "alex smith" }, username: () => "alex smith" };
    const accountOnly = createFakeKeychain();
    accountOnly.seed(LAB_SERVICE, "claude-code-user", "a-made-up-login");
    const run = (command: string, args: readonly string[]) => (args.includes("-a") ? accountOnly.run.run(command, args) : keychain.run.run(command, args));
    expect(() => {
      requireNoClaudeCodeLoginForMint({ run: { run }, platform: "darwin" }, LAB_DIR, "lab", login);
    }).toThrow(KeychainLoginError);
  });

  it("reports a Keychain that cannot be asked at removal as a note saying the identity was removed, never as a failure", () => {
    const locked = { run: (): { status: number; stdout: string; stderr: string } => ({ status: LOCKED_KEYCHAIN_STATUS, stdout: "", stderr: "User interaction is not allowed." }) };
    const note = selfHostedLoginLeftover({ run: locked, platform: "darwin" }, LAB_DIR, TEST_CLAUDE_LOGIN);
    expect(note).toContain("The identity was removed, but the Keychain could not be checked");
    expect(note).toContain(LAB_SERVICE);
  });

  it("names a self-hosted identity's leftover login on removal without deleting it, and says nothing for an unmarked identity or off macOS", () => {
    const keychain = createFakeKeychain();
    keychain.seed(LAB_SERVICE, "alex", "a-made-up-login");
    expect(selfHostedLoginLeftover(darwin(keychain), LAB_DIR, TEST_CLAUDE_LOGIN)).toContain(`security delete-generic-password -s '${LAB_SERVICE}' -a 'alex'`);
    expect(selfHostedLoginLeftover(darwin(keychain), undefined, TEST_CLAUDE_LOGIN)).toBeUndefined();
    expect(selfHostedLoginLeftover({ run: keychain.run, platform: "linux" }, LAB_DIR, TEST_CLAUDE_LOGIN)).toBeUndefined();
    expect(keychain.items.has(LAB_SERVICE)).toBe(true);
    expect(keychain.calls.some((call) => call.args[0] === "delete-generic-password")).toBe(false);
    expect(neverReadsAPassword(keychain)).toBe(true);
  });
});

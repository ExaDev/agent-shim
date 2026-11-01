import type { RunPort } from "./launcher/ports";

/** The longest line `security -i` keeps, measured against the real tool: it cuts a longer line there and treats the rest as further input. */
const INTERACTIVE_LINE_LIMIT = 4095;

/** One call the fake `security` received. `input` is what was written to its standard input. */
interface SecurityCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

/** One generic password in the fake Keychain. The secret is bytes, because a stored password need not be text. */
interface FakeItem {
  readonly account: string;
  readonly secret: Buffer;
}

/** A `security` that keeps its items in memory and records every call, so a test can see exactly what crossed the process boundary. */
export interface FakeKeychain {
  readonly run: RunPort;
  /** Every call received, in order. */
  readonly calls: SecurityCall[];
  /** The items by service name. Mutable so a test can remove an item behind the code's back. */
  readonly items: Map<string, FakeItem>;
  /** Files an item, as a login written by Claude Code would be. A string is stored as its UTF-8 bytes. */
  readonly seed: (service: string, account: string, secret: string | Uint8Array) => void;
  /** The bytes stored under a service, or undefined when there is no item. */
  readonly secretOf: (service: string) => Buffer | undefined;
  /** Makes the next `add-generic-password` that arrives through `security -i` fail with this exit status, leaving the Keychain unchanged. `stderr` is what the tool prints; by default it repeats the command, as the real tool does. */
  readonly failNextAdd: (status: number, stderr?: string) => void;
  /** Services whose lookups answer "not found" whatever the Keychain holds, as when a write reported success and stored nothing. */
  readonly hideFromLookup: Set<string>;
}

/** The printable ASCII range, as the real tool's `-w` judges a password: from the space to the tilde. */
const PRINTABLE_ASCII = /^[\u0020-\u007e]*$/u;

/** Whether `-w` prints the password as text. Measured on the real tool: printable ASCII is text, and anything else is printed as lowercase hex digits with no sign that it is hex. */
function printsAsText(secret: Buffer): boolean {
  return PRINTABLE_ASCII.test(secret.toString("latin1"));
}

/** Whether `-g` renders the password in quotes. Measured on the real tool: stricter than `-w`, since a double quote or a backslash also forces the `0x<HEX>  "<rendering>"` form. */
function rendersQuoted(secret: Buffer): boolean {
  return printsAsText(secret) && !/["\\]/u.test(secret.toString("latin1"));
}

/** The radix and width of the octal escape the tool renders an unprintable byte as, in the quoted part of the hex form: `\001`, `\377`. */
const OCTAL = 8;
const OCTAL_ESCAPE_DIGITS = 3;

/** The line `-g` prints on standard error for a password, in the two forms the real tool uses. */
function passwordLine(secret: Buffer): string {
  const text = secret.toString("latin1");
  if (rendersQuoted(secret)) {
    return `password: "${text}"`;
  }
  const rendering = text.replace(/[^\u0020-\u007e]|["\\]/gu, (char) => `\\${(char.codePointAt(0) ?? 0).toString(OCTAL).padStart(OCTAL_ESCAPE_DIGITS, "0")}`);
  return `password: 0x${secret.toString("hex").toUpperCase()}  "${rendering}"`;
}

/**
 * Splits one line the way `security -i` does, as measured on the real tool: whitespace separates words, a double quote opens and closes a quoted span, and a backslash makes the next character literal.
 */
function tokenise(line: string): string[] {
  const words: string[] = [];
  let current: string | undefined;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (char === "\\") {
      index += 1;
      current = `${current ?? ""}${line.charAt(index)}`;
    } else if (char === '"') {
      quoted = !quoted;
      current ??= "";
    } else if (!quoted && char === " ") {
      if (current !== undefined) {
        words.push(current);
        current = undefined;
      }
    } else {
      current = `${current ?? ""}${char}`;
    }
  }
  if (current !== undefined) {
    words.push(current);
  }
  return words;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The attribute listing `find-generic-password` prints without `-w` or `-g`: never the secret. */
function attributesOf(service: string, item: FakeItem): string {
  return `keychain: "/fake/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="${item.account}"\n    "svce"<blob>="${service}"\n`;
}

/** A fake `security` over an in-memory Keychain, honouring the subset of commands the login copy uses and reproducing the real tool's output forms for a stored password. */
export function createFakeKeychain(): FakeKeychain {
  const items = new Map<string, FakeItem>();
  const calls: SecurityCall[] = [];
  const hideFromLookup = new Set<string>();
  let nextAddFails: { readonly status: number; readonly stderr: string | undefined } | undefined;

  const addInteractive = (line: string): { status: number; stderr: string } => {
    const words = tokenise(line.slice(0, INTERACTIVE_LINE_LIMIT));
    if (words[0] !== "add-generic-password") {
      return { status: 1, stderr: `unknown command ${words[0] ?? ""}` };
    }
    const service = optionValue(words, "-s");
    const account = optionValue(words, "-a");
    const password = optionValue(words, "-w");
    const hex = optionValue(words, "-X");
    if (service === undefined || account === undefined || (password === undefined) === (hex === undefined)) {
      return { status: 1, stderr: "usage" };
    }
    if (nextAddFails !== undefined) {
      const failure = nextAddFails;
      nextAddFails = undefined;
      return { status: failure.status, stderr: failure.stderr ?? `could not add ${service}: the command was ${line}` };
    }
    if (items.has(service) && !words.includes("-U")) {
      return { status: 45, stderr: "The specified item already exists in the keychain." };
    }
    items.set(service, { account, secret: hex === undefined ? Buffer.from(password ?? "", "utf8") : Buffer.from(hex, "hex") });
    return { status: 0, stderr: "" };
  };

  const run = (command: string, args: readonly string[], input?: string): { status: number; stdout: string; stderr: string } => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }) });
    if (command !== "security") {
      return { status: 127, stdout: "", stderr: "not found" };
    }
    if (args[0] === "-i") {
      for (const line of (input ?? "").split("\n").filter((candidate) => candidate !== "")) {
        const result = addInteractive(line);
        if (result.status !== 0) {
          return { status: result.status, stdout: "", stderr: result.stderr };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    const service = optionValue(args, "-s");
    const item = service === undefined ? undefined : items.get(service);
    if (args[0] === "find-generic-password") {
      if (service === undefined || item === undefined || hideFromLookup.has(service)) {
        return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      }
      if (args.includes("-w")) {
        return { status: 0, stdout: `${printsAsText(item.secret) ? item.secret.toString("latin1") : item.secret.toString("hex")}\n`, stderr: "" };
      }
      return { status: 0, stdout: attributesOf(service, item), stderr: args.includes("-g") ? `${passwordLine(item.secret)}\n` : "" };
    }
    if (args[0] === "delete-generic-password") {
      if (service === undefined || item === undefined) {
        return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
      }
      items.delete(service);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unsupported ${args.join(" ")}` };
  };
  return {
    run: { run },
    calls,
    items,
    seed: (service, account, secret) => {
      items.set(service, { account, secret: typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret) });
    },
    secretOf: (service) => items.get(service)?.secret,
    failNextAdd: (status, stderr) => {
      nextAddFails = { status, stderr };
    },
    hideFromLookup,
  };
}

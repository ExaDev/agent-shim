import type { RunPort } from "./launcher/ports";

/** The longest line `security -i` keeps, measured against the real tool: it cuts a longer line there and treats the rest as further input. */
const INTERACTIVE_LINE_LIMIT = 4095;

/** One call the fake `security` received. `input` is what was written to its standard input. */
interface SecurityCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}

/** One generic password in the fake Keychain. */
interface FakeItem {
  readonly account: string;
  readonly secret: string;
}

/** A `security` that keeps its items in memory and records every call, so a test can see exactly what crossed the process boundary. */
export interface FakeKeychain {
  readonly run: RunPort;
  /** Every call received, in order. */
  readonly calls: SecurityCall[];
  /** The items by service name. Mutable so a test can seed it or remove an item behind the code's back. */
  readonly items: Map<string, FakeItem>;
  /** Makes the next `add-generic-password` that arrives through `security -i` fail with this exit status, leaving the Keychain unchanged. */
  readonly failNextAdd: (status: number) => void;
  /** Services whose lookups answer "not found" whatever the Keychain holds, as when a write reported success and stored nothing. */
  readonly hideFromLookup: Set<string>;
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

/** A fake `security` over an in-memory Keychain, honouring the subset of commands the login copy uses. */
export function createFakeKeychain(): FakeKeychain {
  const items = new Map<string, FakeItem>();
  const calls: SecurityCall[] = [];
  const hideFromLookup = new Set<string>();
  let nextAddFails: number | undefined;

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
      const status = nextAddFails;
      nextAddFails = undefined;
      return { status, stderr: `could not add ${service}: the command was ${line}` };
    }
    if (items.has(service) && !words.includes("-U")) {
      return { status: 45, stderr: "The specified item already exists in the keychain." };
    }
    items.set(service, { account, secret: password ?? Buffer.from(hex ?? "", "hex").toString("utf8") });
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
      return { status: 0, stdout: args.includes("-w") ? `${item.secret}\n` : attributesOf(service, item), stderr: "" };
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
    failNextAdd: (status) => {
      nextAddFails = status;
    },
    hideFromLookup,
  };
}

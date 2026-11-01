import { CliError } from "./cliError";
import type { RunPort } from "./launcher/ports";
import { claudeCodeKeychainService } from "./usage/signIn";

/** The exit status `security find-generic-password` and `delete-generic-password` give an item that is not there (`errSecItemNotFound`). Any other failure, a locked Keychain included, is not an absence. */
const ITEM_NOT_FOUND_STATUS = 44;

/**
 * The longest line `security -i` keeps, in characters, measured against the real tool: it cuts a longer line at this length and treats the rest as further input, so a command that does not fit would store a truncated secret.
 */
const INTERACTIVE_LINE_LIMIT = 4095;

/** What stands in for text that would have repeated the secret. */
const REDACTED = "[redacted]";

/** The longest excerpt of the tool's own message an error carries. */
const MAX_DETAIL_CHARS = 200;

/** Characters a quoted word in `security -i` carries as they are: printable ASCII. Control characters would end the line, and the tool's handling of anything wider is unmeasured. */
const PRINTABLE_ASCII = /^[\u0020-\u007e]*$/u;

/** A control character, which no service or account name may hold because it would end or split the command line. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** A Keychain login could not be read, copied or removed. The message never holds the secret. */
export class KeychainLoginError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "KeychainLoginError";
  }
}

/** What copying one directory's Keychain login to another's takes: both service names, and the account the item is filed under (the operating system user, for a login Claude Code wrote). */
export interface KeychainLoginPlan {
  readonly fromService: string;
  readonly toService: string;
  readonly account: string;
}

/** The result of asking `security` about one service without asking for its secret. */
type Lookup = { readonly found: false } | { readonly found: true; readonly attributes: string };

/**
 * Looks one service up by attributes only. `find-generic-password` without `-w` or `-g` prints the item's attributes and never its secret, and never prompts for access to it.
 */
function lookup(run: RunPort, service: string): Lookup {
  const result = run.run("security", ["find-generic-password", "-s", service]);
  if (result.status === 0) {
    return { found: true, attributes: result.stdout };
  }
  if (result.status === ITEM_NOT_FOUND_STATUS) {
    return { found: false };
  }
  throw new KeychainLoginError(`Could not look up the Keychain item ${service}: security exited ${result.status === null ? "without a status" : String(result.status)}${describe(result.stderr)}.`);
}

/** The first line of the tool's own message as ` (<line>)`, or nothing when it said none. */
function describe(stderr: string): string {
  const [first] = stderr.trim().split("\n");
  return first === undefined || first === "" ? "" : ` (${first.slice(0, MAX_DETAIL_CHARS)})`;
}

/** `value` with a backslash before each quote and backslash, which is how the tool's own tokeniser reads a character back literally. */
function escaped(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

/** `value` as one `security -i` word: in double quotes. */
function quoted(value: string): string {
  return `"${escaped(value)}"`;
}

/** `text` with every form of `secret` that a message could repeat replaced by a marker, longest form first so a form that contains another is replaced whole. */
function scrubbed(text: string, secret: string): string {
  const forms = [secret, Buffer.from(secret, "utf8").toString("hex"), escaped(secret), quoted(secret)].sort((left, right) => right.length - left.length);
  return forms.reduce((remaining, form) => remaining.split(form).join(REDACTED), text);
}

/** The account name from an attribute listing, as the tool prints it: `"acct"<blob>="name"`. */
function accountOf(attributes: string, service: string): string {
  const line = attributes.split("\n").find((candidate) => candidate.includes('"acct"<blob>='));
  const value = line?.slice(line.indexOf("=") + 1).trim();
  const name = value === undefined ? undefined : /^"([^"\\]*)"$/u.exec(value)?.[1];
  if (name === undefined || name === "" || CONTROL_CHARACTER.test(name)) {
    throw new KeychainLoginError(`The Keychain item ${service} has no plain account name, so its login cannot be copied.`);
  }
  return name;
}

/**
 * Plans copying the login Claude Code keeps for configuration directory `fromDir` to `toDir`, or returns undefined when `fromDir` has none (an identity that authenticates by a token or a provider never signed in with one). Reads attributes only.
 *
 * Throws `KeychainLoginError` when `toDir` already has an item, which only a removed identity of that name leaves behind (`identity remove` does not touch the Keychain) and which a copy would have to overwrite, and when the Keychain cannot be asked.
 */
export function planKeychainLogin(run: RunPort, fromDir: string, toDir: string): KeychainLoginPlan | undefined {
  const fromService = claudeCodeKeychainService(fromDir);
  const toService = claudeCodeKeychainService(toDir);
  const from = lookup(run, fromService);
  if (!from.found) {
    return undefined;
  }
  if (lookup(run, toService).found) {
    throw new KeychainLoginError(
      `The Keychain already holds a login for ${toDir} (service ${toService}), left behind by an identity of that name that was removed. Remove it with \`security delete-generic-password -s "${toService}"\` or choose another name.`,
    );
  }
  return { fromService, toService, account: accountOf(from.attributes, fromService) };
}

/**
 * The `security -i` command that adds the password, or undefined when it cannot be sent on one line. The hex form (`-X`) carries any bytes; a quoted `-w` is half the size and used when the hex form does not fit and the secret is printable ASCII.
 */
function addCommand(plan: KeychainLoginPlan, secret: string): string | undefined {
  const prefix = `add-generic-password -s ${quoted(plan.toService)} -a ${quoted(plan.account)}`;
  const candidates = [`${prefix} -X ${Buffer.from(secret, "utf8").toString("hex")}`, ...(PRINTABLE_ASCII.test(secret) ? [`${prefix} -w ${quoted(secret)}`] : [])];
  return candidates.find((candidate) => candidate.length <= INTERACTIVE_LINE_LIMIT);
}

/**
 * Copies the login to the new service, then checks the new item is there. The secret is read from the old item into memory and written to the new one through `security -i` on standard input, so it is never in an argument list, where any local process could read it from the process table. An error carries the tool's own message only with every form of the secret removed, because `security` repeats the arguments it was given when a command fails.
 *
 * On failure the new item is removed again if it was created, the old item is untouched, and `KeychainLoginError` is thrown. The old item is the caller's to delete once the whole rename has succeeded (`deleteKeychainLogin`).
 */
export function copyKeychainLogin(run: RunPort, plan: KeychainLoginPlan): void {
  const read = run.run("security", ["find-generic-password", "-s", plan.fromService, "-a", plan.account, "-w"]);
  if (read.status !== 0) {
    throw new KeychainLoginError(`Could not read the login stored under ${plan.fromService}: security exited ${read.status === null ? "without a status" : String(read.status)}${describe(read.stderr)}.`);
  }
  const secret = read.stdout.endsWith("\n") ? read.stdout.slice(0, -1) : read.stdout;
  if (secret === "") {
    throw new KeychainLoginError(`The login stored under ${plan.fromService} is empty, so there is nothing to copy.`);
  }
  const command = addCommand(plan, secret);
  if (command === undefined) {
    throw new KeychainLoginError(`The login stored under ${plan.fromService} is too large to copy without putting it in a command's arguments, which \`security -i\` takes at most ${String(INTERACTIVE_LINE_LIMIT)} characters of. Sign in again under the new name instead.`);
  }
  const added = run.run("security", ["-i"], `${command}\n`);
  if (added.status !== 0) {
    abandonCopy(run, plan, `Could not create the login under ${plan.toService}: security exited ${added.status === null ? "without a status" : String(added.status)}${describe(scrubbed(added.stderr, secret))}.`);
  }
  if (run.run("security", ["find-generic-password", "-s", plan.toService]).status !== 0) {
    abandonCopy(run, plan, `The login under ${plan.toService} was not found afterwards, so the copy was removed and the old login kept.`);
  }
}

/** Removes whatever of the copy exists and throws `message`, adding the reason when the removal fails too. */
function abandonCopy(run: RunPort, plan: KeychainLoginPlan, message: string): never {
  try {
    deleteKeychainLogin(run, plan.toService, plan.account);
  } catch (error) {
    throw new KeychainLoginError(`${message} ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new KeychainLoginError(message);
}

/** Deletes the login filed under `service` for `account`. An item already gone is fine, so this serves the final removal of the old login and the rollback of a copy alike. */
export function deleteKeychainLogin(run: RunPort, service: string, account: string): void {
  const result = run.run("security", ["delete-generic-password", "-s", service, "-a", account]);
  if (result.status !== 0 && result.status !== ITEM_NOT_FOUND_STATUS) {
    throw new KeychainLoginError(`Could not delete the Keychain item ${service}: security exited ${result.status === null ? "without a status" : String(result.status)}${describe(result.stderr)}.`);
  }
}

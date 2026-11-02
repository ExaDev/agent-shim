import { CliError } from "./cliError";
import type { RunPort } from "./launcher/ports";
import { claudeCodeKeychainService } from "./usage/signIn";

/** The exit status `security find-generic-password` and `delete-generic-password` give an item that is not there (`errSecItemNotFound`). Any other failure, a locked Keychain included, is not an absence. */
const ITEM_NOT_FOUND_STATUS = 44;

/**
 * The longest line `security -i` keeps, in characters, measured against the real tool: it cuts a longer line at this length and treats the rest as further input, so a command that does not fit would store a truncated secret.
 */
const INTERACTIVE_LINE_LIMIT = 4095;

/** The longest excerpt of the tool's own message an error carries, for the commands that carry no secret. */
const MAX_DETAIL_CHARS = 200;

/** Characters a quoted word in `security -i` carries as they are: printable ASCII. Control characters would end the line, and the tool's handling of anything wider is unmeasured. */
const PRINTABLE_ASCII = /^[\u0020-\u007e]*$/u;

/** A control character, which no service or account name may hold because it would end or split the command line. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** The line `security find-generic-password -g` prints on standard error for the password: in the form `password: 0x<HEX>  "<rendering>"` when the bytes are not plain text (or hold a double quote or a backslash), and `password: "<text>"` otherwise. */
const PASSWORD_LINE = /^password: (?:0x(?<hex>[0-9A-Fa-f]*)(?:\s.*)?|"(?<text>.*)")$/mu;

/** A Keychain login could not be read, copied or removed, or one is in the way of what was asked. The message never holds the secret, nor any text the tool printed while the secret was in play. */
export class KeychainLoginError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "KeychainLoginError";
  }
}

/**
 * The Keychain could not be asked at all: `security` gave no answer (it could not be started, or was stopped after its time limit) or failed in a way that is not an absence, a locked Keychain among them. It says nothing about whether an item is there, and asking again may succeed, which is what separates it from a `KeychainLoginError` that reports a login that was found.
 */
export class KeychainLookupError extends KeychainLoginError {
  constructor(message: string) {
    super(message);
    this.name = "KeychainLookupError";
  }
}

/** How many milliseconds make a second. */
const MS_PER_SECOND = 1000;

/** The longest the door waits for the attributes of one Keychain item, in seconds: the lookup reads the local Keychain database and answers in a fraction of this, so the bound leaves a loaded host room while still ending a stuck `security` long before a client gives up. It is the bound a credential source of the `keychain` kind has for the same tool, which also answers at once or fails at once ("User interaction is not allowed") and never waits on a person. */
const KEYCHAIN_LOOKUP_SECONDS = 10;

/**
 * The limit the door runs the Keychain lookup under (`realRunAsyncWithin`), so a `security` that does not answer ends as a `KeychainLookupError` instead of holding the request. The command line has no limit: a person is at the terminal and can interrupt it.
 */
export const KEYCHAIN_LOOKUP_TIMEOUT_MS = KEYCHAIN_LOOKUP_SECONDS * MS_PER_SECOND;

/** What copying one directory's Keychain login to another's takes: both service names, and the account the item is filed under (the operating system user, for a login Claude Code wrote). */
export interface KeychainLoginPlan {
  readonly fromService: string;
  readonly toService: string;
  readonly account: string;
  /** True when the new service already holds the login: an earlier run of the same rename copied it, so there is nothing to read or write, only the old item to delete at the end. Only a plan made for a resumed rename says so; any other finds the item and refuses. */
  readonly alreadyCopied: boolean;
}

/** The result of asking `security` about one service without asking for its secret. */
type Lookup = { readonly found: false } | { readonly found: true; readonly attributes: string };

/** The exit status as a phrase, for a message. */
function statusPhrase(status: number | null): string {
  return status === null ? "without a status" : String(status);
}

/** The first line of the tool's own message as ` (<line>)`, or nothing when it said none. Used only for commands whose arguments and output carry no secret. */
function describe(stderr: string): string {
  const [first] = stderr.trim().split("\n");
  return first === undefined || first === "" ? "" : ` (${first.slice(0, MAX_DETAIL_CHARS)})`;
}

/**
 * Looks one service up by attributes only. `find-generic-password` without `-w` or `-g` prints the item's attributes and never its secret, and never prompts for access to it. Throws `KeychainLookupError` when `security` did not answer or failed for a reason other than the item's absence.
 */
function lookup(run: RunPort, service: string): Lookup {
  const result = run.run("security", ["find-generic-password", "-s", service]);
  if (result.status === 0) {
    return { found: true, attributes: result.stdout };
  }
  if (result.status === ITEM_NOT_FOUND_STATUS) {
    return { found: false };
  }
  throw new KeychainLookupError(`Could not look up the Keychain item ${service}: security exited ${statusPhrase(result.status)}${describe(result.stderr)}.`);
}

/** `value` with a backslash before each quote and backslash, which is how the tool's own tokeniser reads a character back literally. */
function escaped(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

/** `value` as one `security -i` word: in double quotes. */
function quoted(value: string): string {
  return `"${escaped(value)}"`;
}

/** The account name from an attribute listing, as the tool prints it: `"acct"<blob>="name"`, or undefined when there is no plain one: none, an empty one, or one with a control character in it. */
function plainAccountOf(attributes: string): string | undefined {
  const line = attributes.split("\n").find((candidate) => candidate.includes('"acct"<blob>='));
  const value = line?.slice(line.indexOf("=") + 1).trim();
  const name = value === undefined ? undefined : /^"([^"\\]*)"$/u.exec(value)?.[1];
  return name === undefined || name === "" || CONTROL_CHARACTER.test(name) ? undefined : name;
}

/** The account name from an attribute listing, for a login that is to be copied, which needs one. */
function accountOf(attributes: string, service: string): string {
  const name = plainAccountOf(attributes);
  if (name === undefined) {
    throw new KeychainLoginError(`The Keychain item ${service} has no plain account name, so its login cannot be copied.`);
  }
  return name;
}

/** The command that deletes the Keychain item filed under `service`, for a message that tells the person what to run. `account` narrows it to one item when the listing gave a plain one. */
export function keychainDeleteCommand(service: string, account: string | undefined): string {
  return `security delete-generic-password -s ${shellQuoted(service)}${account === undefined ? "" : ` -a ${shellQuoted(account)}`}`;
}

/** `value` as one POSIX shell word that the shell takes literally: in single quotes, with each single quote inside it closed, escaped and reopened. An account name is whatever the Keychain item holds, so nothing about it can be assumed safe to paste into a shell. */
function shellQuoted(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/** What a question to the Keychain needs: the runner of `security` and the platform, since only macOS has a Keychain. */
export interface KeychainProbe {
  readonly run: RunPort;
  readonly platform: NodeJS.Platform;
}

/**
 * Throws `KeychainLoginError` when, on macOS, the Keychain already holds a Claude Code login filed for `configDir`: a new identity created there would start signed in as that account, because Claude Code finds its login by the hash of the directory and not by anything the identity owns. Such an item is left by an identity of that name that was renamed or removed, since `identity remove` does not touch the Keychain and a rename's last step can fail or be cut short. The message names the entry, the exact command that deletes it, and the flag that keeps it on purpose. Throws `KeychainLookupError` instead when the Keychain could not be asked, which says nothing about a leftover.
 *
 * `keepLogin` is the person's statement that the login is wanted (`identity add --keep-keychain-login`): nothing is asked of the Keychain and nothing is refused. Otherwise only attributes are asked for, so the login is never read and the Keychain is never asked for access to it. Off macOS there is no Keychain and nothing is asked.
 */
export function requireNoLeftoverKeychainLogin(keychain: KeychainProbe, configDir: string, name: string, keepLogin: boolean): void {
  if (keepLogin || keychain.platform !== "darwin") {
    return;
  }
  const service = claudeCodeKeychainService(configDir);
  const found = lookup(keychain.run, service);
  if (!found.found) {
    return;
  }
  const account = plainAccountOf(found.attributes);
  throw new KeychainLoginError(
    `Cannot create identity "${name}": the Keychain already holds a Claude Code login filed for ${configDir} (service ${service}${account === undefined ? "" : `, account ${account}`}), left behind by an identity of that name that was renamed or removed. A new identity there would start signed in as that account. If you do not need it, delete it with \`${keychainDeleteCommand(service, account)}\` and run the command again. To create the identity signed in as that account on purpose, run \`agent-shim identity add ${name} --keep-keychain-login\`.`,
  );
}

/**
 * Plans copying the login Claude Code keeps for configuration directory `fromDir` to `toDir`, or returns undefined when `fromDir` has none (an identity that authenticates by a token or a provider never signed in with one). Reads attributes only.
 *
 * Throws `KeychainLoginError` when `toDir` already has an item and this is not `resuming` a rename that was left unfinished, since a copy would have to overwrite it; when resuming, an item already there is the earlier run's copy and the plan says so (`alreadyCopied`). Also throws when the Keychain cannot be asked.
 */
export function planKeychainLogin(run: RunPort, fromDir: string, toDir: string, resuming = false): KeychainLoginPlan | undefined {
  const fromService = claudeCodeKeychainService(fromDir);
  const toService = claudeCodeKeychainService(toDir);
  const from = lookup(run, fromService);
  if (!from.found) {
    return undefined;
  }
  const alreadyCopied = lookup(run, toService).found;
  if (alreadyCopied && !resuming) {
    throw new KeychainLoginError(
      `The Keychain already holds a login filed for ${toDir} (service ${toService}). It is left behind by an identity of that name that was removed, since \`identity remove\` does not touch the Keychain. If you do not need it, remove it with \`${keychainDeleteCommand(toService, undefined)}\`, or choose another name.`,
    );
  }
  return { fromService, toService, account: accountOf(from.attributes, fromService), alreadyCopied };
}

/**
 * The exact bytes of the password in the output `security find-generic-password -g` printed on standard error, or undefined when no password line is there.
 *
 * `-w` is not used because it prints a password that is not plain text as bare hex digits, with nothing to tell them from a password that happens to be hex, so a copy made from it stores the digits as the new password. `-g` says which form it printed.
 */
function passwordBytesOf(stderr: string): Buffer | undefined {
  const groups = PASSWORD_LINE.exec(stderr)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  if (groups.hex !== undefined) {
    return groups.hex.length % 2 === 0 ? Buffer.from(groups.hex, "hex") : undefined;
  }
  return groups.text === undefined ? undefined : Buffer.from(groups.text, "utf8");
}

/**
 * The `security -i` command that adds the password, or undefined when it cannot be sent on one line. The hex form (`-X`) carries any bytes; a quoted `-w` is half the size and used when the hex form does not fit and the bytes are printable ASCII.
 */
function addCommand(plan: KeychainLoginPlan, bytes: Buffer): string | undefined {
  const prefix = `add-generic-password -s ${quoted(plan.toService)} -a ${quoted(plan.account)}`;
  const text = bytes.toString("latin1");
  const candidates = [`${prefix} -X ${bytes.toString("hex")}`, ...(PRINTABLE_ASCII.test(text) ? [`${prefix} -w ${quoted(text)}`] : [])];
  return candidates.find((candidate) => candidate.length <= INTERACTIVE_LINE_LIMIT);
}

/**
 * Reads the login's password bytes from the old item into memory. This is the call that can wait on a person: the item was written by Claude Code, so `security` is not on its access list and the Keychain may ask for approval, or for the Keychain to be unlocked. Callers make it before they take anything others wait on.
 *
 * No message carries any text the tool printed, because it prints the password itself on standard error: a failure is reported by exit status alone.
 */
export function readKeychainLogin(run: RunPort, plan: KeychainLoginPlan): Buffer {
  const read = run.run("security", ["find-generic-password", "-s", plan.fromService, "-a", plan.account, "-g"]);
  if (read.status !== 0) {
    throw new KeychainLoginError(`Could not read the login stored under ${plan.fromService}: security exited ${statusPhrase(read.status)} while reading it.`);
  }
  const bytes = passwordBytesOf(read.stderr);
  if (bytes === undefined || bytes.length === 0) {
    throw new KeychainLoginError(`The login stored under ${plan.fromService} has no password this tool can read, so there is nothing to copy.`);
  }
  return bytes;
}

/**
 * Writes `bytes`, as read by `readKeychainLogin`, to the new service, then checks the new item is there. The bytes go through `security -i` on standard input, so they are never in an argument list, where any local process could read them from the process table. The tool repeats the arguments it was given when a command fails, so a failure is reported by exit status and the step that failed, never by text the tool printed.
 *
 * On failure the new item is removed again if it was created, the old item is untouched, and `KeychainLoginError` is thrown. A login too large for one interactive line in either encoding is refused before anything is written. The old item is the caller's to delete once the whole rename has succeeded (`deleteKeychainLogin`).
 */
export function writeKeychainLogin(run: RunPort, plan: KeychainLoginPlan, bytes: Buffer): void {
  const command = addCommand(plan, bytes);
  if (command === undefined) {
    throw new KeychainLoginError(`The login stored under ${plan.fromService} is too large to copy without putting it in a command's arguments, which \`security -i\` takes at most ${String(INTERACTIVE_LINE_LIMIT)} characters of. Sign in again under the new name instead.`);
  }
  const added = run.run("security", ["-i"], `${command}\n`);
  if (added.status !== 0) {
    abandonCopy(run, plan, `Could not create the login under ${plan.toService}: security exited ${statusPhrase(added.status)} while adding it.`);
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
    throw new KeychainLoginError(`Could not delete the Keychain item ${service}: security exited ${statusPhrase(result.status)}${describe(result.stderr)}.`);
  }
}

import { CliError } from "./cliError";
import type { RunPort } from "./launcher/ports";
import { CUSTOM_OAUTH_URL_ENV, SECURE_STORAGE_CONFIG_DIR_ENV, claudeCodeKeychainService } from "./usage/signIn";
import { KEYCHAIN_CACHE_SERVICE, KEYCHAIN_ITEM_NOT_FOUND_STATUS } from "./credentialCache";
import { shellQuoted } from "./shellQuote";

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
  if (result.status === KEYCHAIN_ITEM_NOT_FOUND_STATUS) {
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

/** What `identity add --keep-keychain-login`, and the door's `keepKeychainLogin`, do: the person says that a login the Keychain holds for the directory is wanted, which is otherwise refused because the new identity would start signed in as that account. One text, so the command line, the typed API and the MCP tool derived from it say the same. */
export const KEEP_KEYCHAIN_LOGIN_DESCRIPTION =
  "Create the identity even though the macOS Keychain already holds a Claude Code login filed for its directory (left by an identity stored there that was moved with `identity rename --move` or removed); the identity starts signed in as that account. If another identity holds that login, the two share it. Without it that login is refused and the command that deletes it is printed.";

/** What a question to the Keychain needs: the runner of `security` and the platform, since only macOS has a Keychain. */
export interface KeychainProbe {
  readonly run: RunPort;
  readonly platform: NodeJS.Platform;
}

/**
 * Throws `KeychainLoginError` when, on macOS, the Keychain already holds a Claude Code login filed for `configDir`: a new identity created there would start signed in as that account, because Claude Code finds its login by the hash of the directory and not by anything the identity owns. Such an item is left by an identity stored there that was moved with `identity rename --move` or removed, since `identity remove` does not delete the Claude Code login (it deletes only the cached credential) and the last step of `--move` can fail or be cut short; a rename of the name alone leaves the directory, and so the login, where it was. The message names the entry, the exact command that deletes it, and the flag that keeps it on purpose, and says that keeping a login another identity holds shares it between the two. It cannot name that identity: the Keychain item carries the operating system account, not an identity, and a finished rename leaves no record of the pair. Throws `KeychainLookupError` instead when the Keychain could not be asked, which says nothing about a leftover.
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
    `Cannot create identity "${name}": the Keychain already holds a Claude Code login filed for ${configDir} (service ${service}${account === undefined ? "" : `, account ${account}`}), left by an identity stored there that was moved with \`identity rename --move\` or removed. A new identity there would start signed in as that account. If you do not need it, delete it with \`${keychainDeleteCommand(service, account)}\` and run the command again. To create the identity signed in as that account on purpose, run \`agent-shim identity add ${name} --keep-keychain-login\`. If another identity holds a copy of that login, as an identity moved with \`identity rename --move\` does when its old item could not be deleted, keeping it makes the two share one login.`,
  );
}

/**
 * Whether the Keychain store holds a cached credential for `owner` (`identity <id>` for an identity), asked by attributes alone, so no secret is read and nothing prompts. Off macOS there is no Keychain and the answer is no. Throws `KeychainLookupError` when the Keychain could not be asked, which says nothing about whether an entry is there.
 */
export function keychainCacheEntryExists(keychain: KeychainProbe, owner: string): boolean {
  if (keychain.platform !== "darwin") {
    return false;
  }
  const result = keychain.run.run("security", ["find-generic-password", "-s", KEYCHAIN_CACHE_SERVICE, "-a", owner]);
  if (result.status === 0) {
    return true;
  }
  if (result.status === KEYCHAIN_ITEM_NOT_FOUND_STATUS) {
    return false;
  }
  throw new KeychainLookupError(`Could not look up the cached credential ${owner} in the Keychain: security exited ${statusPhrase(result.status)}${describe(result.stderr)}.`);
}

/** Raised when `security` could not delete the cached credential the Keychain store keeps for an owner: the entry is still there, so the message names the command that deletes it. */
export class KeychainCacheDeleteError extends CliError {
  /** `removedIdentity` names the identity `identity remove` (or the door's `config.identity.remove`) had already removed when the delete failed, so the message says that the removal itself is done and only the entry is left. `notes` are further sentences about what the removal left behind, which the one failure carries so none is lost. */
  constructor(
    readonly owner: string,
    readonly status: number | null,
    readonly removedIdentity?: string,
    readonly notes: readonly string[] = [],
  ) {
    super(
      `${removedIdentity === undefined ? "Could not delete" : `Removed identity "${removedIdentity}", but could not delete its`} cached credential ${removedIdentity === undefined ? `for ${owner} ` : `(${owner}) `}from the Keychain: security exited ${statusPhrase(status)}. It is still there; delete it with \`${keychainDeleteCommand(KEYCHAIN_CACHE_SERVICE, owner)}\`.${notes.map((note) => ` ${note}`).join("")}`,
    );
    this.name = "KeychainCacheDeleteError";
  }

  /** The same failure, said as one met after identity `name` was removed. */
  afterRemoving(name: string): KeychainCacheDeleteError {
    return new KeychainCacheDeleteError(this.owner, this.status, name, this.notes);
  }

  /** The same failure, carrying `notes` as well: what else the removal left behind, for a removal that fails after its leftover check was still owed. */
  withNotes(notes: readonly string[]): KeychainCacheDeleteError {
    return new KeychainCacheDeleteError(this.owner, this.status, this.removedIdentity, [...this.notes, ...notes]);
  }
}

/** Throws `KeychainCacheDeleteError` unless `status`, the exit status of deleting the cached credential for `owner` (`keychainCacheDeleteArgs`), says it was deleted or was not there. `removedIdentity` is as `KeychainCacheDeleteError` takes it. */
export function requireKeychainCacheDeleted(owner: string, status: number | null, removedIdentity?: string): void {
  if (status !== 0 && status !== KEYCHAIN_ITEM_NOT_FOUND_STATUS) {
    throw new KeychainCacheDeleteError(owner, status, removedIdentity);
  }
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
      `The Keychain already holds a login filed for ${toDir} (service ${toService}). It is left by an identity stored there that was removed, since \`identity remove\` does not delete the Claude Code login. If you do not need it, remove it with \`${keychainDeleteCommand(toService, undefined)}\`, or choose another name.`,
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
 * On failure the new item is removed again if it was created, the old item is untouched, and `KeychainLoginError` is thrown. A login too large for one interactive line in either encoding is refused before anything is written, and the message names the command that deletes the old item, which discards the login but lets the rename run, since with no item there is nothing to copy. The old item is the caller's to delete once the whole rename has succeeded (`deleteKeychainLogin`).
 */
export function writeKeychainLogin(run: RunPort, plan: KeychainLoginPlan, bytes: Buffer): void {
  const command = addCommand(plan, bytes);
  if (command === undefined) {
    throw new KeychainLoginError(
      `The login stored under ${plan.fromService} is too large to copy through the input line of \`security -i\`, which takes at most ${String(INTERACTIVE_LINE_LIMIT)} characters of a line, in the hex form or the quoted form. Nothing has been changed. To rename anyway, delete that Keychain item with \`${keychainDeleteCommand(plan.fromService, plan.account)}\`, then run the rename again (with no item there, nothing is left to copy), then sign in under the new name. This discards the stored login.`,
    );
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
  if (result.status !== 0 && result.status !== KEYCHAIN_ITEM_NOT_FOUND_STATUS) {
    throw new KeychainLoginError(`Could not delete the Keychain item ${service}: security exited ${statusPhrase(result.status)}${describe(result.stderr)}.`);
  }
}

/** What the self-hosted mint reads about the environment a session would inherit, injected so tests never touch `process.env`. */
export interface ClaudeCodeLoginEnv {
  /** The environment a session launched from here would inherit (`CLAUDE_SECURESTORAGE_CONFIG_DIR`). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Whether the Keychain holds a Claude Code login filed for `configDir`, asked by attributes only (no password is read, so nothing prompts). The lookup is by the directory's service (`claudeCodeKeychainService`) alone, which matches an item under any account, the one a session reads included, so no account needs deriving. The account, when the listing gives a plain one, is returned so the delete command can name exactly that item. Throws `KeychainLookupError` when the Keychain could not be asked.
 */
function claudeCodeLoginFound(run: RunPort, configDir: string): { readonly service: string; readonly account: string | undefined } | undefined {
  const service = claudeCodeKeychainService(configDir);
  const found = lookup(run, service);
  return found.found ? { service, account: plainAccountOf(found.attributes) } : undefined;
}

/**
 * Refuses a self-hosted mint into `configDir` whenever `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set (on any platform), whenever `CLAUDE_CODE_CUSTOM_OAUTH_URL` is non-empty (it renames the account block's file and the Keychain item), and on macOS while the Keychain holds the Claude Code login filed for the directory. Claude Code reads that item ahead of the `.credentials.json` the mint writes, so the session would sign in as that account instead of with the minted login. Nothing can tell a real login from a copy the CLI made of an earlier mint without reading the secret, which this never does, so every item is refused, the mint's own directory included, and nothing is ever deleted: the message names the exact command that deletes the item, for the person to run if they do not need it. `--force` does not override this. Off macOS the file is Claude Code's only store and nothing is asked. Throws `KeychainLookupError`, saying nothing was minted, when the Keychain could not be asked.
 */
export function requireNoClaudeCodeLoginForMint(keychain: KeychainProbe, configDir: string, identity: string, login: ClaudeCodeLoginEnv): void {
  // The variable moves Claude Code's whole credential store, the Keychain item's name and the plaintext fallback alike, to the directory it names (or to the default `~/.claude` when empty), on every platform (2.1.319's secure storage). A session that inherits it never reads the minted file, and which of its items a session would read is the session's environment's to decide, not this process's: so the mint refuses outright rather than guess, and names no item to delete.
  if (login.env[SECURE_STORAGE_CONFIG_DIR_ENV] !== undefined) {
    throw new KeychainLoginError(
      `Cannot mint a self-hosted login into identity "${identity}": ${SECURE_STORAGE_CONFIG_DIR_ENV} is set, which moves Claude Code's credential store (its Keychain item and its .credentials.json) away from ${configDir}, so a session that inherits it would never read the minted login. Nothing was minted. Unset ${SECURE_STORAGE_CONFIG_DIR_ENV} here and in the environment the session is launched from, then mint again.`,
    );
  }
  // A non-empty custom OAuth URL makes Claude Code read its global config (the `.claude.json` that carries the minted account block and feature-cache seed) from `.claude-custom-oauth.json` instead, and on macOS file its Keychain item under a `-custom-oauth` name the lookup below does not derive (2.1.319): the minted account block would never be read, and the lookup could report a clean Keychain it did not check. The mint refuses on every platform rather than write files the session ignores. The variable of the mint's own environment is the one seen, as for the secure-storage override above.
  const customOAuthUrl = login.env[CUSTOM_OAUTH_URL_ENV];
  if (customOAuthUrl !== undefined && customOAuthUrl !== "") {
    throw new KeychainLoginError(
      `Cannot mint a self-hosted login into identity "${identity}": ${CUSTOM_OAUTH_URL_ENV} is set, which makes Claude Code read its account block from .claude-custom-oauth.json instead of the .claude.json the mint writes in ${configDir} (and, on macOS, file its Keychain login under a different name this check does not look for), so a session that inherits it would not use the minted login. Nothing was minted. Unset ${CUSTOM_OAUTH_URL_ENV} here and in the environment the session is launched from, then mint again.`,
    );
  }
  if (keychain.platform !== "darwin") {
    return;
  }
  let found: ReturnType<typeof claudeCodeLoginFound>;
  try {
    found = claudeCodeLoginFound(keychain.run, configDir);
  } catch (error) {
    if (error instanceof KeychainLookupError) {
      throw new KeychainLookupError(`${error.message} Nothing was minted into identity "${identity}".`);
    }
    throw error;
  }
  if (found === undefined) {
    return;
  }
  throw new KeychainLoginError(
    `Cannot mint a self-hosted login into identity "${identity}": the Keychain holds a Claude Code login filed for the directory's service (${found.service}${found.account === undefined ? "" : `, account ${found.account}`}) of ${configDir}, and on macOS Claude Code reads a login filed there ahead of the minted file, so a session could sign in as that account instead. Nothing is changed and --force does not override this. Mint into an identity with no login, or, if that login is not needed, delete it with \`${keychainDeleteCommand(found.service, found.account)}\` and mint again.`,
  );
}

/**
 * The note `identity remove` gives for an identity the self-hosted mint wrote into (`selfHostedDir` is its directory, undefined for any other identity) whose Claude Code login item is still in the Keychain, or undefined when there is nothing to say. The removal leaves the item, as it leaves every identity's (a login another identity, or a later `identity add --keep-keychain-login`, may still want); this only names it and the command that deletes it, since a minted login is the one kind with nothing to keep. Asked by attributes only, and only on macOS. It is asked after the identity is gone, so a Keychain that could not be asked is a note too, saying the identity was removed and the check could not be made, never a failure of a removal that has already happened.
 */
export function selfHostedLoginLeftover(keychain: KeychainProbe, selfHostedDir: string | undefined): string | undefined {
  if (selfHostedDir === undefined || keychain.platform !== "darwin") {
    return undefined;
  }
  let found: ReturnType<typeof claudeCodeLoginFound>;
  try {
    found = claudeCodeLoginFound(keychain.run, selfHostedDir);
  } catch (error) {
    if (error instanceof KeychainLookupError) {
      return `The identity was removed, but the Keychain could not be checked for a Claude Code login a self-hosted mint may have left for its directory (service ${claudeCodeKeychainService(selfHostedDir)}): ${error.message}`;
    }
    throw error;
  }
  return found === undefined
    ? undefined
    : `The Keychain still holds a Claude Code login for this identity's directory (service ${found.service}), which a self-hosted mint may have left; delete it with \`${keychainDeleteCommand(found.service, found.account)}\` if it is not needed.`;
}

/** A leftover note as the list of warnings a removal reports: empty when there is none. */
export function leftoverWarnings(note: string | undefined): readonly string[] {
  return note === undefined ? [] : [note];
}

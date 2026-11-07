import { createHash } from "node:crypto";
import path from "node:path";

import type { FarmFs, RunPort } from "../launcher/ports";

/** The file Claude Code keeps an identity's login in where it has no Keychain, and falls back to when the Keychain is unavailable. */
const CREDENTIALS_FILE = ".credentials.json";

/** Whether an identity can authenticate as itself, as `decideSignIn` defines the three states. */
type SignInState = "signed-in" | "signed-out" | "token";

/** One identity's sign-in state and the evidence it rests on, as a sentence a report can print. */
export interface SignInAnswer {
  readonly state: SignInState;
  readonly detail: string;
}

/** What the probe needs from the machine: where logins live depends on the platform, and the Keychain is asked through the run port. */
export interface SignInProbe {
  readonly platform: string;
  /** Omit off macOS: the Keychain is only ever asked when `platform` is `darwin`. */
  readonly run?: RunPort;
}

/** The Keychain service name prefix Claude Code files a configuration directory's login under. */
const KEYCHAIN_SERVICE_PREFIX = "Claude Code-credentials";

/** How many hex digits of the directory path's SHA-256 Claude Code appends to the service name. */
const KEYCHAIN_SERVICE_HASH_DIGITS = 8;

/**
 * The Keychain service name Claude Code keeps the login of one configuration directory under: the prefix, then the first eight hex digits of the SHA-256 of the directory path as `CLAUDE_CONFIG_DIR` names it, normalised to Unicode NFC first (a macOS path is often spelled decomposed, and the hash of the raw bytes would name an item Claude Code never reads). The account on the item is the operating system user (`claudeCodeKeychainAccount`), so the directory is only recoverable through this name. Read from Claude Code's secure-storage module (2.1.319 normalises an overriding directory to NFC in the derivation itself; the configuration directory's own NFC normalisation was read in 2.1.309); not a documented contract.
 */
export function claudeCodeKeychainService(configDir: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, KEYCHAIN_SERVICE_HASH_DIGITS)}`;
}

/** The variable that overrides which directory Claude Code names its login item after, whatever `CLAUDE_CONFIG_DIR` says; set but empty, it names the bare prefix. */
const SECURE_STORAGE_CONFIG_DIR_ENV = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/**
 * The Keychain service a session in `configDir` reads its login from, under the environment `env` it inherits: `CLAUDE_SECURESTORAGE_CONFIG_DIR`, when set, names the directory instead (and, set but empty, the bare prefix with no hash), exactly as Claude Code 2.1.319's secure storage derives it; otherwise the directory's own service (`claudeCodeKeychainService`).
 */
export function claudeCodeLoginService(configDir: string, env: Readonly<Record<string, string | undefined>>): string {
  const override = env[SECURE_STORAGE_CONFIG_DIR_ENV];
  if (override === undefined) {
    return claudeCodeKeychainService(configDir);
  }
  return override === "" ? KEYCHAIN_SERVICE_PREFIX : claudeCodeKeychainService(override);
}

/** The account name Claude Code files its login under when `USER` and the operating system give it none it accepts. */
const FALLBACK_KEYCHAIN_ACCOUNT = "claude-code-user";

/** The characters Claude Code accepts in an account name; anything else falls back to `FALLBACK_KEYCHAIN_ACCOUNT`. */
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/u;

/**
 * The account Claude Code files its login item under, as its secure storage derives it (2.1.319): `USER`, else the operating system's name for the user; `claude-code-user` when looking the user up throws or the name has a character outside letters, digits, dot, underscore and hyphen.
 */
export function claudeCodeKeychainAccount(env: Readonly<Record<string, string | undefined>>, username: () => string): string {
  let name: string;
  try {
    const fromEnv = env.USER;
    name = fromEnv !== undefined && fromEnv !== "" ? fromEnv : username();
  } catch {
    return FALLBACK_KEYCHAIN_ACCOUNT;
  }
  return KEYCHAIN_ACCOUNT_PATTERN.test(name) ? name : FALLBACK_KEYCHAIN_ACCOUNT;
}

/** Whether the Keychain holds Claude Code's login item for the configuration directory `configDir`. Without `-g` or `-w`, `security` prints the item's attributes only, so the secret is never requested and the item's access list never prompts. */
export function keychainHasItem(run: RunPort, configDir: string): boolean {
  return run.run("security", ["find-generic-password", "-s", claudeCodeKeychainService(configDir)]).status === 0;
}

/** The facts a sign-in state is decided from, each gathered by the caller so the decision itself is pure. `keychainItem` is undefined where the Keychain is not asked (off macOS). */
export interface SignInFacts {
  readonly hasCredentialBlock: boolean;
  /** The provider the identity's `identity.json` says it exists for, when it names one. */
  readonly provider: string | undefined;
  readonly keychainItem: boolean | undefined;
  readonly credentialsFile: boolean;
  readonly platform: string;
}

/**
 * Whether an identity can authenticate as itself.
 *
 * - `signed-in`: a stored login exists (a Keychain item on macOS, or the credentials file).
 * - `signed-out`: no stored login exists. The identity's `.claude.json` profile survives a sign-out, so the account metadata can still be present.
 * - `token`: the identity supplies its own credential through a `credential` block, or exists for a `provider` whose credential its sessions run on, so its stored login is not what a launch authenticates with and its absence says nothing.
 */
export function decideSignIn(facts: Readonly<SignInFacts>): SignInAnswer {
  if (facts.hasCredentialBlock) {
    return { state: "token", detail: "supplies its own credential through a credential block, so a stored login is not what a launch uses" };
  }
  if (facts.provider !== undefined) {
    return { state: "token", detail: "runs provider sessions with the provider's credential, so a stored login is not what a launch uses" };
  }
  if (facts.keychainItem === true) {
    return { state: "signed-in", detail: "a login is stored in the macOS Keychain" };
  }
  if (facts.credentialsFile) {
    return { state: "signed-in", detail: `a login is stored in ${CREDENTIALS_FILE}` };
  }
  return { state: "signed-out", detail: facts.platform === "darwin" ? `no Keychain item and no ${CREDENTIALS_FILE}` : `no ${CREDENTIALS_FILE}` };
}

/** The path of an identity's credentials file, inside its own directory. */
export function credentialsFilePath(farmRoot: string): string {
  return path.join(farmRoot, CREDENTIALS_FILE);
}

/**
 * Reads whether an identity is signed in from where Claude Code keeps the login, without starting `claude` and without reading the token: the Keychain is asked for the item's existence only and the file is checked for presence, never opened.
 *
 * `farmRoot` is the identity's own directory (`identitiesDir/<id>`), whose path the Keychain item's service name is derived from (`claudeCodeKeychainService`) and in which a `.credentials.json` lives.
 */
export function identitySignIn(
  fs: Pick<FarmFs, "lstat">,
  probe: Readonly<SignInProbe>,
  identity: Readonly<{ readonly farmRoot: string; readonly hasCredentialBlock: boolean; readonly provider: string | undefined }>,
): SignInAnswer {
  // An identity with its own credential block or a provider is `token` whatever is stored, so nothing is asked of the Keychain or the file system for it.
  const probing = !identity.hasCredentialBlock && identity.provider === undefined;
  return decideSignIn({
    hasCredentialBlock: identity.hasCredentialBlock,
    provider: identity.provider,
    keychainItem: probing && probe.platform === "darwin" && probe.run !== undefined ? keychainHasItem(probe.run, identity.farmRoot) : undefined,
    credentialsFile: probing && fs.lstat(credentialsFilePath(identity.farmRoot)) !== undefined,
    platform: probe.platform,
  });
}

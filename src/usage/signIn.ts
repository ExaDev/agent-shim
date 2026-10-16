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
 * The Keychain service name Claude Code keeps the login of one configuration directory under: the prefix, then the first eight hex digits of the SHA-256 of the directory path exactly as `CLAUDE_CONFIG_DIR` names it. The account on the item is the operating system user, so the directory is only recoverable through this name. Observed on Claude Code 2.1, not a documented contract.
 */
export function claudeCodeKeychainService(configDir: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}-${createHash("sha256").update(configDir).digest("hex").slice(0, KEYCHAIN_SERVICE_HASH_DIGITS)}`;
}

/** Whether the Keychain holds Claude Code's login item for the configuration directory `configDir`. Without `-g` or `-w`, `security` prints the item's attributes only, so the secret is never requested and the item's access list never prompts. */
export function keychainHasItem(run: RunPort, configDir: string): boolean {
  return run.run("security", ["find-generic-password", "-s", claudeCodeKeychainService(configDir)]).status === 0;
}

/** The facts a sign-in state is decided from, each gathered by the caller so the decision itself is pure. `keychainItem` is undefined where the Keychain is not asked (off macOS). */
export interface SignInFacts {
  readonly hasCredentialBlock: boolean;
  readonly keychainItem: boolean | undefined;
  readonly credentialsFile: boolean;
  readonly platform: string;
}

/**
 * Whether an identity can authenticate as itself.
 *
 * - `signed-in`: a stored login exists (a Keychain item on macOS, or the credentials file).
 * - `signed-out`: no stored login exists. The identity's `.claude.json` profile survives a sign-out, so the account metadata can still be present.
 * - `token`: the identity supplies its own credential through a `credential` block, so its stored login is not what a launch authenticates with and its absence says nothing.
 */
export function decideSignIn(facts: Readonly<SignInFacts>): SignInAnswer {
  if (facts.hasCredentialBlock) {
    return { state: "token", detail: "supplies its own credential through a credential block, so a stored login is not what a launch uses" };
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
 * `farmRoot` is the identity's own directory (`identitiesDir/<name>`), which is both the Keychain account name and the directory a `.credentials.json` lives in.
 */
export function identitySignIn(
  fs: Pick<FarmFs, "lstat">,
  probe: Readonly<SignInProbe>,
  identity: Readonly<{ readonly farmRoot: string; readonly hasCredentialBlock: boolean }>,
): SignInAnswer {
  // An identity with its own credential block is `token` whatever is stored, so nothing is asked of the Keychain or the file system for it.
  const probing = !identity.hasCredentialBlock;
  return decideSignIn({
    hasCredentialBlock: identity.hasCredentialBlock,
    keychainItem: probing && probe.platform === "darwin" && probe.run !== undefined ? keychainHasItem(probe.run, identity.farmRoot) : undefined,
    credentialsFile: probing && fs.lstat(credentialsFilePath(identity.farmRoot)) !== undefined,
    platform: probe.platform,
  });
}

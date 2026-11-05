import path from "node:path";

import { CliError } from "../cliError";
import { isStoredName, STORED_NAME_RULE } from "../config/names";
import { IdentitySchema } from "../config/schema";
import type { FarmFs } from "../launcher/ports";
import { AccountMetadataSchema, type AccountMetadata } from "./schema";

/** The file Claude Code keeps an identity's profile in, inside the identity's configuration directory. */
const CLAUDE_JSON = ".claude.json";

/** Raised when an identity's `.claude.json` exists but cannot be read as account metadata (not a JSON object, or an `oauthAccount` field of an unexpected type): reported, never read as "no account". */
export class AccountMetadataError extends CliError {
  constructor(readonly file: string, detail: string) {
    super(`${file}: ${detail}, so its account metadata cannot be read.`);
    this.name = "AccountMetadataError";
  }
}

/** Whether a value is a plain JSON object, narrowed so its fields can be read with `in`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `name` is a valid identity name. */
export function isIdentityName(name: string): boolean {
  return IdentitySchema.shape.name.safeParse(name).success;
}

/** Whether `id` is a valid identity directory id under the identities and snapshots directories (a stored name that does not start with a dot, as `readIdentityRecords` reads). */
export function isIdentityId(id: string): boolean {
  return !id.startsWith(".") && isStoredName(id);
}

/** Raised for an identity directory id that cannot be one: it names the rule it breaks, which for an id is not the rule a name is held to. */
class InvalidIdentityIdError extends CliError {
  constructor(readonly attemptedId: string, rule: string) {
    super(`${JSON.stringify(attemptedId)} is not a valid identity id: an id ${rule}.`);
    this.name = "InvalidIdentityIdError";
  }
}

/** Throws `InvalidIdentityIdError` unless `id` is an identity directory id (`isIdentityId`), naming the rule it breaks: the stored-name rule, which keeps an id inside the directory it is looked up in, or, for a stored name that starts with a dot, the leading-dot rule, since the identities directory's reader skips such an entry. */
export function requireIdentityDirectoryId(id: string): void {
  if (!isStoredName(id)) {
    throw new InvalidIdentityIdError(id, STORED_NAME_RULE);
  }
  if (id.startsWith(".")) {
    throw new InvalidIdentityIdError(id, "must not start with a dot, which the identities directory's reader skips");
  }
}

/** The path of an identity's `.claude.json`. */
export function claudeJsonPath(identitiesDir: string, identity: string): string {
  return path.join(identitiesDir, identity, CLAUDE_JSON);
}

/**
 * Reads an identity's account metadata from the `oauthAccount` block Claude Code writes into the identity's `.claude.json` when it logs in: the fields `AccountMetadataSchema` names and nothing else (the token is never in this file; Claude Code keeps it in the Keychain or `.credentials.json`). Undefined when the identity has no `.claude.json` or no `oauthAccount` (a setup-token identity, or one never logged in). Throws `AccountMetadataError` for a file that is not a JSON object, and on an invalid identity id, which could otherwise name a path outside the identities directory.
 */
export function readAccountMetadata(fs: Pick<FarmFs, "readFileUtf8">, identitiesDir: string, identity: string): AccountMetadata | undefined {
  requireIdentityDirectoryId(identity);
  return readAccountMetadataFile(fs, claudeJsonPath(identitiesDir, identity));
}

/**
 * Reads the account metadata from a Claude Code profile file named by its path, for a session that has no agent-shim identity: `$CLAUDE_CONFIG_DIR/.claude.json` when the configuration directory is pinned, else `~/.claude.json`, where Claude Code keeps the default profile. Same contract as `readAccountMetadata`, whose file-level read this is.
 */
export function readAccountMetadataFile(fs: Pick<FarmFs, "readFileUtf8">, file: string): AccountMetadata | undefined {
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AccountMetadataError(file, "not valid JSON");
  }
  if (!isObject(parsed)) {
    throw new AccountMetadataError(file, "not a JSON object");
  }
  const oauthAccount = parsed.oauthAccount;
  if (!isObject(oauthAccount)) {
    return undefined;
  }
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(AccountMetadataSchema.shape)) {
    const value = oauthAccount[key];
    // Claude Code writes null for a field it fetched and found empty; absence is how the metadata models that.
    if (value !== null && value !== undefined) {
      picked[key] = value;
    }
  }
  const account = AccountMetadataSchema.safeParse(picked);
  if (!account.success) {
    throw new AccountMetadataError(file, account.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return account.data;
}

/**
 * An account reader for the long-running door: re-reads an identity's `.claude.json` only when its modification time or size has changed, since the door records every request and the file (which also holds Claude Code's per-project history) can be large while its account block rarely changes.
 */
export function createAccountReader(fs: Pick<FarmFs, "readFileUtf8" | "lstat">, identitiesDir: string): (identity: string) => AccountMetadata | undefined {
  const cache = new Map<string, { readonly stamp: string; readonly account: AccountMetadata | undefined }>();
  return (identity) => {
    requireIdentityDirectoryId(identity);
    const stat = fs.lstat(claudeJsonPath(identitiesDir, identity));
    const stamp = stat === undefined ? "absent" : `${String(stat.mtimeMs)}:${String(stat.sizeBytes)}`;
    const cached = cache.get(identity);
    if (cached?.stamp === stamp) {
      return cached.account;
    }
    const account = readAccountMetadata(fs, identitiesDir, identity);
    cache.set(identity, { stamp, account });
    return account;
  };
}

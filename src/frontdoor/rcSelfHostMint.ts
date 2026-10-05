import path from "node:path";

import { isIdentityName } from "../usage/account";
import type { FarmFs } from "../launcher/ports";
import type { RcSelfHostCredentialRecord } from "./rcSelfHost";
import { RC_SELF_HOST_SCOPE_LIST } from "./rcSelfHost";

/**
 * The minting half of the self-hosted Remote Control mode (ExaDev/agent-shim#207): the local credential that lets a Claude Code session activate Remote Control against the door's own served surface with no claude.ai login anywhere.
 *
 * What the CLI's activation gate reads, and therefore what the minting writes, is settled by the issue's source spike and restated here because every field answers a specific check: the credential file supplies the OAuth token whose `scopes` array must contain `user:inference` (the auth-mode check) and `user:profile` (the full-scope check), and whose expiry must never pass (a past `expiresAt` plus a failed refresh trips the dead-token backoff that silently disables the bridge for three runs, so the minting writes `null`, which the CLI's own expiry test reads as "not expired"); the account block in `.claude.json` supplies the `organizationUuid` the gate demands; and the pre-seeded feature cache answers the gate's one GrowthBook flag check with no network call at all (`cachedGrowthBookFeatures` is consulted before any remote eval, and the door serves that eval locally anyway for a cold cache).
 *
 * The two traps the spike named are structural here: the token pair lives in the identity's `.credentials.json` (never `CLAUDE_CODE_OAUTH_TOKEN`, which forces an inference-only scope set client-side whatever the token), and the credential's own copy for the door lives beside the door's state so the served surface can authenticate against it and answer refreshes with the same pair.
 *
 * Nothing minted is ever returned to a caller or logged: the result names the identity, the organisation and the files, never a token.
 */

/** The file Claude Code keeps its OAuth credential in on Linux and Windows, inside the configuration directory the farm makes of the identity. */
const CREDENTIALS_FILE = ".credentials.json";

/** The file Claude Code keeps its account block and feature cache in, inside the same directory. */
const CLAUDE_JSON = ".claude.json";

/** Where the door's own copy of the minted credential lives, under the door's state directory. */
export const RC_SELF_HOST_RECORD_DIR = "rc-selfhost";

/** The door's copy of the minted credential: the record `rcSelfHost.ts` reads fresh on every authenticated call. */
export const RC_SELF_HOST_RECORD_FILE = "credential.json";

/** The email address the minted account block names: a `.invalid` domain, so nothing about it can be mistaken for a reachable identity. */
const SELF_HOST_EMAIL = "selfhost@agent-shim.invalid";

/**
 * The subscription type the minted credential names. `max` is the value the CLI's own checks all accept (`claude_max` organisation type maps to it), and the local profile answer names that type right back, so the two never disagree.
 */
const SELF_HOST_SUBSCRIPTION_TYPE = "max";

/** Everything the minting needs, injected so it runs against an in-memory fake filesystem in unit tests. */
export interface RcSelfHostMintDeps {
  readonly fs: Pick<FarmFs, "readFileUtf8" | "writeFilePrivate" | "mkdirPrivate">;
  /** The agent-shim identities directory (the mint writes inside `<identitiesDir>/<identity>/`). */
  readonly identitiesDir: string;
  /** The door's state directory (the record is written under `<frontdoorDir>/rc-selfhost/`). */
  readonly frontdoorDir: string;
  readonly identity: string;
  /** Mints ids: a v4 UUID or better in production. */
  readonly newUuid: () => string;
  /** Mints token material: cryptographically random bytes in production. */
  readonly randomToken: () => string;
  /** Overwrite an existing credential that is not a previous mint of this door's. */
  readonly force: boolean;
  readonly now: () => number;
}

/** What the minting produced: names and shapes only, never a token. */
export interface RcSelfHostMintResult {
  readonly identity: string;
  readonly organizationUuid: string;
  readonly credentialsFile: string;
  readonly claudeJsonFile: string;
  readonly recordFile: string;
  /** Whether a previous mint of this door's was replaced. */
  readonly replaced: boolean;
}

/** The guard every parsed file narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads and parses one JSON object file, or undefined when it is absent or not one JSON object. */
function readJsonObject(fs: Pick<FarmFs, "readFileUtf8">, file: string): Record<string, unknown> | undefined {
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** Reads the door's previously minted record, or undefined when none exists (or what exists does not parse). */
export function readRcSelfHostRecord(fs: Pick<FarmFs, "readFileUtf8">, frontdoorDir: string): RcSelfHostCredentialRecord | undefined {
  const parsed = readJsonObject(fs, path.join(frontdoorDir, RC_SELF_HOST_RECORD_DIR, RC_SELF_HOST_RECORD_FILE));
  if (parsed === undefined) {
    return undefined;
  }
  const { accessToken, refreshToken, organizationUuid, accountUuid } = parsed;
  if (typeof accessToken !== "string" || accessToken === "" || typeof refreshToken !== "string" || refreshToken === "" || typeof organizationUuid !== "string" || organizationUuid === "" || typeof accountUuid !== "string" || accountUuid === "") {
    return undefined;
  }
  return { accessToken, refreshToken, organizationUuid, accountUuid };
}

/**
 * Mints the local credential for one identity and records the door's copy. Refuses, unless `force`, when the identity already holds an OAuth credential this door did not mint (a real claude.ai login): overwriting one silently would sign the identity out, and the mode's own contract is that no Anthropic credential is in play at all.
 */
export function mintRcSelfHostCredential(deps: RcSelfHostMintDeps): RcSelfHostMintResult {
  if (!isIdentityName(deps.identity)) {
    throw new Error(`"${deps.identity}" is not a valid identity name.`);
  }
  const identityDir = path.join(deps.identitiesDir, deps.identity);
  const credentialsFile = path.join(identityDir, CREDENTIALS_FILE);
  const claudeJsonFile = path.join(identityDir, CLAUDE_JSON);
  const recordDir = path.join(deps.frontdoorDir, RC_SELF_HOST_RECORD_DIR);
  const recordFile = path.join(recordDir, RC_SELF_HOST_RECORD_FILE);

  const previousRecord = readRcSelfHostRecord(deps.fs, deps.frontdoorDir);
  const existingCredentials = readJsonObject(deps.fs, credentialsFile);
  const existingOauth = isRecord(existingCredentials?.claudeAiOauth) ? existingCredentials.claudeAiOauth : undefined;
  const existingToken = typeof existingOauth?.accessToken === "string" && existingOauth.accessToken !== "" ? existingOauth.accessToken : undefined;
  const existingIsOwn = existingToken !== undefined && previousRecord?.accessToken === existingToken;
  if (existingToken !== undefined && !existingIsOwn && !deps.force) {
    throw new Error(
      `identity ${deps.identity} already holds an OAuth credential this door did not mint (a real claude.ai login): pass --force to replace it, or mint into an identity with no login. The self-hosted mode expects no Anthropic credential to be in play.`,
    );
  }

  // The access token carries the OAuth prefix the door's own tracker recognises (so the session's observed bearer becomes the client-half credential as usual) followed by random material: opaque to the CLI, which never decodes it.
  const accessToken = `sk-ant-oat${deps.randomToken()}`;
  const refreshToken = deps.randomToken();
  const organizationUuid = deps.newUuid();
  const accountUuid = deps.newUuid();
  const mintedAt = new Date(deps.now()).toISOString();

  deps.fs.mkdirPrivate(path.dirname(credentialsFile));
  deps.fs.writeFilePrivate(credentialsFile, `${JSON.stringify({ ...existingCredentials, claudeAiOauth: { accessToken, refreshToken, expiresAt: null, scopes: [...RC_SELF_HOST_SCOPE_LIST], subscriptionType: SELF_HOST_SUBSCRIPTION_TYPE, rateLimitTier: null } }, null, 2)}\n`);

  const claudeJson = readJsonObject(deps.fs, claudeJsonFile) ?? {};
  /** An existing block of the file, spread onto the minted fields: whatever shape it had, the mint preserves its entries and overrides the ones the activation path reads. */
  const existingBlock = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
  deps.fs.writeFilePrivate(claudeJsonFile, `${JSON.stringify({
    ...claudeJson,
    oauthAccount: {
      ...existingBlock(claudeJson.oauthAccount),
      accountUuid,
      emailAddress: SELF_HOST_EMAIL,
      organizationUuid,
      organizationName: "agent-shim self-hosted",
      // The billing and creation fields exist so the CLI's "populate the account block if it is missing" step finds a complete block and skips its profile fetch; the door answers that fetch locally anyway, so these are the quiet path, not a load-bearing claim.
      billingType: "stripe_subscription",
      accountCreatedAt: mintedAt,
      subscriptionCreatedAt: mintedAt,
    },
    cachedGrowthBookFeatures: {
      ...existingBlock(claudeJson.cachedGrowthBookFeatures),
      tengu_ccr_bridge: true,
      tengu_bridge_repl_v2: true,
      tengu_bridge_repl_v2_cse_shim_enabled: true,
    },
  }, null, 2)}\n`);

  deps.fs.mkdirPrivate(recordDir);
  deps.fs.writeFilePrivate(recordFile, `${JSON.stringify({ accessToken, refreshToken, organizationUuid, accountUuid }, null, 2)}\n`);

  return { identity: deps.identity, organizationUuid, credentialsFile, claudeJsonFile, recordFile, replaced: existingIsOwn };
}

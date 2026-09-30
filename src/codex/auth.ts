import { z } from "zod";

import type { UpstreamFetch } from "./upstreamPort";

/**
 * The Codex CLI's `~/.codex/auth.json`, read and written loosely: the CLI owns this file and may add fields at any time, so every field this store does not touch is written back exactly as it was read.
 */
const AuthFileSchema = z.looseObject({
  tokens: z
    .looseObject({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      id_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .nullish(),
  last_refresh: z.string().optional(),
});
type AuthFile = z.infer<typeof AuthFileSchema>;

/** The token endpoint's answer to a refresh grant. A rotated refresh token is optional: the endpoint returns one only when it rotates. */
const TokenGrantSchema = z.looseObject({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  account_id: z.string().min(1).optional(),
});

/** What an upstream request needs to authenticate. */
export interface CodexCredentials {
  readonly accessToken: string;
  /** Sent as `chatgpt-account-id`; the backend routes the request to this ChatGPT account's subscription. */
  readonly accountId: string | undefined;
}

/**
 * The filesystem operations the auth store needs, injected so every refresh ordering (and a crash between the steps) is testable against a fake. The atomic write is two separate calls on purpose: a real crash can land between them, and a test must be able to reproduce that.
 */
export interface CodexAuthFs {
  /** The file's contents, or undefined when it does not exist. */
  readonly read: (filePath: string) => string | undefined;
  /** Writes `contents` to `filePath` (a temporary sibling of the auth file) with mode 0600, replacing anything there. */
  readonly writePrivate: (filePath: string, contents: string) => void;
  /** Renames `from` over `to` in one atomic step. */
  readonly rename: (from: string, to: string) => void;
}

/** Everything the auth store depends on. */
export interface CodexAuthPorts {
  readonly fs: CodexAuthFs;
  readonly fetch: UpstreamFetch;
  readonly now: () => Date;
  /** A suffix unique to this process, so two processes refreshing at once never share a temporary file. */
  readonly tempSuffix: string;
}

/** Raised when the Codex login cannot produce a usable access token. Its message never contains a token. */
export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

/** The OAuth token endpoint the Codex CLI refreshes against. */
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** The Codex CLI's public OAuth client id: public by design, the same value every Codex CLI install sends. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** A hung refresh would hold the single in-flight refresh, and every request queued behind it, forever. */
export const CODEX_REFRESH_TIMEOUT_MS = 30_000;

/** How much of the token endpoint's error body is kept in the error message: enough for its error code and description, which carry no token. */
const REFRESH_ERROR_BODY_CHARS = 300;

/** The store's interface: the current credentials, and a refresh after the backend rejected them. */
export interface CodexAuthStore {
  /** The credentials to send, from memory or from the file. Throws `CodexAuthError` when there is no login. */
  readonly current: () => Promise<CodexCredentials>;
  /**
   * Replaces credentials the backend rejected. `rejected` is the access token that got the 401, so a refresh the Codex CLI (or a concurrent request) already performed is recognised and reused rather than repeated. Concurrent calls share one refresh.
   */
  readonly refresh: (rejected: string) => Promise<CodexCredentials>;
}

function credentialsOf(auth: AuthFile): CodexCredentials | undefined {
  const accessToken = auth.tokens?.access_token;
  return accessToken === undefined || accessToken === "" ? undefined : { accessToken, accountId: auth.tokens?.account_id };
}

/**
 * The auth store over `~/.codex/auth.json`. The Codex CLI writes the same file, so the store never trusts its own copy when it matters:
 *
 * - Before refreshing it re-reads the file. If the access token there differs from the one the backend rejected, someone (the CLI, or another request in this daemon) already refreshed, and that token is used without spending the refresh token again: refresh tokens rotate, so spending one twice logs both processes out.
 * - After the token endpoint answers it re-reads the file once more and merges the new tokens into that fresh copy, so fields the CLI changed meanwhile survive.
 * - The merged file is written to a private temporary sibling and renamed over the original, so a crash at any point leaves either the old file or the new one, never a torn one. The rotated refresh token is on disk before the new access token is handed to any request: if the daemon dies right after, the CLI and the next daemon still hold the only refresh token that works.
 * - When the endpoint refuses the refresh, the file is read one last time: a CLI refresh racing this one may have won, and its tokens are good.
 *
 * Only one refresh runs at a time; concurrent 401s wait for it. No token value ever reaches an error message or log line.
 */
export function createCodexAuthStore(authPath: string, ports: CodexAuthPorts): CodexAuthStore {
  let cached: CodexCredentials | undefined;
  let inFlight: Promise<CodexCredentials> | undefined;

  const readFile = (): AuthFile => {
    const raw = ports.fs.read(authPath);
    if (raw === undefined) {
      throw new CodexAuthError(`no Codex login at ${authPath}: run \`codex login\` first`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CodexAuthError(`${authPath} is not valid JSON: run \`codex login\` again`);
    }
    const parsed = AuthFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new CodexAuthError(`${authPath} is not a Codex login file: run \`codex login\` again`);
    }
    return parsed.data;
  };

  const writeFile = (auth: AuthFile): void => {
    const temp = `${authPath}.${ports.tempSuffix}.tmp`;
    ports.fs.writePrivate(temp, `${JSON.stringify(auth, null, 2)}\n`);
    ports.fs.rename(temp, authPath);
  };

  const doRefresh = async (rejected: string): Promise<CodexCredentials> => {
    const before = readFile();
    const already = credentialsOf(before);
    if (already !== undefined && already.accessToken !== rejected) {
      cached = already;
      return already;
    }
    const refreshToken = before.tokens?.refresh_token;
    if (refreshToken === undefined || refreshToken === "") {
      throw new CodexAuthError(`no refresh token in ${authPath}: run \`codex login\` first`);
    }
    const response = await ports.fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }).toString(),
      signal: AbortSignal.timeout(CODEX_REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, REFRESH_ERROR_BODY_CHARS);
      const raced = credentialsOf(readFile());
      if (raced !== undefined && raced.accessToken !== rejected) {
        cached = raced;
        return raced;
      }
      throw new CodexAuthError(`the Codex token refresh failed with HTTP ${String(response.status)}: ${detail}`);
    }
    const grant = TokenGrantSchema.safeParse(await response.json());
    if (!grant.success || grant.data.access_token === undefined) {
      throw new CodexAuthError("the Codex token endpoint answered without an access token");
    }
    const latest = readFile();
    const merged: AuthFile = {
      ...latest,
      tokens: {
        ...latest.tokens,
        access_token: grant.data.access_token,
        ...(grant.data.refresh_token === undefined ? {} : { refresh_token: grant.data.refresh_token }),
        ...(grant.data.id_token === undefined ? {} : { id_token: grant.data.id_token }),
        ...(grant.data.account_id === undefined ? {} : { account_id: grant.data.account_id }),
      },
      last_refresh: ports.now().toISOString(),
    };
    writeFile(merged);
    const credentials: CodexCredentials = { accessToken: grant.data.access_token, accountId: merged.tokens?.account_id };
    cached = credentials;
    return credentials;
  };

  return {
    current: async () => {
      if (cached !== undefined) {
        return cached;
      }
      const fromFile = credentialsOf(readFile());
      if (fromFile !== undefined) {
        cached = fromFile;
        return fromFile;
      }
      // A login with a refresh token but no access token yet: refreshing against an empty rejected token always spends the refresh token.
      return await (inFlight ??= doRefresh("").finally(() => {
        inFlight = undefined;
      }));
    },
    refresh: async (rejected) =>
      await (inFlight ??= doRefresh(rejected).finally(() => {
        inFlight = undefined;
      })),
  };
}

import { z } from "zod";

import type { CodexAuthFs, CodexAuthStore, CodexCredentials } from "./auth";
import { CodexAuthError } from "./auth";
import { refreshTokens, SIWC_PLAN_SCOPE, SiwcError, type GrantTokens, type SiwcPorts } from "./siwc";

/** One signed-in grant, kept per installation: the client id OpenAI issued, who it signed in, and the tokens. */
const SiwcGrantSchema = z.strictObject({
  clientId: z.string().min(1),
  sub: z.string().min(1),
  email: z.string().optional(),
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()).readonly(),
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt: z.number(),
});
export type SiwcGrant = z.infer<typeof SiwcGrantSchema>;

/**
 * The file a Sign in with ChatGPT login lives in. `hostId` is the identifier OpenAI keys this installation's registration on; it is written before the first sign-in and survives a sign-out, since OpenAI's reference keeps the registration through logout. `grant` is absent until a sign-in completes.
 */
const SiwcFileSchema = z.strictObject({ hostId: z.string().min(1), grant: SiwcGrantSchema.optional() });
export type SiwcFile = z.infer<typeof SiwcFileSchema>;

/** How long before its expiry an access token is replaced, so a request that is already on its way never straddles the expiry. */
export const SIWC_REFRESH_MARGIN_MS = 60_000;

/** Everything the store depends on. */
export interface SiwcStorePorts {
  readonly fs: CodexAuthFs;
  readonly siwc: SiwcPorts;
  /** A suffix unique to this process, so two processes writing at once never share a temporary file. */
  readonly tempSuffix: string;
}

/** The sign-in file, with the operations the sign-in command and the translation's upstream need. */
export interface SiwcStore {
  /** The file's contents, or undefined when no sign-in has started. Raises when the file exists but is not a sign-in file. */
  readonly read: () => SiwcFile | undefined;
  /** Writes the whole file atomically with mode 0600: a crash leaves the old file or the new one, never a torn one. */
  readonly write: (file: SiwcFile) => void;
  /** The credentials the translation sends, replaced ahead of their expiry and after the backend rejects them. */
  readonly auth: CodexAuthStore;
}

/** Parses a sign-in file's contents. Raises `CodexAuthError`, naming the login command, when they are not a sign-in file. */
export function parseSiwcFile(raw: string, filePath: string): SiwcFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CodexAuthError(`${filePath} is not valid JSON: run \`agent-shim codex login\` again`);
  }
  const parsed = SiwcFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new CodexAuthError(`${filePath} is not a Sign in with ChatGPT file: run \`agent-shim codex login\` again`);
  }
  return parsed.data;
}

function grantFrom(previous: SiwcGrant, tokens: GrantTokens): SiwcGrant {
  return {
    ...previous,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? previous.refreshToken,
    idToken: tokens.idToken ?? previous.idToken,
    scopes: tokens.scopes ?? previous.scopes,
    expiresAt: tokens.expiresAt,
  };
}

/**
 * The store over one sign-in file. Credentials are served from memory until `SIWC_REFRESH_MARGIN_MS` before their expiry, then replaced through the refresh grant. OpenAI rotates the refresh token on every refresh, so the replacement is written to disk before the new access token is used, and only one refresh runs at a time. A grant that lacks the plan scope signs the person in but cannot send a request, and is refused here with the way to fix it. No token reaches an error message.
 */
export function createSiwcStore(filePath: string, ports: SiwcStorePorts): SiwcStore {
  let cached: SiwcGrant | undefined;
  let inFlight: Promise<CodexCredentials> | undefined;

  const read = (): SiwcFile | undefined => {
    const raw = ports.fs.read(filePath);
    return raw === undefined ? undefined : parseSiwcFile(raw, filePath);
  };

  const write = (file: SiwcFile): void => {
    const temp = `${filePath}.${ports.tempSuffix}.tmp`;
    ports.fs.writePrivate(temp, `${JSON.stringify(file, null, 2)}\n`);
    ports.fs.rename(temp, filePath);
    cached = file.grant;
  };

  const loadSignedIn = (): { readonly hostId: string; readonly grant: SiwcGrant } => {
    const file = read();
    if (file?.grant === undefined) {
      throw new CodexAuthError(`no Sign in with ChatGPT login at ${filePath}: run \`agent-shim codex login\` first`);
    }
    if (!file.grant.scopes.includes(SIWC_PLAN_SCOPE)) {
      throw new CodexAuthError(`the Sign in with ChatGPT login at ${filePath} was not granted permission to use your ChatGPT plan: run \`agent-shim codex login\` again and allow it`);
    }
    return { hostId: file.hostId, grant: file.grant };
  };

  const credentialsOf = (grant: SiwcGrant): CodexCredentials => ({ accessToken: grant.accessToken, accountId: undefined });

  const doRefresh = async (rejected: string | undefined): Promise<CodexCredentials> => {
    const { hostId, grant } = loadSignedIn();
    // Another process (a sign-in command, a second door) may already have replaced the rejected token.
    if (rejected !== undefined && grant.accessToken !== rejected) {
      cached = grant;
      return credentialsOf(grant);
    }
    let tokens: GrantTokens;
    try {
      tokens = await refreshTokens(ports.siwc, { clientId: grant.clientId, refreshToken: grant.refreshToken });
    } catch (error) {
      if (error instanceof SiwcError) {
        throw new CodexAuthError(`${error.message}: run \`agent-shim codex login\` again if the login was revoked`);
      }
      throw error;
    }
    const next = grantFrom(grant, tokens);
    write({ hostId, grant: next });
    return credentialsOf(next);
  };

  const refreshOnce = async (rejected: string | undefined): Promise<CodexCredentials> =>
    await (inFlight ??= doRefresh(rejected).finally(() => {
      inFlight = undefined;
    }));

  return {
    read,
    write,
    auth: {
      current: async () => {
        const grant = cached ?? loadSignedIn().grant;
        cached = grant;
        if (grant.expiresAt - SIWC_REFRESH_MARGIN_MS <= ports.siwc.now().getTime()) {
          return await refreshOnce(undefined);
        }
        return credentialsOf(grant);
      },
      refresh: async (rejected) => await refreshOnce(rejected),
    },
  };
}

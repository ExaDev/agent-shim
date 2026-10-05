import {
  buildAuthorizeUrl,
  exchangeCode,
  newHostId,
  newOpaqueValue,
  newPkce,
  parseCallback,
  SIWC_CALLBACK_PATH,
  SIWC_CALLBACK_PORT,
  SIWC_PLAN_SCOPE,
  SIWC_REVOKE_URL,
  SiwcError,
  verifyIdToken,
  type SiwcPorts,
} from "./siwc";
import type { SiwcStore } from "./siwcStore";

/** The name OpenAI shows the person on the consent screen, so they can tell which application is asking for their plan. */
export const SIWC_AGENT_NAME = "agent-shim";

/** A loopback listener waiting for the browser's redirect. */
export interface CallbackListener {
  /** Resolves with the redirect's URL, or rejects when `signal` aborts first. */
  readonly waitForCallback: (signal: AbortSignal) => Promise<URL>;
  readonly close: () => void;
}

/** Everything the sign-in flow touches outside this process, injected so the whole flow runs under test without a browser or a socket. */
export interface SiwcLoginPorts {
  readonly store: SiwcStore;
  readonly siwc: SiwcPorts;
  readonly randomUuid: () => string;
  /** Starts listening for the redirect on a loopback port. Raises when the port is taken. */
  readonly listen: (port: number) => Promise<CallbackListener>;
  /** Opens the system browser at `url`. */
  readonly openBrowser: (url: string) => void;
  readonly print: (line: string) => void;
}

/** How a sign-in went. */
export interface SiwcLoginResult {
  readonly email: string | undefined;
  readonly sub: string;
}

/** How long a sign-in waits for the person to finish in the browser. */
export const SIWC_LOGIN_TIMEOUT_MS = 300_000;

/**
 * Signs the person in through their browser and stores the grant. The host id is created and written before the browser opens, so a sign-in that is abandoned still leaves the registration identity the next attempt reuses. A returning sign-in names the client OpenAI already issued and hints the previous account; a first one registers dynamically and takes the issued client id from the callback.
 *
 * The grant is refused unless it carries the plan scope, because a grant without it signs the person in but can never send a request, and storing it would only move the failure to the first request.
 */
export async function runSiwcLogin(ports: SiwcLoginPorts, options: { readonly open: boolean }): Promise<SiwcLoginResult> {
  const existing = ports.store.read();
  const hostId = existing?.hostId ?? newHostId(ports.randomUuid);
  if (existing === undefined) {
    ports.store.write({ hostId });
  }
  const previous = existing?.grant;
  const pkce = newPkce(ports.siwc.randomBytes);
  const state = newOpaqueValue(ports.siwc.randomBytes);
  const nonce = newOpaqueValue(ports.siwc.randomBytes);
  const redirectUri = `http://127.0.0.1:${String(SIWC_CALLBACK_PORT)}${SIWC_CALLBACK_PATH}`;
  const url = buildAuthorizeUrl({
    clientId: previous?.clientId,
    agentName: SIWC_AGENT_NAME,
    hostId,
    redirectUri,
    state,
    nonce,
    challenge: pkce.challenge,
    ...(previous === undefined ? {} : { returning: { idToken: previous.idToken, loginHint: previous.email } }),
  });
  const listener = await ports.listen(SIWC_CALLBACK_PORT);
  try {
    ports.print(`Sign in at: ${url}`);
    if (options.open) {
      ports.openBrowser(url);
    }
    const callback = parseCallback(await listener.waitForCallback(AbortSignal.timeout(SIWC_LOGIN_TIMEOUT_MS)), state);
    const clientId = callback.clientId ?? previous?.clientId;
    if (clientId === undefined) {
      throw new SiwcError("the sign-in callback carried no client id and none was stored from an earlier sign-in");
    }
    const tokens = await exchangeCode(ports.siwc, { clientId, code: callback.code, verifier: pkce.verifier, redirectUri });
    if (tokens.refreshToken === undefined || tokens.idToken === undefined) {
      throw new SiwcError("the token endpoint did not return a refresh token and an ID token, so the sign-in cannot be kept");
    }
    const scopes = tokens.scopes ?? callback.scopes;
    if (!scopes.includes(SIWC_PLAN_SCOPE)) {
      throw new SiwcError("the sign-in was not granted permission to use your ChatGPT plan: run the login again and allow it");
    }
    const identity = await verifyIdToken(ports.siwc, tokens.idToken, { clientId, nonce });
    ports.store.write({
      hostId,
      grant: { clientId, sub: identity.sub, ...(identity.email === undefined ? {} : { email: identity.email }), idToken: tokens.idToken, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scopes, expiresAt: tokens.expiresAt },
    });
    return { email: identity.email, sub: identity.sub };
  } finally {
    listener.close();
  }
}

/** How a sign-out went: whether OpenAI was told, so the person knows the grant is dead on its side too. */
export interface SiwcLogoutResult {
  readonly hadGrant: boolean;
  /** True when the refresh token was revoked at the issuer; false when the revocation call failed (the local grant is removed either way). */
  readonly revoked: boolean;
}

/** Revocation call bound, so a hung issuer cannot hold the sign-out. */
const REVOKE_TIMEOUT_MS = 30_000;

/**
 * Signs out: revokes the refresh token at the issuer (RFC 7009) and removes the grant, keeping the host id so a later sign-in reuses the registration. The local removal happens even when the revocation call fails, because leaving a grant the person asked to remove would be worse than an unrevoked one, and the result says which happened.
 */
export async function runSiwcLogout(ports: Pick<SiwcLoginPorts, "store" | "siwc">): Promise<SiwcLogoutResult> {
  const file = ports.store.read();
  if (file?.grant === undefined) {
    return { hadGrant: false, revoked: false };
  }
  const revoked = await ports.siwc
    .fetch(SIWC_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: file.grant.refreshToken, token_type_hint: "refresh_token", client_id: file.grant.clientId }).toString(),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    })
    .then(
      (response) => response.ok,
      () => false,
    );
  ports.store.write({ hostId: file.hostId });
  return { hadGrant: true, revoked };
}

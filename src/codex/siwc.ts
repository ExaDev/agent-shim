import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod";

import type { UpstreamFetch } from "./upstreamPort";

/**
 * Sign in with ChatGPT for a local application, per OpenAI's open-source integration reference (https://developers.openai.com/siwc/token-sharing-open-source/sign-in). The person signs in through their browser, the application receives an OAuth grant it can spend against their ChatGPT plan on the public Responses API, and it needs no client secret and no API key.
 */

/** The authorization endpoint named by OpenAI's discovery document at `https://auth.openai.com/.well-known/openid-configuration`. */
const SIWC_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";

/** The token endpoint, used for both the code exchange and the refresh grant. */
export const SIWC_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";

/** The revocation endpoint (RFC 7009) named by the discovery document, called on sign-out. */
export const SIWC_REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";

/** The issuer, which an ID token's `iss` claim must equal. */
export const SIWC_ISSUER = "https://auth.openai.com";

/** The key set an ID token's signature is verified against. */
export const SIWC_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";

/** The client id a first sign-in sends so OpenAI issues this installation its own client id, which the callback hands back. */
export const SIWC_DYNAMIC_CLIENT_ID = "dynamic_agent_client";

/** The API the grant's access token is audience-bound to, and the `resource` parameter every request to the token endpoint names. */
export const SIWC_RESOURCE = "https://api.openai.com/v1";

/** The public Responses API endpoint the grant's access token is spent against. */
export const SIWC_RESPONSES_URL = `${SIWC_RESOURCE}/responses`;

/** The scopes a plan-backed grant needs: identity, a refresh token, and the two that let the token invoke the Responses API against the person's plan. */
const SIWC_SCOPES: readonly string[] = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];

/** The scope that makes a grant spendable on the person's plan; a grant without it signs the person in but cannot send a request. */
export const SIWC_PLAN_SCOPE = "chatgpt.tokens.use.direct";

/** The loopback port OpenAI's reference registers the callback on for a first sign-in. */
export const SIWC_CALLBACK_PORT = 1455;

/** The callback path of the loopback redirect. */
export const SIWC_CALLBACK_PATH = "/auth/callback";

/** How many random bytes back each of the PKCE verifier, the state and the nonce: 32 bytes is the RFC 7636 recommended verifier entropy. */
export const SIWC_RANDOM_BYTES = 32;

/** Milliseconds in a second, to turn the token endpoint's `expires_in` and an ID token's `exp` into epoch milliseconds. */
const MS_PER_SECOND = 1000;

/** The signing algorithm OpenAI's ID tokens use, the only one this verifier accepts. */
const ID_TOKEN_ALGORITHM = "RS256";

/** Raised for every failure of the sign-in flow; its message never contains a token or an authorization code. */
export class SiwcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiwcError";
  }
}

/** The primitives the flow draws on, injected so every step is deterministic under test. */
export interface SiwcPorts {
  readonly fetch: UpstreamFetch;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly now: () => Date;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The PKCE pair for one authorization request: the verifier is kept secret, and only its S256 challenge goes in the URL. */
export function newPkce(randomBytes: SiwcPorts["randomBytes"]): { readonly verifier: string; readonly challenge: string } {
  const verifier = base64Url(randomBytes(SIWC_RANDOM_BYTES));
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A random, URL-safe value for `state` or `nonce`. */
export function newOpaqueValue(randomBytes: SiwcPorts["randomBytes"]): string {
  return base64Url(randomBytes(SIWC_RANDOM_BYTES));
}

/** A fresh host id: the stable, opaque identifier OpenAI keys this installation's registration on, in the `urn:uuid:` form its reference allows. */
export function newHostId(randomUuid: () => string): string {
  return `urn:uuid:${randomUuid()}`;
}

/** What one authorization request carries. `clientId` is undefined for a first sign-in, which registers dynamically. */
export interface AuthorizeRequest {
  readonly clientId: string | undefined;
  readonly agentName: string;
  readonly hostId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly challenge: string;
  /** A previous ID token and the account's email, which let OpenAI pre-select the account on a returning sign-in. */
  readonly returning?: { readonly idToken: string; readonly loginHint: string | undefined };
}

/** The URL to open in the person's browser. */
export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(SIWC_AUTHORIZE_URL);
  const params = url.searchParams;
  params.set("client_id", request.clientId ?? SIWC_DYNAMIC_CLIENT_ID);
  if (request.clientId === undefined) {
    params.set("agent_name_hint", request.agentName);
  }
  params.set("ext_agent_host_id", request.hostId);
  if (request.returning !== undefined) {
    params.set("id_token_hint", request.returning.idToken);
    if (request.returning.loginHint !== undefined) {
      params.set("login_hint", request.returning.loginHint);
    }
  }
  params.set("response_type", "code");
  params.set("redirect_uri", request.redirectUri);
  params.set("scope", SIWC_SCOPES.join(" "));
  params.set("resource", SIWC_RESOURCE);
  params.set("state", request.state);
  params.set("nonce", request.nonce);
  params.set("code_challenge_method", "S256");
  params.set("code_challenge", request.challenge);
  return url.toString();
}

/** What the loopback callback carries on success. */
export interface CallbackResult {
  readonly code: string;
  /** The client id OpenAI issued, present on a first sign-in's callback. */
  readonly clientId: string | undefined;
  readonly scopes: readonly string[];
}

/** Reads the loopback callback. A refused or tampered request raises with the provider's own error code, never the authorization code. */
export function parseCallback(url: URL, expectedState: string): CallbackResult {
  const params = url.searchParams;
  const error = params.get("error");
  if (error !== null) {
    throw new SiwcError(`the sign-in was refused: ${error}${params.has("error_description") ? ` (${params.get("error_description") ?? ""})` : ""}`);
  }
  if (params.get("state") !== expectedState) {
    throw new SiwcError("the sign-in callback's state did not match the request, so it was discarded");
  }
  const code = params.get("code");
  if (code === null || code === "") {
    throw new SiwcError("the sign-in callback carried no authorization code");
  }
  const scope = params.get("scope");
  return { code, clientId: params.get("client_id") ?? undefined, scopes: scope === null ? [] : scope.split(" ").filter((part) => part !== "") };
}

/** The token endpoint's answer to a code exchange or a refresh grant. */
const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

/** How much of the token endpoint's error body is kept in a message: its error code and description, which carry no token. */
const ERROR_BODY_CHARS = 300;

/** The bound on one token-endpoint call, so a hung connection cannot hold a sign-in or a refresh forever. */
const TOKEN_CALL_TIMEOUT_MS = 30_000;

async function postToken(ports: SiwcPorts, form: Readonly<Record<string, string>>, what: string): Promise<z.infer<typeof TokenResponseSchema>> {
  const response = await ports.fetch(SIWC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, resource: SIWC_RESOURCE }).toString(),
    signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SiwcError(`the ${what} failed with HTTP ${String(response.status)}: ${(await response.text()).slice(0, ERROR_BODY_CHARS)}`);
  }
  const parsed = TokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new SiwcError(`the ${what} answered without an access token and a lifetime`);
  }
  return parsed.data;
}

/** The tokens one grant holds, with the instant its access token stops working. */
export interface GrantTokens {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly idToken: string | undefined;
  readonly scopes: readonly string[] | undefined;
  readonly expiresAt: number;
}

function grantTokens(ports: SiwcPorts, answer: z.infer<typeof TokenResponseSchema>): GrantTokens {
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token,
    idToken: answer.id_token,
    scopes: answer.scope === undefined ? undefined : answer.scope.split(" ").filter((part) => part !== ""),
    expiresAt: ports.now().getTime() + answer.expires_in * MS_PER_SECOND,
  };
}

/** Exchanges the callback's authorization code for tokens. */
export async function exchangeCode(ports: SiwcPorts, request: { readonly clientId: string; readonly code: string; readonly verifier: string; readonly redirectUri: string }): Promise<GrantTokens> {
  return grantTokens(
    ports,
    await postToken(ports, { grant_type: "authorization_code", client_id: request.clientId, code: request.code, code_verifier: request.verifier, redirect_uri: request.redirectUri }, "authorisation code exchange"),
  );
}

/** Spends a refresh token. OpenAI rotates it: the answer carries the replacement, valid from now on. */
export async function refreshTokens(ports: SiwcPorts, request: { readonly clientId: string; readonly refreshToken: string }): Promise<GrantTokens> {
  return grantTokens(ports, await postToken(ports, { grant_type: "refresh_token", client_id: request.clientId, refresh_token: request.refreshToken }, "token refresh"));
}

const JwtHeaderSchema = z.looseObject({ alg: z.string(), kid: z.string().optional() });
const IdTokenClaimsSchema = z.looseObject({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
});
const JwksSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })) });

function decodeSegment(segment: string | undefined): unknown {
  if (segment === undefined) {
    throw new SiwcError("the ID token is not a three-part JWT");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return parsed;
  } catch {
    throw new SiwcError("the ID token has an unreadable segment");
  }
}

/** The facts of a verified ID token this tool keeps. */
export interface VerifiedIdentity {
  readonly sub: string;
  readonly email: string | undefined;
}

/**
 * Verifies an ID token the way OpenAI's reference requires before a profile is saved: the RS256 signature against the issuer's key set, then the issuer, the audience (this installation's client id), the expiry and, when one was sent, the nonce.
 */
export async function verifyIdToken(ports: SiwcPorts, idToken: string, expected: { readonly clientId: string; readonly nonce: string | undefined }): Promise<VerifiedIdentity> {
  const [headerSegment, payloadSegment, signatureSegment, ...rest] = idToken.split(".");
  if (rest.length > 0 || headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) {
    throw new SiwcError("the ID token is not a three-part JWT");
  }
  const header = JwtHeaderSchema.parse(decodeSegment(headerSegment));
  if (header.alg !== ID_TOKEN_ALGORITHM) {
    throw new SiwcError(`the ID token is signed with ${header.alg}, and only ${ID_TOKEN_ALGORITHM} is accepted`);
  }
  const response = await ports.fetch(SIWC_JWKS_URL, { method: "GET", headers: {}, signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MS) });
  if (!response.ok) {
    throw new SiwcError(`the issuer's key set could not be fetched (HTTP ${String(response.status)})`);
  }
  const jwk = JwksSchema.parse(await response.json()).keys.find((key) => key.kty === "RSA" && (header.kid === undefined || key.kid === header.kid));
  if (jwk === undefined) {
    throw new SiwcError("the issuer's key set has no key for the ID token's signature");
  }
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
  if (!verify("sha256", signed, createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signatureSegment, "base64url"))) {
    throw new SiwcError("the ID token's signature did not verify");
  }
  const claims = IdTokenClaimsSchema.parse(decodeSegment(payloadSegment));
  if (claims.iss !== SIWC_ISSUER) {
    throw new SiwcError(`the ID token was issued by ${claims.iss}, not ${SIWC_ISSUER}`);
  }
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(expected.clientId)) {
    throw new SiwcError("the ID token was issued for a different client");
  }
  if (claims.exp * MS_PER_SECOND <= ports.now().getTime()) {
    throw new SiwcError("the ID token has already expired");
  }
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) {
    throw new SiwcError("the ID token's nonce did not match the request");
  }
  return { sub: claims.sub, email: claims.email };
}

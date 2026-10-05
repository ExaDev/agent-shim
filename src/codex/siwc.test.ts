import { createHash, createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "./http";
import {
  buildAuthorizeUrl,
  exchangeCode,
  newHostId,
  newPkce,
  parseCallback,
  refreshTokens,
  SIWC_DYNAMIC_CLIENT_ID,
  SIWC_ISSUER,
  SIWC_JWKS_URL,
  SIWC_RANDOM_BYTES,
  SIWC_RESOURCE,
  SIWC_TOKEN_URL,
  SiwcError,
  verifyIdToken,
  type SiwcPorts,
} from "./siwc";
import { fakeResponse, recordingFetch, type RecordedCall } from "./testing";
import type { UpstreamResponse } from "./upstreamPort";

/** Made-up values of no real format: nothing here is, or looks like, a real credential. */
const NOW = new Date("2026-10-05T12:00:00.000Z");
const CLIENT_ID = "fake-issued-client";
const HOST_ID = "urn:uuid:00000000-0000-4000-8000-000000000000";
const REDIRECT = "http://127.0.0.1:1455/auth/callback";
const ACCESS_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const ONE_HOUR_MS = ACCESS_LIFETIME_SECONDS * MS_PER_SECOND;
/** Any non-zero byte: the random source only has to be deterministic here. */
const FILL_BYTE = 5;

function ports(fetch: SiwcPorts["fetch"]): SiwcPorts {
  return { fetch, randomBytes: (size) => new Uint8Array(size).fill(1), now: () => NOW };
}

function formOf(call: RecordedCall): URLSearchParams {
  return new URLSearchParams(call.init.body ?? "");
}

describe("PKCE and identifiers", () => {
  it("derives the challenge as the S256 hash of the verifier", () => {
    const pkce = newPkce((size) => new Uint8Array(size).fill(FILL_BYTE));
    expect(Buffer.from(pkce.verifier, "base64url")).toHaveLength(SIWC_RANDOM_BYTES);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
  });

  it("forms a host id in the urn:uuid shape", () => {
    expect(newHostId(() => "abc")).toBe("urn:uuid:abc");
  });
});

describe("buildAuthorizeUrl", () => {
  const base = { agentName: "agent-shim", hostId: HOST_ID, redirectUri: REDIRECT, state: "s", nonce: "n", challenge: "c" };

  it("registers dynamically on a first sign-in", () => {
    const params = new URL(buildAuthorizeUrl({ ...base, clientId: undefined })).searchParams;
    expect(params.get("client_id")).toBe(SIWC_DYNAMIC_CLIENT_ID);
    expect(params.get("agent_name_hint")).toBe("agent-shim");
    expect(params.get("ext_agent_host_id")).toBe(HOST_ID);
    expect(params.get("resource")).toBe(SIWC_RESOURCE);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")?.split(" ")).toContain("chatgpt.tokens.use.direct");
    expect(params.has("id_token_hint")).toBe(false);
  });

  it("names the issued client and hints the account on a returning sign-in", () => {
    const params = new URL(buildAuthorizeUrl({ ...base, clientId: CLIENT_ID, returning: { idToken: "fake-id-token", loginHint: "person@example.com" } })).searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.has("agent_name_hint")).toBe(false);
    expect(params.get("id_token_hint")).toBe("fake-id-token");
    expect(params.get("login_hint")).toBe("person@example.com");
  });
});

describe("parseCallback", () => {
  const callback = (query: string): URL => new URL(`http://127.0.0.1:1455/auth/callback?${query}`);

  it("returns the code, the issued client id and the granted scopes", () => {
    expect(parseCallback(callback(`code=abc&state=s&client_id=${CLIENT_ID}&scope=openid+offline_access`), "s")).toEqual({ code: "abc", clientId: CLIENT_ID, scopes: ["openid", "offline_access"] });
  });

  it("refuses a callback whose state differs, without echoing the code", () => {
    expect(() => parseCallback(callback("code=secret-code&state=other"), "s")).toThrow(/state did not match/);
    expect(() => parseCallback(callback("code=secret-code&state=other"), "s")).not.toThrow(/secret-code/);
  });

  it("surfaces a refused sign-in with the provider's error", () => {
    expect(() => parseCallback(callback("error=access_denied&error_description=no&state=s"), "s")).toThrow(/access_denied/);
  });

  it("refuses a callback with no code", () => {
    expect(() => parseCallback(callback("state=s"), "s")).toThrow(/no authorization code/);
  });
});

const TOKEN_ANSWER = { access_token: "fake-access", refresh_token: "fake-refresh", id_token: "fake-id", expires_in: ACCESS_LIFETIME_SECONDS, scope: "openid chatgpt.tokens.use.direct" };

describe("exchangeCode and refreshTokens", () => {
  it("posts the code with its verifier and the resource, and stamps the expiry from now", async () => {
    const { fetch, calls } = recordingFetch(() => fakeResponse({ text: JSON.stringify(TOKEN_ANSWER) }));
    const tokens = await exchangeCode(ports(fetch), { clientId: CLIENT_ID, code: "the-code", verifier: "the-verifier", redirectUri: REDIRECT });
    expect(calls[0]?.url).toBe(SIWC_TOKEN_URL);
    const form = calls[0] === undefined ? new URLSearchParams() : formOf(calls[0]);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "authorization_code", client_id: CLIENT_ID, code: "the-code", code_verifier: "the-verifier", redirect_uri: REDIRECT, resource: SIWC_RESOURCE });
    expect(tokens).toMatchObject({ accessToken: "fake-access", refreshToken: "fake-refresh", idToken: "fake-id", scopes: ["openid", "chatgpt.tokens.use.direct"], expiresAt: NOW.getTime() + ONE_HOUR_MS });
  });

  it("posts a refresh grant and returns the rotated refresh token", async () => {
    const { fetch, calls } = recordingFetch(() => fakeResponse({ text: JSON.stringify({ ...TOKEN_ANSWER, refresh_token: "fake-rotated" }) }));
    const tokens = await refreshTokens(ports(fetch), { clientId: CLIENT_ID, refreshToken: "fake-refresh" });
    expect(Object.fromEntries(calls[0] === undefined ? new URLSearchParams() : formOf(calls[0]))).toEqual({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: "fake-refresh", resource: SIWC_RESOURCE });
    expect(tokens.refreshToken).toBe("fake-rotated");
  });

  it("reports the status and the endpoint's error body when the exchange is refused, never the code", async () => {
    const { fetch } = recordingFetch(() => fakeResponse({ status: HTTP_STATUS.badRequest, text: '{"error":"invalid_grant"}' }));
    const failure = await exchangeCode(ports(fetch), { clientId: CLIENT_ID, code: "secret-code", verifier: "v", redirectUri: REDIRECT }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SiwcError);
    expect((failure as Error).message).toContain("invalid_grant");
    expect((failure as Error).message).not.toContain("secret-code");
  });

  it("rejects an answer with no access token", async () => {
    const { fetch } = recordingFetch(() => fakeResponse({ text: JSON.stringify({ expires_in: 1 }) }));
    await expect(refreshTokens(ports(fetch), { clientId: CLIENT_ID, refreshToken: "r" })).rejects.toThrow(/without an access token/);
  });
});

describe("verifyIdToken", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk: JsonWebKey = pair.publicKey.export({ format: "jwk" });
  const KID = "key-1";

  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  function token(claims: Record<string, unknown>, options: { readonly alg?: string; readonly signWith?: typeof pair.privateKey } = {}): string {
    const signed = `${segment({ alg: options.alg ?? "RS256", kid: KID })}.${segment(claims)}`;
    const signature = createSign("sha256").update(signed).sign(options.signWith ?? pair.privateKey).toString("base64url");
    return `${signed}.${signature}`;
  }
  const goodClaims = { iss: SIWC_ISSUER, sub: "fake-subject", aud: CLIENT_ID, exp: NOW.getTime() / MS_PER_SECOND + ACCESS_LIFETIME_SECONDS, nonce: "n", email: "person@example.com" };
  const keySet = (): UpstreamResponse => fakeResponse({ text: JSON.stringify({ keys: [{ ...jwk, kid: KID }] }) });
  const verifyWith = async (idToken: string, nonce: string | undefined = "n"): Promise<unknown> => await verifyIdToken(ports(recordingFetch(keySet).fetch), idToken, { clientId: CLIENT_ID, nonce });

  it("accepts a token signed by the issuer's key for this client and nonce", async () => {
    const { fetch, calls } = recordingFetch(keySet);
    await expect(verifyIdToken(ports(fetch), token(goodClaims), { clientId: CLIENT_ID, nonce: "n" })).resolves.toEqual({ sub: "fake-subject", email: "person@example.com" });
    expect(calls[0]?.url).toBe(SIWC_JWKS_URL);
  });

  it("rejects a token signed by some other key", async () => {
    await expect(verifyWith(token(goodClaims, { signWith: otherPair.privateKey }))).rejects.toThrow(/signature did not verify/);
  });

  it("rejects an algorithm other than RS256, including none", async () => {
    await expect(verifyWith(token(goodClaims, { alg: "none" }))).rejects.toThrow(/only RS256/);
  });

  it.each([
    ["issuer", { ...goodClaims, iss: "https://evil.example" }, /issued by/],
    ["audience", { ...goodClaims, aud: "someone-else" }, /different client/],
    ["expiry", { ...goodClaims, exp: NOW.getTime() / MS_PER_SECOND - 1 }, /expired/],
    ["nonce", { ...goodClaims, nonce: "other" }, /nonce/],
  ])("rejects a validly signed token with the wrong %s", async (_name, claims, message) => {
    await expect(verifyWith(token(claims))).rejects.toThrow(message);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyWith("not-a-jwt")).rejects.toThrow(/three-part JWT/);
  });
});

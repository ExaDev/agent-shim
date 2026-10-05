import { createSign, generateKeyPairSync } from "node:crypto";
import net from "node:net";

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "./http";
import { SIWC_ISSUER, SIWC_JWKS_URL, SIWC_PLAN_SCOPE, SIWC_REVOKE_URL, SIWC_TOKEN_URL, SiwcError, SiwcInvalidGrantError, type SiwcPorts } from "./siwc";
import { runSiwcLogin, runSiwcLogout, type CallbackListener, type SiwcLoginPorts } from "./siwcLogin";
import { listenForCallback } from "./siwcPorts";
import type { SiwcFile, SiwcStore } from "./siwcStore";
import { fakeResponse, recordingFetch, type RecordedCall } from "./testing";
import type { UpstreamResponse } from "./upstreamPort";

/** Made-up values of no real format: nothing here is, or looks like, a real credential. */
const NOW = new Date("2026-10-05T12:00:00.000Z");
const ISSUED_CLIENT = "fake-issued-client";
const ACCESS_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const KID = "key-1";
/** Far longer than the loopback round trip the listener test waits for. */
const LISTEN_TIMEOUT_MS = 10_000;

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function idTokenFor(clientId: string, nonce: string): string {
  const claims = { iss: SIWC_ISSUER, sub: "fake-subject", aud: clientId, exp: NOW.getTime() / MS_PER_SECOND + ACCESS_LIFETIME_SECONDS, nonce, email: "person@example.com" };
  const signed = `${segment({ alg: "RS256", kid: KID })}.${segment(claims)}`;
  return `${signed}.${createSign("sha256").update(signed).sign(pair.privateKey).toString("base64url")}`;
}

function memoryStore(initial: SiwcFile | undefined): SiwcStore & { readonly writes: SiwcFile[] } {
  let file = initial;
  const writes: SiwcFile[] = [];
  return {
    writes,
    read: () => file,
    write: (next) => {
      file = next;
      writes.push(next);
    },
    auth: { current: async () => await Promise.reject(new Error("unused")), refresh: async () => await Promise.reject(new Error("unused")) },
  };
}

interface Run {
  readonly ports: SiwcLoginPorts;
  readonly store: ReturnType<typeof memoryStore>;
  readonly printed: string[];
  readonly opened: string[];
  readonly calls: RecordedCall[];
  readonly closed: { count: number };
  /** Every authorize URL the sign-in opened, in order. */
  readonly authorizations: URL[];
}

/** A sign-in whose "browser" answers the authorize URL it was handed with a callback built from `callbackFor`. */
function run(options: {
  readonly initial?: SiwcFile;
  readonly callbackFor?: (authorize: URL) => string;
  readonly tokenAnswer?: (idToken: string, clientId: string) => Record<string, unknown>;
  /** Answers the nth token call (0-based) with a refusal instead of the normal grant. */
  readonly refuseTokenCall?: (index: number) => boolean;
  readonly listenFails?: Error;
}): Run {
  const store = memoryStore(options.initial);
  const printed: string[] = [];
  const opened: string[] = [];
  const closed = { count: 0 };
  const authorizations: URL[] = [];
  let authorize: URL | undefined;
  let tokenCalls = 0;
  const respond = (call: RecordedCall): UpstreamResponse => {
    if (call.url === SIWC_JWKS_URL) {
      return fakeResponse({ text: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: KID }] }) });
    }
    if (call.url === SIWC_TOKEN_URL) {
      tokenCalls += 1;
      if (options.refuseTokenCall?.(tokenCalls - 1) === true) {
        return fakeResponse({ status: HTTP_STATUS.badRequest, text: '{"error": "invalid_grant"}' });
      }
      const clientId = new URLSearchParams(call.init.body ?? "").get("client_id") ?? "";
      const nonce = authorize?.searchParams.get("nonce") ?? "";
      const answer = options.tokenAnswer?.(idTokenFor(clientId, nonce), clientId) ?? { access_token: "fake-access", refresh_token: "fake-refresh", id_token: idTokenFor(clientId, nonce), expires_in: ACCESS_LIFETIME_SECONDS, scope: `openid ${SIWC_PLAN_SCOPE}` };
      return fakeResponse({ text: JSON.stringify(answer) });
    }
    return fakeResponse({ status: HTTP_STATUS.notFound });
  };
  const { fetch, calls } = recordingFetch(respond);
  let draws = 0;
  const siwc: SiwcPorts = { fetch, randomBytes: (size) => new Uint8Array(size).fill((draws += 1)), now: () => NOW };
  const listener: CallbackListener = {
    waitForCallback: async () => {
      if (authorize === undefined) {
        throw new Error("the browser was never opened");
      }
      return await Promise.resolve(new URL(options.callbackFor?.(authorize) ?? `http://127.0.0.1:1455/auth/callback?code=the-code&state=${authorize.searchParams.get("state") ?? ""}&client_id=${ISSUED_CLIENT}&scope=openid+${SIWC_PLAN_SCOPE}`));
    },
    close: () => {
      closed.count += 1;
    },
  };
  const ports: SiwcLoginPorts = {
    store,
    siwc,
    listen: async () => {
      if (options.listenFails !== undefined) {
        throw options.listenFails;
      }
      return await Promise.resolve(listener);
    },
    openBrowser: (url) => {
      opened.push(url);
      authorize = new URL(url);
      authorizations.push(authorize);
    },
    print: (line) => {
      printed.push(line);
      const match = /Sign in at: (\S+)/.exec(line);
      if (match?.[1] !== undefined) {
        authorize = new URL(match[1]);
      }
    },
  };
  return { ports, store, printed, opened, calls, closed, authorizations };
}

describe("runSiwcLogin", () => {
  it("registers dynamically on a first sign-in, records the issued client before the exchange and stores a verified grant", async () => {
    const { ports, store, opened, closed } = run({});
    const result = await runSiwcLogin(ports, { open: true });
    expect(result).toEqual({ email: "person@example.com", sub: "fake-subject" });
    const authorize = new URL(opened[0] ?? "");
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.has("ext_agent_host_id")).toBe(false);
    expect(store.writes[0]).toEqual({ registeredClientId: ISSUED_CLIENT });
    expect(store.read()?.grant).toMatchObject({ clientId: ISSUED_CLIENT, sub: "fake-subject", email: "person@example.com", accessToken: "fake-access", refreshToken: "fake-refresh", scopes: ["openid", SIWC_PLAN_SCOPE], expiresAt: NOW.getTime() + ACCESS_LIFETIME_SECONDS * MS_PER_SECOND });
    expect(closed.count).toBe(1);
  });

  it("prints the sign-in address and leaves the browser alone when asked not to open it", async () => {
    const { ports, printed, opened } = run({});
    await runSiwcLogin(ports, { open: false });
    expect(opened).toHaveLength(0);
    expect(printed[0]).toMatch(/^Sign in at: https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
  });

  it("names the issued client and hints the account on a returning sign-in", async () => {
    const initial: SiwcFile = {
      registeredClientId: "fake-old-client",
      grant: { clientId: "fake-old-client", sub: "fake-subject", email: "person@example.com", idToken: "fake-old-id", accessToken: "a", refreshToken: "r", scopes: [SIWC_PLAN_SCOPE], expiresAt: 0 },
    };
    const { ports, opened, store } = run({ initial, callbackFor: (authorize) => `http://127.0.0.1:1455/auth/callback?code=c&state=${authorize.searchParams.get("state") ?? ""}&scope=openid+${SIWC_PLAN_SCOPE}` });
    await runSiwcLogin(ports, { open: true });
    const authorize = new URL(opened[0] ?? "");
    expect(authorize.searchParams.get("client_id")).toBe("fake-old-client");
    expect(authorize.searchParams.get("id_token_hint")).toBe("fake-old-id");
    expect(authorize.searchParams.get("login_hint")).toBe("person@example.com");
    expect(store.read()?.grant?.clientId).toBe("fake-old-client");
  });

  it("authorises again with the issued client, and no new registration, when the first code is refused as invalid_grant", async () => {
    const { ports, store, authorizations, printed } = run({ refuseTokenCall: (index) => index === 0 });
    const result = await runSiwcLogin(ports, { open: true });
    expect(result.sub).toBe("fake-subject");
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]?.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorizations[1]?.searchParams.get("client_id")).toBe(ISSUED_CLIENT);
    expect(authorizations[1]?.searchParams.has("agent_name_hint")).toBe(false);
    expect(authorizations[1]?.searchParams.get("state")).not.toBe(authorizations[0]?.searchParams.get("state"));
    expect(printed.some((line) => line.includes("authorising again"))).toBe(true);
    expect(store.read()?.grant?.clientId).toBe(ISSUED_CLIENT);
  });

  it("gives up after a second invalid_grant instead of looping", async () => {
    const { ports, authorizations } = run({ refuseTokenCall: () => true });
    await expect(runSiwcLogin(ports, { open: true })).rejects.toBeInstanceOf(SiwcInvalidGrantError);
    expect(authorizations).toHaveLength(2);
  });

  it("refuses a grant that was not given the plan scope, and stores nothing", async () => {
    const { ports, store } = run({ tokenAnswer: (idToken) => ({ access_token: "a", refresh_token: "r", id_token: idToken, expires_in: ACCESS_LIFETIME_SECONDS, scope: "openid" }), callbackFor: (authorize) => `http://127.0.0.1:1455/auth/callback?code=c&state=${authorize.searchParams.get("state") ?? ""}&client_id=${ISSUED_CLIENT}&scope=openid` });
    await expect(runSiwcLogin(ports, { open: true })).rejects.toThrow(/permission to use your ChatGPT plan/);
    expect(store.read()?.grant).toBeUndefined();
  });

  it("refuses a callback whose state does not match, before any token call", async () => {
    const { ports, calls } = run({ callbackFor: () => `http://127.0.0.1:1455/auth/callback?code=c&state=forged&client_id=${ISSUED_CLIENT}` });
    await expect(runSiwcLogin(ports, { open: true })).rejects.toThrow(/state did not match/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an answer without a refresh token", async () => {
    const { ports } = run({ tokenAnswer: (idToken) => ({ access_token: "a", id_token: idToken, expires_in: ACCESS_LIFETIME_SECONDS, scope: `openid ${SIWC_PLAN_SCOPE}` }) });
    await expect(runSiwcLogin(ports, { open: true })).rejects.toThrow(SiwcError);
  });

  it("closes the listener when the flow fails", async () => {
    const { ports, closed } = run({ callbackFor: () => "http://127.0.0.1:1455/auth/callback?error=access_denied" });
    await expect(runSiwcLogin(ports, { open: true })).rejects.toThrow(/access_denied/);
    expect(closed.count).toBe(1);
  });

  it("surfaces a taken callback port", async () => {
    const { ports } = run({ listenFails: new Error("port 1455 is in use") });
    await expect(runSiwcLogin(ports, { open: true })).rejects.toThrow(/in use/);
  });
});

describe("runSiwcLogout", () => {
  const signedIn: SiwcFile = { registeredClientId: ISSUED_CLIENT, grant: { clientId: ISSUED_CLIENT, sub: "s", idToken: "i", accessToken: "a", refreshToken: "fake-refresh", scopes: [SIWC_PLAN_SCOPE], expiresAt: 0 } };

  it("revokes the refresh token and removes the grant but keeps the registered client", async () => {
    const store = memoryStore(signedIn);
    const { fetch, calls } = recordingFetch(() => fakeResponse({}));
    const result = await runSiwcLogout({ store, siwc: { fetch, randomBytes: () => new Uint8Array(), now: () => NOW } });
    expect(result).toEqual({ hadGrant: true, revoked: true });
    expect(calls[0]?.url).toBe(SIWC_REVOKE_URL);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.init.body ?? ""))).toEqual({ token: "fake-refresh", token_type_hint: "refresh_token", client_id: ISSUED_CLIENT });
    expect(store.read()).toEqual({ registeredClientId: ISSUED_CLIENT });
  });

  it("removes the grant locally and says so when the revocation call fails", async () => {
    const store = memoryStore(signedIn);
    const { fetch } = recordingFetch(() => {
      throw new Error("offline");
    });
    const result = await runSiwcLogout({ store, siwc: { fetch, randomBytes: () => new Uint8Array(), now: () => NOW } });
    expect(result).toEqual({ hadGrant: true, revoked: false });
    expect(store.read()).toEqual({ registeredClientId: ISSUED_CLIENT });
  });

  it("does nothing when there is no grant", async () => {
    const store = memoryStore({ registeredClientId: ISSUED_CLIENT });
    const { fetch, calls } = recordingFetch(() => fakeResponse({}));
    await expect(runSiwcLogout({ store, siwc: { fetch, randomBytes: () => new Uint8Array(), now: () => NOW } })).resolves.toEqual({ hadGrant: false, revoked: false });
    expect(calls).toHaveLength(0);
    expect(store.writes).toHaveLength(0);
  });
});

describe("listenForCallback", () => {
  const STATE = "the-state";
  async function freePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address === null || typeof address === "string") {
            reject(new Error("no port"));
            return;
          }
          resolve(address.port);
        });
      });
    });
  }

  it("resolves with the redirect's URL and answers the browser", async () => {
    const port = await freePort();
    const listener = await listenForCallback(port, STATE);
    try {
      const waiting = listener.waitForCallback(AbortSignal.timeout(LISTEN_TIMEOUT_MS));
      const response = await fetch(`http://127.0.0.1:${String(port)}/auth/callback?code=c&state=${STATE}`);
      expect(response.status).toBe(HTTP_STATUS.ok);
      expect((await waiting).searchParams.get("state")).toBe(STATE);
    } finally {
      listener.close();
    }
  });

  it("ignores a request with the wrong state or path and keeps waiting for the real callback", async () => {
    const port = await freePort();
    const listener = await listenForCallback(port, STATE);
    try {
      const waiting = listener.waitForCallback(AbortSignal.timeout(LISTEN_TIMEOUT_MS));
      expect((await fetch(`http://127.0.0.1:${String(port)}/auth/callback?code=old&state=stale`)).status).toBe(HTTP_STATUS.notFound);
      expect((await fetch(`http://127.0.0.1:${String(port)}/favicon.ico`)).status).toBe(HTTP_STATUS.notFound);
      expect((await fetch(`http://127.0.0.1:${String(port)}/auth/callback?code=c&state=${STATE}`)).status).toBe(HTTP_STATUS.ok);
      expect((await waiting).searchParams.get("code")).toBe("c");
    } finally {
      listener.close();
    }
  });

  it("explains a port that is already in use", async () => {
    const port = await freePort();
    const first = await listenForCallback(port, STATE);
    try {
      await expect(listenForCallback(port, STATE)).rejects.toThrow(/in use/);
    } finally {
      first.close();
    }
  });

  it("gives up when the signal aborts first", async () => {
    const port = await freePort();
    const listener = await listenForCallback(port, STATE);
    try {
      const controller = new AbortController();
      const waiting = listener.waitForCallback(controller.signal);
      controller.abort();
      await expect(waiting).rejects.toThrow(/timed out/);
    } finally {
      listener.close();
    }
  });
});

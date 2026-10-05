import { describe, expect, it } from "vitest";

import { CodexAuthError, type CodexAuthFs } from "./auth";
import { HTTP_STATUS } from "./http";
import { SIWC_PLAN_SCOPE, SIWC_TOKEN_URL } from "./siwc";
import { createSiwcStore, SIWC_REFRESH_MARGIN_MS, type SiwcGrant } from "./siwcStore";
import { fakeResponse, recordingFetch } from "./testing";

/** Made-up values of no real format: nothing here is, or looks like, a real credential. */
const PATH = "/home/testuser/.agent-shim/codex/chatgpt-sign-in.json";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const HOST_ID = "urn:uuid:00000000-0000-4000-8000-000000000000";
const ACCESS_LIFETIME_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const ONE_HOUR_MS = ACCESS_LIFETIME_SECONDS * MS_PER_SECOND;

function grant(overrides: Partial<SiwcGrant> = {}): SiwcGrant {
  return { clientId: "fake-client", sub: "fake-subject", idToken: "fake-id", accessToken: "fake-access-old", refreshToken: "fake-refresh-old", scopes: ["openid", SIWC_PLAN_SCOPE], expiresAt: NOW.getTime() + ONE_HOUR_MS, ...overrides };
}

interface FakeFs extends CodexAuthFs {
  readonly files: Map<string, string>;
  readonly ops: string[];
}

function fakeFs(initial: unknown): FakeFs {
  const files = new Map<string, string>(initial === undefined ? [] : [[PATH, typeof initial === "string" ? initial : JSON.stringify(initial)]]);
  const ops: string[] = [];
  return {
    files,
    ops,
    read: (filePath) => files.get(filePath),
    writePrivate: (filePath, contents) => {
      ops.push(`write ${filePath === PATH ? "file" : "temp"}`);
      files.set(filePath, contents);
    },
    rename: (from, to) => {
      ops.push("rename");
      const contents = files.get(from);
      if (contents !== undefined) {
        files.set(to, contents);
        files.delete(from);
      }
    },
  };
}

const REFRESH_ANSWER = { access_token: "fake-access-new", refresh_token: "fake-refresh-new", expires_in: ACCESS_LIFETIME_SECONDS };

function store(fs: FakeFs, respond: Parameters<typeof recordingFetch>[0] = () => fakeResponse({ text: JSON.stringify(REFRESH_ANSWER) })) {
  const recorded = recordingFetch(respond);
  const created = createSiwcStore(PATH, { fs, siwc: { fetch: recorded.fetch, randomBytes: (size) => new Uint8Array(size), now: () => NOW }, tempSuffix: "1" });
  return { ...created, calls: recorded.calls };
}

describe("createSiwcStore credentials", () => {
  it("serves the stored access token with no account id and no network call while it is fresh", async () => {
    const { auth, calls } = store(fakeFs({ hostId: HOST_ID, grant: grant() }));
    await expect(auth.current()).resolves.toEqual({ accessToken: "fake-access-old", accountId: undefined });
    expect(calls).toHaveLength(0);
  });

  it("refreshes ahead of expiry and persists the rotated refresh token before handing the new access token out", async () => {
    const fs = fakeFs({ hostId: HOST_ID, grant: grant({ expiresAt: NOW.getTime() + SIWC_REFRESH_MARGIN_MS - 1 }) });
    const { auth, calls } = store(fs);
    const credentials = await auth.current();
    expect(credentials.accessToken).toBe("fake-access-new");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SIWC_TOKEN_URL);
    expect(fs.ops).toEqual(["write temp", "rename"]);
    expect(JSON.parse(fs.files.get(PATH) ?? "{}")).toMatchObject({ hostId: HOST_ID, grant: { accessToken: "fake-access-new", refreshToken: "fake-refresh-new", clientId: "fake-client" } });
  });

  it("keeps the old refresh token and scopes when the endpoint rotates neither", async () => {
    const fs = fakeFs({ hostId: HOST_ID, grant: grant({ expiresAt: NOW.getTime() }) });
    const { auth } = store(fs, () => fakeResponse({ text: JSON.stringify({ access_token: "fake-access-new", expires_in: ACCESS_LIFETIME_SECONDS }) }));
    await auth.current();
    expect(JSON.parse(fs.files.get(PATH) ?? "{}")).toMatchObject({ grant: { refreshToken: "fake-refresh-old", scopes: ["openid", SIWC_PLAN_SCOPE] } });
  });

  it("refreshes once for concurrent callers", async () => {
    const { auth, calls } = store(fakeFs({ hostId: HOST_ID, grant: grant({ expiresAt: NOW.getTime() }) }));
    const [first, second] = await Promise.all([auth.current(), auth.refresh("fake-access-old")]);
    expect(first.accessToken).toBe("fake-access-new");
    expect(second.accessToken).toBe("fake-access-new");
    expect(calls).toHaveLength(1);
  });

  it("reuses a token another process already replaced instead of refreshing", async () => {
    const { auth, calls } = store(fakeFs({ hostId: HOST_ID, grant: grant({ accessToken: "fake-access-elsewhere" }) }));
    await expect(auth.refresh("fake-access-old")).resolves.toMatchObject({ accessToken: "fake-access-elsewhere" });
    expect(calls).toHaveLength(0);
  });

  it("explains a refused refresh without leaking a token", async () => {
    const { auth } = store(fakeFs({ hostId: HOST_ID, grant: grant({ expiresAt: NOW.getTime() }) }), () => fakeResponse({ status: HTTP_STATUS.badRequest, text: '{"error":"invalid_grant"}' }));
    const failure = await auth.current().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CodexAuthError);
    expect((failure as Error).message).toContain("agent-shim codex login");
    expect((failure as Error).message).not.toContain("fake-refresh-old");
  });
});

describe("createSiwcStore refusals", () => {
  it("names the login command when there is no file", async () => {
    await expect(store(fakeFs(undefined)).auth.current()).rejects.toThrow(/agent-shim codex login/);
  });

  it("names the login command when the file holds a host id but no grant", async () => {
    await expect(store(fakeFs({ hostId: HOST_ID })).auth.current()).rejects.toThrow(/agent-shim codex login/);
  });

  it("refuses a grant that was not given permission to use the plan", async () => {
    await expect(store(fakeFs({ hostId: HOST_ID, grant: grant({ scopes: ["openid"] }) })).auth.current()).rejects.toThrow(/permission to use your ChatGPT plan/);
  });

  it("refuses a file that is not a sign-in file", async () => {
    await expect(store(fakeFs({ tokens: {} })).auth.current()).rejects.toThrow(/not a Sign in with ChatGPT file/);
    await expect(store(fakeFs("{not json")).auth.current()).rejects.toThrow(/not valid JSON/);
  });
});

describe("createSiwcStore write", () => {
  it("writes atomically and serves the new grant from memory", async () => {
    const fs = fakeFs({ hostId: HOST_ID });
    const { auth, write, read } = store(fs);
    write({ hostId: HOST_ID, grant: grant() });
    expect(fs.ops).toEqual(["write temp", "rename"]);
    expect(read()).toMatchObject({ hostId: HOST_ID, grant: { clientId: "fake-client" } });
    await expect(auth.current()).resolves.toMatchObject({ accessToken: "fake-access-old" });
  });
});

import { describe, expect, it } from "vitest";

import { CODEX_OAUTH_CLIENT_ID, CODEX_TOKEN_URL, CodexAuthError, createCodexAuthStore, type CodexAuthFs } from "./auth";
import { HTTP_STATUS } from "./http";
import { fakeResponse, recordingFetch, type RecordedCall } from "./testing";
import type { UpstreamResponse } from "./upstreamPort";

/** Made-up token values of no real format: nothing here is, or looks like, a real credential. */
const OLD_ACCESS = "fake-old-access";
const OLD_REFRESH = "fake-old-refresh";
const NEW_ACCESS = "fake-new-access";
const NEW_REFRESH = "fake-new-refresh";
const CLI_ACCESS = "fake-cli-access";
const AUTH_PATH = "/home/testuser/.codex/auth.json";
const NOW = new Date("2026-09-30T12:00:00.000Z");
/** An atomic write is a private temporary write, then a rename. */
const ATOMIC_WRITE_STEPS = 2;

function authFile(tokens: Readonly<Record<string, string>>, extra: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "fake-id", account_id: "fake-account", ...tokens }, last_refresh: "2026-09-01T00:00:00.000Z", ...extra }, null, 2)}\n`;
}

/** An in-memory auth filesystem that records every operation in order, and can crash on the rename. */
interface FakeAuthFs extends CodexAuthFs {
  readonly files: Map<string, string>;
  readonly ops: string[];
  crashOnRename: boolean;
}

function fakeAuthFs(initial: string | undefined): FakeAuthFs {
  const files = new Map<string, string>(initial === undefined ? [] : [[AUTH_PATH, initial]]);
  const ops: string[] = [];
  const port: FakeAuthFs = {
    files,
    ops,
    crashOnRename: false,
    read: (filePath: string) => {
      ops.push(`read ${filePath}`);
      return files.get(filePath);
    },
    writePrivate: (filePath: string, contents: string) => {
      ops.push(`write ${filePath}`);
      files.set(filePath, contents);
    },
    rename: (from: string, to: string) => {
      if (port.crashOnRename) {
        throw new Error("killed before the rename");
      }
      ops.push(`rename ${from} -> ${to}`);
      const contents = files.get(from);
      if (contents === undefined) {
        throw new Error(`no such file ${from}`);
      }
      files.set(to, contents);
      files.delete(from);
    },
  };
  return port;
}

function grant(tokens: Readonly<Record<string, string>>): UpstreamResponse {
  return fakeResponse({ text: JSON.stringify(tokens) });
}

function store(fs: CodexAuthFs, respond: (call: RecordedCall, index: number) => UpstreamResponse | Promise<UpstreamResponse>) {
  const fetch = recordingFetch(respond);
  return { fetch, auth: createCodexAuthStore(AUTH_PATH, { fs, fetch: fetch.fetch, now: () => NOW, tempSuffix: "test" }) };
}

function parsedFile(fs: { readonly files: Map<string, string> }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.files.get(AUTH_PATH) ?? "null");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("auth file is not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("createCodexAuthStore", () => {
  it("reads the access token and account from the file, then serves it from memory", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth, fetch } = store(fs, () => grant({}));
    expect(await auth.current()).toEqual({ accessToken: OLD_ACCESS, accountId: "fake-account" });
    await auth.current();
    expect(fs.ops.filter((op) => op.startsWith("read"))).toHaveLength(1);
    expect(fetch.calls).toEqual([]);
  });

  it("refreshes with the Codex CLI's client and persists the rotated tokens atomically, keeping every other field", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }, { unknown_cli_field: { kept: true } }));
    const { auth, fetch } = store(fs, () => grant({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH }));
    expect(await auth.refresh(OLD_ACCESS)).toEqual({ accessToken: NEW_ACCESS, accountId: "fake-account" });
    expect(fetch.calls[0]?.url).toBe(CODEX_TOKEN_URL);
    const form = new URLSearchParams(fetch.calls[0]?.init.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: OLD_REFRESH, client_id: CODEX_OAUTH_CLIENT_ID });
    expect(parsedFile(fs)).toEqual({
      OPENAI_API_KEY: null,
      tokens: { id_token: "fake-id", account_id: "fake-account", access_token: NEW_ACCESS, refresh_token: NEW_REFRESH },
      last_refresh: NOW.toISOString(),
      unknown_cli_field: { kept: true },
    });
    expect(fs.ops.slice(-ATOMIC_WRITE_STEPS)).toEqual([`write ${AUTH_PATH}.test.tmp`, `rename ${AUTH_PATH}.test.tmp -> ${AUTH_PATH}`]);
    expect(fs.files.has(`${AUTH_PATH}.test.tmp`)).toBe(false);
  });

  it("writes the rotated refresh token to disk before handing the new access token to anyone", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth } = store(fs, () => grant({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH }));
    const credentials = await auth.refresh(OLD_ACCESS);
    // By the time the caller holds the new access token, the file already holds the rotated refresh token.
    expect(credentials.accessToken).toBe(NEW_ACCESS);
    expect(parsedFile(fs).tokens).toMatchObject({ refresh_token: NEW_REFRESH });
  });

  it("refuses to hand out a refreshed token whose rotated refresh token could not be persisted, and leaves a valid file behind", async () => {
    const original = authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH });
    const fs = fakeAuthFs(original);
    fs.crashOnRename = true;
    const { auth } = store(fs, () => grant({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH }));
    await expect(auth.refresh(OLD_ACCESS)).rejects.toThrow("killed before the rename");
    expect(fs.files.get(AUTH_PATH)).toBe(original);
    expect(() => JSON.parse(original) as unknown).not.toThrow();
  });

  it("re-reads the file before refreshing and reuses a token the Codex CLI already refreshed", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth, fetch } = store(fs, () => grant({ access_token: NEW_ACCESS }));
    expect((await auth.current()).accessToken).toBe(OLD_ACCESS);
    // The CLI refreshes behind the daemon's back.
    fs.files.set(AUTH_PATH, authFile({ access_token: CLI_ACCESS, refresh_token: "fake-cli-refresh" }));
    expect((await auth.refresh(OLD_ACCESS)).accessToken).toBe(CLI_ACCESS);
    expect(fetch.calls).toEqual([]);
    expect((await auth.current()).accessToken).toBe(CLI_ACCESS);
  });

  it("merges the new tokens into the file as it stands after the grant, so a concurrent CLI write to other fields survives", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth } = store(fs, () => {
      fs.files.set(AUTH_PATH, authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }, { cli_wrote: "meanwhile" }));
      return grant({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH });
    });
    await auth.refresh(OLD_ACCESS);
    expect(parsedFile(fs)).toMatchObject({ cli_wrote: "meanwhile", tokens: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH } });
  });

  it("keeps the existing refresh token when the endpoint does not rotate it", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth } = store(fs, () => grant({ access_token: NEW_ACCESS }));
    await auth.refresh(OLD_ACCESS);
    expect(parsedFile(fs).tokens).toMatchObject({ access_token: NEW_ACCESS, refresh_token: OLD_REFRESH });
  });

  it("runs one refresh for any number of concurrent 401s", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { auth, fetch } = store(fs, async () => {
      await gate;
      return grant({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH });
    });
    const refreshes = [auth.refresh(OLD_ACCESS), auth.refresh(OLD_ACCESS), auth.refresh(OLD_ACCESS)];
    release();
    const results = await Promise.all(refreshes);
    expect(results.map((result) => result.accessToken)).toEqual([NEW_ACCESS, NEW_ACCESS, NEW_ACCESS]);
    expect(fetch.calls).toHaveLength(1);
    // A later 401 on the refreshed token refreshes again rather than reusing the finished one.
    await auth.refresh(NEW_ACCESS);
    expect(fetch.calls).toHaveLength(2);
  });

  it("reuses the Codex CLI's tokens when its refresh won a race that made this one fail", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth } = store(fs, () => {
      fs.files.set(AUTH_PATH, authFile({ access_token: CLI_ACCESS, refresh_token: "fake-cli-refresh" }));
      return fakeResponse({ status: HTTP_STATUS.badRequest, text: '{"error":"refresh_token_reused"}' });
    });
    expect((await auth.refresh(OLD_ACCESS)).accessToken).toBe(CLI_ACCESS);
  });

  it("fails a refused refresh with the endpoint's error and never a token value", async () => {
    const fs = fakeAuthFs(authFile({ access_token: OLD_ACCESS, refresh_token: OLD_REFRESH }));
    const { auth } = store(fs, () => fakeResponse({ status: HTTP_STATUS.badRequest, text: '{"error":"invalid_grant"}' }));
    const error: unknown = await auth.refresh(OLD_ACCESS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexAuthError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("invalid_grant");
    for (const secret of [OLD_ACCESS, OLD_REFRESH]) {
      expect(message).not.toContain(secret);
    }
  });

  it("fails clearly with no login, no refresh token, or a corrupt file", async () => {
    await expect(store(fakeAuthFs(undefined), () => grant({})).auth.current()).rejects.toThrow("codex login");
    await expect(store(fakeAuthFs(authFile({ access_token: OLD_ACCESS })), () => grant({})).auth.refresh(OLD_ACCESS)).rejects.toThrow("no refresh token");
    await expect(store(fakeAuthFs("{torn"), () => grant({})).auth.current()).rejects.toThrow("not valid JSON");
  });

  it("refreshes a login that has a refresh token but no access token yet", async () => {
    const fs = fakeAuthFs(authFile({ refresh_token: OLD_REFRESH }));
    const { auth, fetch } = store(fs, () => grant({ access_token: NEW_ACCESS }));
    expect((await auth.current()).accessToken).toBe(NEW_ACCESS);
    expect(fetch.calls).toHaveLength(1);
  });
});

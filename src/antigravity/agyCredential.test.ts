import { describe, expect, it, vi } from "vitest";
import type { AsyncCredentialPort, CredentialResolution } from "../credential";
import { createAgyCredentialResolver } from "./agyCredential";

const SHORT_FUTURE_MS = 120_000;
const PAST_MS = 1_000;
const LONG_FUTURE_MS = 3_600_000;
const EXPECTED_COMMANDS = 3;
const now = Date.parse("2026-01-01T00:00:00Z");
const wrap = (token: string, expiry: number): string => `go-keyring-base64:${Buffer.from(JSON.stringify({ token: { access_token: token, refresh_token: "synthetic-refresh", expiry: new Date(expiry).toISOString() } })).toString("base64")}`;
const source: CredentialResolution = { ok: true, credential: { target: "bearer", token: "old", source: { keychain: { service: "gemini", account: "antigravity" } }, warnings: [] } };
const outcome = (stdout: string, status = 0) => ({ status, stdout, stderr: "", timedOut: false });

describe("agy credentials", () => {
  it("reads a fresh token without starting agy", async () => {
    const runCommand = vi.fn().mockResolvedValue(outcome(wrap("fresh", now + SHORT_FUTURE_MS)));
    const resolve = createAgyCredentialResolver({ runCommand } as unknown as AsyncCredentialPort, () => now);
    expect(await resolve(source)).toMatchObject({ ok: true, credential: { token: "fresh" } });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it("refreshes an expired token once for concurrent requests and rereads it", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(outcome(wrap("old", now - PAST_MS))).mockResolvedValueOnce(outcome("ignored")).mockResolvedValueOnce(outcome(wrap("new", now + LONG_FUTURE_MS)));
    const resolve = createAgyCredentialResolver({ runCommand } as unknown as AsyncCredentialPort, () => now);
    const [a, b] = await Promise.all([resolve(source), resolve(source)]);
    expect(a).toMatchObject({ ok: true, credential: { token: "new" } });
    expect(b).toEqual(a);
    expect(runCommand).toHaveBeenCalledTimes(EXPECTED_COMMANDS);
    expect(runCommand.mock.calls[1]?.[0]).toEqual(["agy", "models"]);
  });
  it("fails closed without exposing command output on a refresh failure", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(outcome(wrap("old", now - PAST_MS))).mockResolvedValueOnce(outcome("synthetic-secret", 1));
    const resolve = createAgyCredentialResolver({ runCommand } as unknown as AsyncCredentialPort, () => now);
    const result = await resolve(source);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("leaves other credential sources alone", async () => {
    const runCommand = vi.fn();
    const resolve = createAgyCredentialResolver({ runCommand } as unknown as AsyncCredentialPort, () => now);
    const other: CredentialResolution = { ok: true, credential: { target: "bearer", token: "other", source: { env: "TOKEN" }, warnings: [] } };
    expect(await resolve(other)).toEqual(other);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

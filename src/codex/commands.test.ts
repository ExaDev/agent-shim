import { describe, expect, it } from "vitest";

import { writeFrontDoorSession, writeFrontDoorState } from "../frontdoor/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { codexHome, codexUsageSnapshotPath, collectCodexStatus, formatCodexStatus } from "./commands";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const SUPERVISOR = 10;
/** A stand-in capability: front-door registry records carry one per launch. */
const SESSION_TOKEN = "test-capability";
const LIVE_SESSION = 20;
const DEAD_SESSION = 21;
const PORT = 4100;

describe("codexHome", () => {
  it("follows CODEX_HOME the way the Codex CLI does, else ~/.codex", () => {
    expect(codexHome({ CODEX_HOME: "/elsewhere" }, "/home/testuser")).toBe("/elsewhere");
    expect(codexHome({ CODEX_HOME: "" }, "/home/testuser")).toBe("/home/testuser/.codex");
    expect(codexHome({}, "/home/testuser")).toBe("/home/testuser/.codex");
  });
});

describe("codex status", () => {
  it("reports the serving front door, its codex providers, sessions and the snapshot", () => {
    const fs = createFakeFarmFs({
      [`${paths.providersDir}/codex.json`]: JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } }),
      [`${paths.providersDir}/z.json`]: JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } }),
    });
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEAD_SESSION, startedAt: 0, token: SESSION_TOKEN });
    const alive = new Set([SUPERVISOR, LIVE_SESSION]);
    const status = collectCodexStatus(fs, paths, (pid) => alive.has(pid));
    expect(status.codexProviders).toEqual(["codex"]);
    expect(formatCodexStatus(status)).toEqual([
      "front door: supervisor pid 10 (alive)",
      "listener: front door on 127.0.0.1:4100, serving codex providers under /providers/<name>",
      "codex providers: codex",
      "sessions: 2 registered (20, 21 (dead))",
      "chatgpt sign-in: not signed in (run `agent-shim codex login`)",
      `usage snapshot: ${codexUsageSnapshotPath()} (not created yet)`,
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });

  it("reports a stopped front door with its sticky port and last error", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { lastPort: PORT, lastError: "gave up" });
    expect(formatCodexStatus(collectCodexStatus(fs, paths, () => false))).toEqual([
      "front door: not running",
      "listener: not running (next start on 127.0.0.1:4100)",
      "codex providers: none defined",
      "sessions: none",
      "last error: gave up",
      "chatgpt sign-in: not signed in (run `agent-shim codex login`)",
      `usage snapshot: ${codexUsageSnapshotPath()} (not created yet)`,
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });

  const signInFile = (grant: unknown): Record<string, string> => ({ [paths.chatgptSignInFile]: JSON.stringify({ hostId: "urn:uuid:x", ...(grant === undefined ? {} : { grant }) }) });
  const grant = { clientId: "c", sub: "s", email: "person@example.com", idToken: "i", accessToken: "a", refreshToken: "r", scopes: ["openid", "chatgpt.tokens.use.direct"], expiresAt: 5 };

  it("reports a Sign in with ChatGPT login by who it is, never by its tokens", () => {
    const fs = createFakeFarmFs(signInFile(grant));
    const status = collectCodexStatus(fs, paths, () => false);
    expect(status.signIn).toEqual({ state: "signed-in", email: "person@example.com", planScope: true, accessTokenExpiresAt: 5 });
    expect(formatCodexStatus(status)).toContain("chatgpt sign-in: signed in as person@example.com");
    expect(JSON.stringify(status)).not.toContain("refreshToken");
  });

  it("flags a login that was not given permission to use the plan", () => {
    const fs = createFakeFarmFs(signInFile({ ...grant, scopes: ["openid"] }));
    expect(formatCodexStatus(collectCodexStatus(fs, paths, () => false))).toContain("chatgpt sign-in: signed in as person@example.com, WITHOUT permission to use your ChatGPT plan (run `agent-shim codex login` again and allow it)");
  });

  it("treats a file with only a host id as not signed in", () => {
    expect(collectCodexStatus(createFakeFarmFs(signInFile(undefined)), paths, () => false).signIn).toEqual({ state: "none" });
  });

  it("reports an unreadable sign-in file instead of failing the status", () => {
    const status = collectCodexStatus(createFakeFarmFs({ [paths.chatgptSignInFile]: "{not json" }), paths, () => false);
    expect(status.signIn).toMatchObject({ state: "unreadable" });
    expect(formatCodexStatus(status).find((line) => line.startsWith("chatgpt sign-in:"))).toMatch(/not valid JSON/);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import type { CodexStatus } from "../codex/commands";
import { mountRouterClient } from "./apiTestMount";
import { createCodexApiRouter, type CodexApiDeps } from "./codexApi";

const CONTROL_TOKEN = "unit-control-token";
const TOKEN_EXPIRY_MS = 1_800_000_000_000;

/** A status as `collectCodexStatus` returns it, signed in, with paths and sessions the procedure must not carry. */
const STATUS: CodexStatus = {
  frontDoor: { supervisorPid: 10 },
  supervisorAlive: true,
  sessions: [{ pid: 20, startedAt: 1, alive: true }],
  codexProviders: ["codex-a", "codex-b"],
  signIn: { state: "signed-in", email: "someone@example.com", planScope: true, accessTokenExpiresAt: TOKEN_EXPIRY_MS },
  usageSnapshotPath: "/local/path/codex-usage.json",
  usageSnapshotExists: true,
  logPath: "/local/path/frontdoor.log",
  logExists: true,
};

function makeDeps(overrides: Partial<CodexApiDeps> = {}): CodexApiDeps {
  return {
    expectedToken: CONTROL_TOKEN,
    codexStatus: () => STATUS,
    codexLogout: async () => await Promise.resolve({ hadGrant: true, revoked: true }),
    ...overrides,
  };
}

describe("the door's Codex API", () => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0)) {
      await close();
    }
  });

  async function mount(deps: CodexApiDeps, token = CONTROL_TOKEN) {
    const mounted = await mountRouterClient(createCodexApiRouter(deps), CONTROL_TOKEN, token);
    closes.push(mounted.close);
    return mounted;
  }

  it("reports the sign-in and the codex providers, and nothing about the host's paths or sessions", async () => {
    const { client } = await mount(makeDeps());
    await expect(client.codex.status()).resolves.toEqual({
      signIn: { state: "signed-in", email: "someone@example.com", planScope: true, accessTokenExpiresAt: TOKEN_EXPIRY_MS },
      codexProviders: ["codex-a", "codex-b"],
    });
  });

  it("reports the states without a login as the status does", async () => {
    const none = await mount(makeDeps({ codexStatus: () => ({ ...STATUS, signIn: { state: "none" }, codexProviders: [] }) }));
    await expect(none.client.codex.status()).resolves.toEqual({ signIn: { state: "none" }, codexProviders: [] });
    const unreadable = await mount(makeDeps({ codexStatus: () => ({ ...STATUS, signIn: { state: "unreadable", message: "the sign-in file is not valid JSON" } }) }));
    await expect(unreadable.client.codex.status()).resolves.toMatchObject({ signIn: { state: "unreadable", message: "the sign-in file is not valid JSON" } });
  });

  it("signs out through the logout function and reports its result", async () => {
    const { client } = await mount(makeDeps({ codexLogout: async () => await Promise.resolve({ hadGrant: true, revoked: false }) }));
    await expect(client.codex.logout()).resolves.toEqual({ hadGrant: true, revoked: false });
  });

  it("refuses both procedures without the control token", async () => {
    let logouts = 0;
    const { client } = await mount(
      makeDeps({
        codexLogout: async () => {
          logouts += 1;
          return await Promise.resolve({ hadGrant: true, revoked: true });
        },
      }),
      "not-the-token",
    );
    await expect(client.codex.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.codex.logout()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(logouts).toBe(0);
  });
});

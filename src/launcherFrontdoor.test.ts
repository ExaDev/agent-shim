import { describe, expect, it } from "vitest";

import type { FrontDoorPort, HeadroomPort } from "./launcher/ports";
import { discovered, FAKE_HOME, fakeCredentials, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

const FRONTDOOR_PORT = 4100;
const HEADROOM_PORT = 8123;

const codexProvider = {
  kind: "codex",
  displayName: "Codex",
  credential: { sources: [{ literal: "codex-placeholder" }] },
};

/** A fake front-door port that reports each bring-up to `record`, so a test can see the order daemons came up in. */
function fakeFrontDoorPort(record: (daemon: string) => void): FrontDoorPort & { readonly releases: () => number } {
  let releases = 0;
  return {
    ensure: () => {
      record("frontdoor");
      return { port: FRONTDOOR_PORT };
    },
    release: () => {
      releases += 1;
    },
    releases: () => releases,
  };
}

function fakeHeadroomPort(record: (daemon: string) => void): HeadroomPort {
  return {
    ensure: () => {
      record("headroom");
      return { port: HEADROOM_PORT, mitmPort: HEADROOM_PORT + 1, caCertPath: "/ca.pem", projectId: "/repo" };
    },
    release: () => undefined,
  };
}

function recordInto(order: Readonly<{ push: (daemon: string) => number }>): (daemon: string) => void {
  return (daemon) => {
    order.push(daemon);
  };
}

describe("runLauncher with a codex provider", () => {
  it("brings the front door up and points the child at its provider-scoped address", () => {
    const spawn = fakeSpawn();
    const order: string[] = [];
    const frontdoor = fakeFrontDoorPort(recordInto(order));
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/codex.json`]: codexProvider }),
      spawn,
      proc: fakeProc({}, ["--provider", "codex", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor,
      credentials: fakeCredentials(),
    });
    const env = spawnedEnv(spawn);
    expect(order).toEqual(["frontdoor"]);
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${String(FRONTDOOR_PORT)}/providers/codex`);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("codex-placeholder");
    expect(env.CLAUDE_USE_PROVIDER).toBe("Codex");
    expect(frontdoor.releases()).toBeGreaterThan(0);
  });

  it("starts the front door before headroom and hands headroom the front door's address as the upstream", () => {
    const spawn = fakeSpawn();
    const order: string[] = [];
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/codex.json`]: codexProvider }),
      spawn,
      proc: fakeProc({ CLAUDE_USE_HEADROOM: "1" }, ["--provider", "codex"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(recordInto(order)),
      headroom: fakeHeadroomPort(recordInto(order)),
      credentials: fakeCredentials(),
    });
    const env = spawnedEnv(spawn);
    expect(order).toEqual(["frontdoor", "headroom"]);
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${String(HEADROOM_PORT)}`);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`x-headroom-project-id: /repo\nx-headroom-base-url: http://127.0.0.1:${String(FRONTDOOR_PORT)}/providers/codex`);
  });

  it("refuses a codex provider when no front-door port is wired", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/codex.json`]: codexProvider }),
      spawn,
      proc: fakeProc({}, ["--provider", "codex"]),
      log,
      resolveClaudeBinary: () => discovered,
      credentials: fakeCredentials(),
    });
    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("front-door");
  });

  it("never touches the front door for an http provider", () => {
    const spawn = fakeSpawn();
    const order: string[] = [];
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/z.json`]: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } } }),
      spawn,
      proc: fakeProc({ Z: "tok" }, ["--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(recordInto(order)),
      credentials: fakeCredentials(),
    });
    expect(order).toEqual([]);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
  });
});

import { describe, expect, it } from "vitest";

import type { HeadroomPort } from "./launcher/ports";
import { discovered, FAKE_HOME, FAKE_TRUST_BUNDLE, fakeCredentials, fakeFs, fakeFrontDoorPort, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

const FRONTDOOR_PORT = 4100;
const HEADROOM_PORT = 8123;

const codexProvider = {
  kind: "codex",
  displayName: "Codex",
  credential: { sources: [{ literal: "codex-placeholder" }] },
};

function fakeHeadroomPort(record: (daemon: string) => void): HeadroomPort {
  return {
    ensure: () => {
      record("headroom");
      return { port: HEADROOM_PORT, projectId: "/repo" };
    },
    release: () => undefined,
  };
}

function recordInto(order: Readonly<{ push: (daemon: string) => number }>): (daemon: string) => void {
  return (daemon) => {
    order.push(daemon);
  };
}

describe("runLauncher with a provider", () => {
  it("brings the front door up and points the child at its provider-scoped address", () => {
    const spawn = fakeSpawn();
    const order: string[] = [];
    const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/codex.json`]: codexProvider }),
      spawn,
      proc: fakeProc({}, ["--provider", "codex", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor,
      credentials: fakeCredentials(),
    });
    const env = spawnedEnv(spawn);
    expect(order).toEqual([]);
    expect(env.ANTHROPIC_BASE_URL).toBe(`https://127.0.0.1:${String(FRONTDOOR_PORT)}/providers/codex`);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("codex-placeholder");
    expect(env.AGENT_SHIM_PROVIDER).toBe("Codex");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toMatch(/^x-agent-shim-session: [0-9a-f-]{36}\nx-agent-shim-auth: launch-token-for-tests$/);
    expect(frontdoor.releases()).toBeGreaterThan(0);
  });

  it("brings an http provider's launch through the door too, on the same provider-scoped address", () => {
    const spawn = fakeSpawn();
    const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } } }),
      spawn,
      proc: fakeProc({ Z: "tok" }, ["--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor,
      credentials: fakeCredentials(),
    });
    expect(frontdoor.ensures()).toBe(1);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBe(`https://127.0.0.1:${String(FRONTDOOR_PORT)}/providers/z`);
    // The base URL is HTTPS with a leaf from agent-shim's CA, so the child must trust that CA.
    expect(spawnedEnv(spawn).NODE_EXTRA_CA_CERTS).toBe(FAKE_TRUST_BUNDLE);
  });

  it("hands the door the parent's own NODE_EXTRA_CA_CERTS and logs why the trust bundle dropped it, when it did", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT, undefined, { path: "/bundle.pem", warning: "agent-shim: NODE_EXTRA_CA_CERTS names /corp.pem, which could not be read" });
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } } }),
      spawn,
      proc: fakeProc({ Z: "tok", NODE_EXTRA_CA_CERTS: "/corp.pem" }, ["--provider", "z"]),
      log,
      resolveClaudeBinary: () => discovered,
      frontdoor,
      credentials: fakeCredentials(),
    });
    expect(frontdoor.inherited()).toEqual(["/corp.pem"]);
    expect(spawnedEnv(spawn).NODE_EXTRA_CA_CERTS).toBe("/bundle.pem");
    expect(log.warns).toContain("agent-shim: NODE_EXTRA_CA_CERTS names /corp.pem, which could not be read");
  });

  it("starts the front door before headroom, whose allowlist must already admit the door's address", () => {
    const spawn = fakeSpawn();
    const order: string[] = [];
    const plainDoor = fakeFrontDoorPort(FRONTDOOR_PORT);
    const recordingDoor = { ensure: (inherited: string | undefined) => { order.push("frontdoor"); return plainDoor.ensure(inherited); }, release: () => { plainDoor.release(); } };
    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/codex.json`]: codexProvider }),
      spawn,
      proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--provider", "codex"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: recordingDoor,
      headroom: fakeHeadroomPort(recordInto(order)),
      credentials: fakeCredentials(),
    });
    const env = spawnedEnv(spawn);
    expect(order).toEqual(["frontdoor", "headroom"]);
    expect(env.ANTHROPIC_BASE_URL).toBe(`https://127.0.0.1:${String(FRONTDOOR_PORT)}/providers/codex`);
    expect(env.HEADROOM_PROXY_URL).toBe(`http://127.0.0.1:${String(HEADROOM_PORT)}`);
    // The child names no upstream for headroom: the door's hop decides where headroom forwards, so no x-headroom-base-url exists any more.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain("x-headroom-base-url");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-agent-shim-headroom: 1");
  });

  it("refuses a provider launch when no front-door port is wired", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/codex.json`]: codexProvider }),
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

  it("never touches the front door when neither a provider nor headroom resolved on", () => {
    const spawn = fakeSpawn();
    const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor,
    });
    expect(frontdoor.ensures()).toBe(0);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it.each([
    ["the --track-usage flag", ["--track-usage", "--print"], {}],
    ["AGENT_SHIM_TRACK_USAGE", ["--print"], { AGENT_SHIM_TRACK_USAGE: "1" }],
  ] as const)("routes a plain OAuth launch through the door's CONNECT surface, with no headroom and no provider, for %s", (_name, argv, env) => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc(env, argv),
      log,
      resolveClaudeBinary: () => discovered,
      frontdoor,
    });
    const childEnv = spawnedEnv(spawn);
    expect(frontdoor.ensures()).toBe(1);
    expect(childEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(childEnv.HTTPS_PROXY).toContain("127.0.0.1");
    expect(childEnv.HEADROOM_PROXY_URL).toBeUndefined();
    expect(log.infos.join("\n")).toContain("OAuth via the door's CONNECT surface");
    expect(frontdoor.releases()).toBeGreaterThan(0);
  });

  it("lets --no-track-usage opt one launch out of a cascade or environment that turns tracking on", () => {
    const spawn = fakeSpawn();
    const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ AGENT_SHIM_TRACK_USAGE: "1" }, ["--no-track-usage", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor,
    });
    expect(frontdoor.ensures()).toBe(0);
    expect(spawnedEnv(spawn).HTTPS_PROXY).toBeUndefined();
  });

  it("refuses to launch when tracking is on but no front-door port is wired", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc({}, ["--track-usage", "--print"]), log, resolveClaudeBinary: () => discovered });
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("front-door");
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureCa, generateCa, realConnectCertStore } from "../frontdoor/connect";
import { realTrustBundleFs } from "../frontdoor/realFrontDoorPort";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { collectHeadroomStatus, formatHeadroomStatus, headroomProxyArgs, headroomSpawnEnv, resolveHeadroomTrustBundle } from "./commands";
import { headroomSocketPath } from "./socket";
import { hashAllowlist, headroomAllowlist, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SUPERVISOR_PID = 11;
const HEADROOM_PID = 12;
const SESSION_PID = 13;
const SOCKET_PATH = headroomSocketPath(paths, SUPERVISOR_PID);

function aliveWorld() {
  const fs = createFakeFarmFs({});
  fs.mkdirp(paths.providersDir);
  fs.writeFileUtf8(
    `${paths.providersDir}/z.json`,
    JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } }),
  );
  writeHeadroomState(fs, paths.headroomStateFile, {
    supervisorPid: SUPERVISOR_PID,
    headroomPid: HEADROOM_PID,
    socketPath: SOCKET_PATH,
    version: "headroom 0.39.1",
    allowlistHash: hashAllowlist(headroomAllowlist([{ baseUrl: "https://api.z.ai/api/anthropic" }])),
  });
  writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_PID, startedAt: 1000, supervisorPid: SUPERVISOR_PID });
  const alive = new Set([SUPERVISOR_PID, HEADROOM_PID, SESSION_PID]);
  return { fs, alive };
}

describe("collectHeadroomStatus", () => {
  it("reports a healthy daemon, its live session, the current allowlist, and no drift", () => {
    const { fs, alive } = aliveWorld();
    const status = collectHeadroomStatus(fs, paths, (pid) => alive.has(pid));
    expect(status.supervisorAlive).toBe(true);
    expect(status.headroomAlive).toBe(true);
    expect(status.state.socketPath).toBe(SOCKET_PATH);
    expect(status.allowlist).toEqual(["https://api.anthropic.com", "https://api.z.ai/api/anthropic"]);
    expect(status.allowlistDrifted).toBe(false);
    expect(status.sessions).toEqual([{ pid: SESSION_PID, startedAt: 1000, supervisorPid: SUPERVISOR_PID, alive: true }]);
  });

  it("marks dead pids and allowlist drift without touching anything", () => {
    const { fs } = aliveWorld();
    fs.writeFileUtf8(
      `${paths.providersDir}/m.json`,
      JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", credential: { sources: [{ env: "T" }] } }),
    );
    const status = collectHeadroomStatus(fs, paths, () => false);
    expect(status.supervisorAlive).toBe(false);
    expect(status.headroomAlive).toBe(false);
    expect(status.sessions.map((session) => session.alive)).toEqual([false]);
    expect(status.allowlistDrifted).toBe(true);
  });

  it("treats absent state as a never-run daemon rather than an error", () => {
    const status = collectHeadroomStatus(createFakeFarmFs({}), paths, () => true);
    expect(status.state).toEqual({});
    expect(status.supervisorAlive).toBe(false);
    expect(status.allowlist).toEqual(["https://api.anthropic.com"]);
  });
});

describe("formatHeadroomStatus", () => {
  it("renders the running daemon's pids, socket, version, allowlist, sessions, and log path", () => {
    const { fs, alive } = aliveWorld();
    const lines = formatHeadroomStatus(collectHeadroomStatus(fs, paths, (pid) => alive.has(pid)));
    expect(lines[0]).toBe(`supervisor: pid ${String(SUPERVISOR_PID)} (alive)`);
    expect(lines[1]).toBe(
      `headroom: pid ${String(HEADROOM_PID)} (alive), listening on unix socket ${SOCKET_PATH}, headroom 0.39.1`,
    );
    expect(lines[2]).toBe("allowlist: https://api.anthropic.com, https://api.z.ai/api/anthropic");
    expect(lines[3]).toBe("settings: headroom defaults");
    expect(lines[4]).toBe(`sessions: 1 registered (${String(SESSION_PID)})`);
    expect(lines.at(-1)).toBe(`daemon log: ${paths.headroomLogPath} (not created yet)`);
  });

  it("marks a session registered against a supervisor other than the one the state file names", () => {
    const { fs, alive } = aliveWorld();
    const superseded = 77;
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_PID + 1, startedAt: 1000, supervisorPid: superseded });
    alive.add(SESSION_PID + 1);
    const lines = formatHeadroomStatus(collectHeadroomStatus(fs, paths, (pid) => alive.has(pid)));
    expect(lines[4]).toBe(`sessions: 2 registered (${String(SESSION_PID)}, ${String(SESSION_PID + 1)} on superseded supervisor ${String(superseded)})`);
  });

  it("says plainly when nothing is running", () => {
    const lines = formatHeadroomStatus(collectHeadroomStatus(createFakeFarmFs({}), paths, () => true));
    expect(lines[0]).toBe("supervisor: not running (no state recorded)");
    expect(lines[1]).toBe("headroom: not running");
    expect(lines[2]).toBe("allowlist: https://api.anthropic.com");
    expect(lines[3]).toBe("settings: headroom defaults");
    expect(lines[4]).toBe("sessions: none");
  });
});

describe("headroomSpawnEnv", () => {
  it("defaults HEADROOM_HTTP2 to 0 and joins the allowlist into the environment", () => {
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, ["https://api.anthropic.com", "https://api.z.ai/api/anthropic"], {});
    expect(env.HEADROOM_HTTP2).toBe("0");
    expect(env.HEADROOM_ALLOWED_BASE_URLS).toBe("https://api.anthropic.com,https://api.z.ai/api/anthropic");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("leaves an explicit HEADROOM_HTTP2 from the parent environment in place", () => {
    const env = headroomSpawnEnv({ HEADROOM_HTTP2: "1" }, ["https://api.anthropic.com"], {});
    expect(env.HEADROOM_HTTP2).toBe("1");
  });

  it("removes an ambient HEADROOM_HOST and HEADROOM_PORT, which headroom refuses alongside --uds", () => {
    const env = headroomSpawnEnv({ PATH: "/usr/bin", HEADROOM_HOST: "0.0.0.0", HEADROOM_PORT: "8787" }, ["https://api.anthropic.com"], {});
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["PATH", "HEADROOM_ALLOWED_BASE_URLS", "HEADROOM_HTTP2"]));
    expect(env).not.toHaveProperty("HEADROOM_HOST");
    expect(env).not.toHaveProperty("HEADROOM_PORT");
  });
});

/** Every environment variable a TLS stack headroom runs reads as a file or directory path naming trust anchors: headroom's own additive bundle, Python's ssl and httpx (`SSL_CERT_FILE`, `SSL_CERT_DIR`), and requests (`REQUESTS_CA_BUNDLE`). */
const TRUST_PATH_VARIABLES = ["HEADROOM_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"] as const;

/** The armour line every PEM certificate starts with: its presence in an environment value means certificate text where a path belongs. */
const PEM_CERTIFICATE_HEADER = "-----BEGIN CERTIFICATE-----";

describe("headroom trust", () => {
  let root: string;
  let layout: LayoutPaths;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "headroom-trust-test-"));
    layout = buildLayoutPaths(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes a real door CA to this root, exactly as the door's first start does, and returns its certificate PEM. */
  function startDoorCa(): string {
    return ensureCa(realConnectCertStore(layout), () => generateCa(new Date())).certPem;
  }

  it("hands headroom no trust bundle on a root where no door has ever run", () => {
    expect(resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs })).toBeUndefined();
  });

  it("points HEADROOM_CA_BUNDLE at a file holding the door's CA, and exports no certificate text in any variable", () => {
    const caPem = startDoorCa();
    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, ["https://api.anthropic.com"], {}, trust?.path);

    expect(env.HEADROOM_CA_BUNDLE).toBe(layout.frontdoorCaCertFile);
    expect(readFileSync(layout.frontdoorCaCertFile, "utf8")).toBe(caPem);
    for (const [name, value] of Object.entries(env)) {
      expect(value, name).not.toContain(PEM_CERTIFICATE_HEADER);
    }
    for (const name of TRUST_PATH_VARIABLES) {
      const value = env[name];
      if (value !== undefined) {
        expect(statSync(value).isFile(), name).toBe(true);
      }
    }
  });

  it("never replaces headroom's default trust store with the door's CA alone", () => {
    startDoorCa();
    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, ["https://api.anthropic.com"], {}, trust?.path);

    expect(env).not.toHaveProperty("SSL_CERT_FILE");
    expect(env).not.toHaveProperty("REQUESTS_CA_BUNDLE");
  });

  it("folds an inherited HEADROOM_CA_BUNDLE into the bundle, since headroom reads one file from it", () => {
    const caPem = startDoorCa();
    const corporateFile = path.join(root, "corporate.pem");
    const corporatePem = generateCa(new Date()).certPem;
    writeFileSync(corporateFile, corporatePem, "utf8");

    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: corporateFile, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ HEADROOM_CA_BUNDLE: corporateFile }, ["https://api.anthropic.com"], {}, trust?.path);

    if (trust === undefined) {
      throw new Error("a door CA exists, so headroom must be handed a trust bundle");
    }
    expect(env.HEADROOM_CA_BUNDLE).toBe(trust.path);
    expect(path.dirname(trust.path)).toBe(layout.frontdoorCaBundlesDir);
    const bundle = readFileSync(trust.path, "utf8");
    expect(bundle).toContain(caPem.trim());
    expect(bundle).toContain(corporatePem.trim());
  });

  it("leaves an inherited SSL_CERT_FILE in place, so an explicit replacement store in the parent environment still wins", () => {
    startDoorCa();
    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ SSL_CERT_FILE: "/etc/ssl/corporate.pem" }, ["https://api.anthropic.com"], {}, trust?.path);

    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/corporate.pem");
    expect(env.HEADROOM_CA_BUNDLE).toBe(layout.frontdoorCaCertFile);
  });
});

describe("headroomProxyArgs", () => {
  it("serves the proxy on the unix socket and binds no TCP address", () => {
    const args = headroomProxyArgs(SOCKET_PATH, { mode: "token" });
    expect(args).toEqual(["proxy", "--uds", SOCKET_PATH, "--no-rate-limit", "--mode", "token"]);
    expect(args).not.toContain("--port");
    expect(args).not.toContain("--host");
  });

  it("turns the daemon's local rate limiter off whatever the settings", () => {
    expect(headroomProxyArgs(SOCKET_PATH, {})).toContain("--no-rate-limit");
    expect(headroomProxyArgs(SOCKET_PATH, { mode: "cache" })).toContain("--no-rate-limit");
  });
});

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { buildLayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { frontDoorApiClient } from "./controlApi";
import { DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS } from "../providerReachability";
import { PROBE_WAIT_MARGIN_MS, PROBE_WORKER_START_LIMIT_MS } from "./probe";
import packageJson from "../../package.json";
import { createDoorReports } from "./doorReports";
import { REPORT_PROGRESS_FD, REPORT_PROGRESS_FD_ENV, reportProgressTarget, executableFingerprint, createReportProgressReader, encodeReportSize, type ReportProgress } from "./reportProgress";
import { readFrontDoorState } from "./state";

const BUNDLE_TARGET = "node22";
const IMPORT_META_URL_VARIABLE = "__agentShimImportMetaUrl";
const POLL_MS = 25;
/** Ceilings for events the real processes produce; a pass takes a small fraction of each. */
const STARTUP_TIMEOUT_MS = 30_000;
const SUITE_TIMEOUT_MS = 120_000;

/** A loopback port nothing listens on, so the provider's probe is refused at once and never leaves the machine. */
const REFUSED_BASE_URL = "http://127.0.0.1:1";

async function until<T>(read: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

/** The CLI bundled the way the release bundles it, so the test runs the real `__frontdoor-supervisor` and the `check` and `doctor` children it starts from the same file. */
async function bundleCli(dir: string): Promise<string> {
  const outfile = path.join(dir, "cli.cjs");
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "..", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: BUNDLE_TARGET,
    outfile,
    banner: { js: `const ${IMPORT_META_URL_VARIABLE} = require("node:url").pathToFileURL(process.argv[1] ?? process.execPath).href;` },
    define: { "import.meta.url": IMPORT_META_URL_VARIABLE },
    logLevel: "silent",
  });
  return outfile;
}

/**
 * A real front door, running as the supervisor whose event loop refuses blocking work, answering `check.run` and `doctor.run` over its typed API for a configuration holding an http provider. Collecting either report in the door's own process runs the blocking provider probe there, which the supervisor role refuses, so these calls only succeed when the door collects them somewhere else.
 */
describe.skipIf(process.platform === "win32")("the front door's check and doctor reports over its typed API", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
  });

  it("answer for a configuration with an http provider, which the door's own event loop could not probe", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "door-reports-e2e-"));
    cleanups.push(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });
    const layout = buildLayoutPaths(home);
    fs.mkdirSync(layout.providersDir, { recursive: true });
    fs.writeFileSync(path.join(layout.providersDir, "refused.json"), JSON.stringify({ displayName: "Refused", baseUrl: REFUSED_BASE_URL, credential: { sources: [{ literal: "placeholder" }] } }));
    // The directory's own committed configuration selects the provider, which is what makes `check` probe it.
    const project = path.join(home, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, ".agent-shim.json"), JSON.stringify({ launch: { provider: "refused" } }));
    const cli = await bundleCli(home);
    const door = spawn(process.execPath, [cli, "__frontdoor-supervisor"], { env: { ...process.env, AGENT_SHIM_HOME: home }, stdio: "ignore" });
    cleanups.push(() => {
      door.kill("SIGKILL");
    });
    const pid = door.pid;
    if (pid === undefined) {
      throw new Error("the door did not start");
    }
    const serving = await until(() => {
      const state = readFrontDoorState(realFarmFs, layout.frontdoorStateFile);
      return state?.supervisorPid === pid && state.port !== undefined ? { port: state.port } : undefined;
    }, STARTUP_TIMEOUT_MS, "the door to serve");
    const api = frontDoorApiClient(serving.port, fs.readFileSync(layout.frontdoorCaCertFile, "utf8"), fs.readFileSync(layout.frontdoorControlTokenFile, "utf8"));

    const doctor = await api.doctor.run();
    const unreachable = doctor.findings.find((finding) => finding.section === "provider" && finding.severity === "fail" && finding.subject === "refused");
    expect(unreachable?.message).toContain(`provider refused could not connect to ${REFUSED_BASE_URL}`);
    const check = await api.check.run({ path: project });
    expect(check.providerReachability).toMatchObject({ ok: false });
  }, SUITE_TIMEOUT_MS);

  it("ignores the progress variable when it was not set by this process's parent, so an inherited variable neither corrupts the JSON on standard output nor writes into a file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "door-reports-stray-e2e-"));
    cleanups.push(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });
    const cli = await bundleCli(home);
    const file = path.join(home, "descriptor-target");
    fs.writeFileSync(file, "");
    const open = fs.openSync(file, "r+");
    cleanups.push(() => {
      fs.closeSync(open);
    });
    const runWith = (descriptorStdio: "ignore" | number): string => {
      const result = spawnSync(process.execPath, [cli, "identity", "list", "--json"], { env: { ...process.env, AGENT_SHIM_HOME: home, [REPORT_PROGRESS_FD_ENV]: reportProgressTarget(REPORT_PROGRESS_FD, process.pid + 1, { release: packageJson.version, build: "" }) }, stdio: ["ignore", "pipe", "pipe", descriptorStdio], encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    // A variable naming a descriptor that is not open, and one that is an ordinary file, as a shell that exported it would give: standard output is the list alone, and the file is untouched.
    expect(JSON.parse(runWith("ignore"))).toEqual([]);
    expect(JSON.parse(runWith(open))).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("");
  }, SUITE_TIMEOUT_MS);

  it("refuses a report from a door of another release, naming both and how to replace the door, and reads one from a door of its own", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "door-reports-skew-e2e-"));
    cleanups.push(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });
    const cli = await bundleCli(home);
    const selfInvocation = (args: readonly string[]): { readonly command: string; readonly args: readonly string[] } => ({ command: process.execPath, args: [cli, ...args] });
    const env = { ...process.env, AGENT_SHIM_HOME: home };
    const older = createDoorReports({ selfInvocation, env, door: { release: "0.0.1", build: "" } });
    await expect(older.doctorReport(undefined)).rejects.toThrow(new RegExp(`runs agent-shim 0\\.0\\.1, and this is agent-shim ${packageJson.version.replaceAll(".", "\\.")}.*agent-shim frontdoor restart`));
    // The same version from another build of the executable is refused too, and the build of the executable it runs is accepted.
    const rebuilt = createDoorReports({ selfInvocation, env, door: { release: packageJson.version, build: "an-earlier-build" } });
    await expect(rebuilt.doctorReport(undefined)).rejects.toThrow(/runs a different build of agent-shim.*agent-shim frontdoor restart/);
    const same = createDoorReports({ selfInvocation, env, door: { release: packageJson.version, build: executableFingerprint(cli) } });
    expect((await same.doctorReport(undefined)).findings.length).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  it("has the bundled doctor announce the provider probe's step and its end on the descriptor it is given, and its report's size before the report", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "door-reports-progress-e2e-"));
    cleanups.push(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });
    const layout = buildLayoutPaths(home);
    fs.mkdirSync(layout.providersDir, { recursive: true });
    fs.writeFileSync(path.join(layout.providersDir, "refused.json"), JSON.stringify({ displayName: "Refused", baseUrl: REFUSED_BASE_URL, credential: { sources: [{ literal: "placeholder" }] } }));
    const cli = await bundleCli(home);
    const child = spawn(process.execPath, [cli, "doctor", "--json"], { env: { ...process.env, AGENT_SHIM_HOME: home, [REPORT_PROGRESS_FD_ENV]: reportProgressTarget(REPORT_PROGRESS_FD, process.pid, { release: packageJson.version, build: "" }) }, stdio: ["ignore", "pipe", "ignore", "pipe"] });
    let printed = "";
    const standardOutput = child.stdout;
    if (!(standardOutput instanceof Readable)) {
      throw new Error("the standard output pipe was not opened");
    }
    standardOutput.setEncoding("utf8");
    standardOutput.on("data", (chunk: string) => { printed += chunk; });
    const events: ReportProgress[] = [];
    const progress = child.stdio[REPORT_PROGRESS_FD];
    if (!(progress instanceof Readable)) {
      throw new Error("the progress pipe was not opened");
    }
    progress.setEncoding("utf8");
    progress.on("data", createReportProgressReader((event) => { events.push(event); }));
    await new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
    const probeBoundMs = PROBE_WORKER_START_LIMIT_MS + DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS + PROBE_WAIT_MARGIN_MS;
    expect(events).toContainEqual({ kind: "begin", boundMs: probeBoundMs });
    // The report is preceded by its size line, which gives the byte length of the rest.
    const lineEnd = printed.indexOf("\n");
    expect(printed.slice(0, lineEnd + 1)).toBe(encodeReportSize(Buffer.byteLength(printed.slice(lineEnd + 1))));
    // Every announced step ends before the next begins, and the last one ends.
    expect(events.map((event) => event.kind).join(",")).toMatch(/^(begin,end,)*begin,end$/);
  }, SUITE_TIMEOUT_MS);
});

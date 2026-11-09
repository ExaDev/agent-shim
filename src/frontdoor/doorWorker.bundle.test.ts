import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliBundleOptions } from "../../scripts/bundle-options.mts";
import { CheckReportJsonSchema } from "../checkReportSchema";
import { DoctorRunOutputSchema } from "./controlSchemas";
import { createDoorWorkerHost } from "./doorWorker";
import { enterProcessRole } from "../processRole";

/** The longest a test waits for the real worker to evaluate the bundle and answer: a bound a loaded machine does not reach, since the wait is on the worker's answer and not on a clock. */
const REAL_WORKER_TEST_BUDGET_MS = 120_000;

/** How often the tick counter's timer fires, in milliseconds: far shorter than a worker takes to start and evaluate the bundle. */
const TICK_MS = 5;
/** How long the blocked control holds its thread, in milliseconds. */
const CONTROL_BLOCK_MS = 100;

/** Runs `work` while a timer on this thread counts its ticks, and answers what it returned and how many fell before it settled. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<readonly [T, number]> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, TICK_MS);
  try {
    return [await work(), ticks];
  } finally {
    clearInterval(timer);
  }
}

describe("the tick counter that shows the door's thread free", () => {
  it("counts no tick while the thread is blocked, which is what a report collected on it would give", async () => {
    const [, ticks] = await ticksDuring(async () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, CONTROL_BLOCK_MS);
      return await Promise.resolve("blocked");
    });
    expect(ticks).toBe(0);
  });
});

describe("a door worker running the real bundle", () => {
  let dir: string;
  let code: string;
  let bundlePath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-door-worker-"));
    const outfile = path.join(dir, "cli.cjs");
    bundlePath = outfile;
    await esbuild.build({ ...cliBundleOptions(path.resolve(__dirname, "..", "..")), outfile, logLevel: "silent" });
    // The text is read once, as the door reads it at start; the file goes away before any worker runs.
    code = fs.readFileSync(outfile, "utf8");
    fs.rmSync(outfile);
  }, REAL_WORKER_TEST_BUDGET_MS);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    "collects the doctor and check reports of a configuration with an http provider in threads of the door, whose role refuses to block, from code that no longer exists on disk, and leaves the event loop running",
    async () => {
      const leave = enterProcessRole("frontdoor-supervisor");
      const host = createDoorWorkerHost({ code, facts: { ownExecutablePath: bundlePath, contentSourcePath: bundlePath }, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
      try {
        const root = path.join(dir, "home");
        fs.mkdirSync(path.join(root, "providers"), { recursive: true });
        // A provider whose base URL nothing listens on: collecting its report runs the launcher's synchronous probe, which the door's own role refuses.
        fs.writeFileSync(path.join(root, "providers", "closed.json"), JSON.stringify({ displayName: "Closed", baseUrl: "http://127.0.0.1:1", credential: { sources: [{ literal: "placeholder" }] } }));
        const [doctor, ticks] = await ticksDuring(async () => await host.run("doctor", { root }, (value) => DoctorRunOutputSchema.parse(value)));
        // The door's own thread kept running while the report was collected: timer ticks fell between the request and its answer, which a report collected on this thread cannot allow.
        expect(ticks).toBeGreaterThan(0);
        expect(doctor.findings.some((finding) => finding.section === "provider" && finding.message.includes("could not connect"))).toBe(true);
        const check = await host.run("check", { root, path: dir }, (value) => CheckReportJsonSchema.parse(value));
        // Whatever the machine's own Claude home holds (nothing, on a clean runner), the report came back whole and passed its schema.
        expect(Array.isArray(check.entries)).toBe(true);
      } finally {
        host.stop();
        leave();
      }
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );

  it(
    "carries nothing a credential command printed to standard error out of a worker, in a failure or in a report",
    async () => {
      const host = createDoorWorkerHost({ code, facts: { ownExecutablePath: bundlePath, contentSourcePath: bundlePath }, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
      const root = path.join(dir, "home-secret");
      fs.mkdirSync(path.join(root, "providers"), { recursive: true });
      const marker = "STDERR-MARKER-TOPSECRET";
      fs.writeFileSync(
        path.join(root, "providers", "leaky.json"),
        JSON.stringify({ displayName: "Leaky", baseUrl: "http://127.0.0.1:1", credential: { sources: [{ command: ["/bin/sh", "-c", `echo ${marker} >&2; exit 3`] }] }, catalogue: { tier: "haiku" } }),
      );
      try {
        const seen: string[] = [];
        const refresh = await host.run("refresh-catalogue", { root, name: "leaky", supervisorPid: process.pid, generation: "10000000-0000-4000-8000-000000000001" }, () => undefined).then(
          () => "refreshed",
          (error: unknown) => {
            seen.push(error instanceof Error ? error.message : String(error));
            return "failed";
          },
        );
        expect(refresh).toBe("failed");
        const doctor = await host.run("doctor", { root }, (value) => DoctorRunOutputSchema.parse(value));
        seen.push(JSON.stringify(doctor));
        seen.push(JSON.stringify(await host.run("check", { root, path: dir }, (value) => CheckReportJsonSchema.parse(value))));
        for (const text of seen) {
          expect(text).not.toContain(marker);
        }
        expect(seen[0]).toContain("agent-shim provider models --refresh");
      } finally {
        host.stop();
      }
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );

  it(
    "reports the same path-resolution findings in a worker as the command line does, for a plain-bundle install on PATH, from the facts the door passes",
    async () => {
      // A plain-bundle install: the bundle is an executable named agent-shim in a directory on PATH.
      const bin = path.join(dir, "install", "bin");
      fs.mkdirSync(bin, { recursive: true });
      const installed = path.join(bin, "agent-shim");
      fs.writeFileSync(installed, code, { mode: 0o755 });
      const root = path.join(dir, "home-path");
      fs.mkdirSync(root, { recursive: true });
      const before = { PATH: process.env.PATH, AGENT_SHIM_HOME: process.env.AGENT_SHIM_HOME };
      process.env.PATH = `${bin}${path.delimiter}${before.PATH ?? ""}`;
      process.env.AGENT_SHIM_HOME = root;
      const host = createDoorWorkerHost({ code, facts: { ownExecutablePath: installed, contentSourcePath: installed }, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
      try {
        const cli = spawnSync(process.execPath, [installed, "doctor", "--json"], { env: process.env, encoding: "utf8" });
        const fromCli = DoctorRunOutputSchema.parse(JSON.parse(cli.stdout));
        const fromWorker = await host.run("doctor", { root }, (value) => DoctorRunOutputSchema.parse(value));
        const pathFindings = (report: typeof fromCli): readonly string[] => report.findings.filter((finding) => finding.section === "path-resolution").map((finding) => `${finding.severity}: ${finding.message}`);
        expect(pathFindings(fromCli).length).toBeGreaterThan(0);
        expect(pathFindings(fromWorker)).toEqual(pathFindings(fromCli));
      } finally {
        host.stop();
        for (const [name, value] of Object.entries(before)) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, name);
          } else {
            process.env[name] = value;
          }
        }
      }
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );

  it(
    "runs the command line in the main thread and nothing in a worker that was not given a door task",
    async () => {
      const installed = path.join(dir, "main-thread-cli.cjs");
      fs.writeFileSync(installed, code);
      const main = spawnSync(process.execPath, [installed, "--version"], { encoding: "utf8" });
      expect(main.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
      // The same text evaluated in a worker with no door data (any other worker) prints nothing and ends, instead of running the command line.
      const worker = new Worker(code, { eval: true, argv: ["--version"], stdout: true });
      const printed: Buffer[] = [];
      worker.stdout.on("data", (chunk: Buffer) => {
        printed.push(chunk);
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", resolve);
      });
      expect(exitCode).toBe(0);
      expect(Buffer.concat(printed).toString("utf8")).toBe("");
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );
});

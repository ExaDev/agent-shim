import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cliBundleOptions } from "../../scripts/bundle-options.mts";
import { createCatalogueKeeper } from "../catalogueKeeper";
import { CheckReportJsonSchema } from "../checkReportSchema";
import { collectDoctorReport } from "../doctorReport";
import { buildLayoutPaths } from "../paths";
import { isHttpProvider } from "../config/schema";
import { catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsPath, parseCatalogueCache, parseCatalogueSettings } from "../providerCatalogue";
import { listProviders } from "../providersStore";
import { realFarmFs } from "../realPorts";
import { DoctorRunOutputSchema } from "./controlSchemas";
import { createDoorWorkerHost } from "./doorWorker";
import { writeFrontDoorCodexHome, writeFrontDoorState } from "./state";
import { catalogueStatusPublisher, writeCatalogueFailureReason, writeCatalogueStatus } from "./catalogueState";

/** The status the stand-in upstream answers every read with: a redirect the read never follows. */
const FOUND_STATUS = 302;
/** The status the stand-in listing answers with. */
const OK_STATUS = 200;

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
    "collects the doctor and check reports of a configuration with an http provider in worker threads of the door, from code that no longer exists on disk, and leaves the door's thread running",
    async () => {
      const host = createDoorWorkerHost({ code, facts: { ownExecutablePath: bundlePath, contentSourcePath: bundlePath }, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
      try {
        const root = path.join(dir, "home");
        fs.mkdirSync(path.join(root, "providers"), { recursive: true });
        // A provider whose base URL nothing listens on: collecting its report runs the launcher's synchronous probe, which blocks its thread for the provider's connect bound: the worker's thread, never the door's.
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
        expect(seen[0]).toContain("agent-shim provider models <name> --refresh");
      } finally {
        host.stop();
      }
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );

  it(
    "carries the fact that a catalogue read met a redirect out of a worker, so the keeper records it and doctor warns of it, with nothing of the worker's message",
    async () => {
      const upstream = http.createServer((_request, response) => {
        response.writeHead(FOUND_STATUS, { location: "https://elsewhere.example/models?key=LOCATION-SECRET" });
        response.end();
      });
      await new Promise<void>((resolve) => {
        upstream.listen(0, "127.0.0.1", resolve);
      });
      const address = upstream.address();
      if (address === null || typeof address === "string") {
        throw new Error("the stand-in upstream has no port");
      }
      const root = path.join(dir, "home-redirect");
      const paths = buildLayoutPaths(root);
      fs.mkdirSync(paths.providersDir, { recursive: true });
      fs.writeFileSync(path.join(paths.providersDir, "r.json"), JSON.stringify({ displayName: "R", baseUrl: `http://127.0.0.1:${String(address.port)}`, credential: { sources: [{ literal: "placeholder" }] }, catalogue: { tier: "haiku" } }));
      const supervisor = process.pid;
      const generation = "10000000-0000-4000-8000-000000000001";
      writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: supervisor });
      writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, supervisor, path.join(root, "codex"), generation);
      const host = createDoorWorkerHost({ code, facts: { ownExecutablePath: bundlePath, contentSourcePath: bundlePath }, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
      try {
        const keeper = createCatalogueKeeper({
          supervisorPid: supervisor,
          providers: () => listProviders(paths).map(({ name, provider }) => [name, provider] as const),
          readCache: (name) => (fs.existsSync(catalogueCachePath(paths, name)) ? fs.readFileSync(catalogueCachePath(paths, name), "utf8") : undefined),
          readSettings: (name) => (fs.existsSync(catalogueSettingsPath(paths, name)) ? fs.readFileSync(catalogueSettingsPath(paths, name), "utf8") : undefined),
          credentialFingerprint: () => undefined,
          refresh: async (name) => {
            await host.run("refresh-catalogue", { root, name, supervisorPid: supervisor, generation }, () => undefined);
          },
          nowMs: () => Date.now(),
          log: () => undefined,
          publishStatus: catalogueStatusPublisher(realFarmFs, paths, supervisor, generation, () => Date.now()),
        });
        keeper.tick();
        const failureFile = path.join(paths.catalogueDir, "supervisors", String(supervisor), generation, "failures", "r.json");
        await vi.waitFor(() => {
          expect(fs.existsSync(failureFile)).toBe(true);
        }, { timeout: REAL_WORKER_TEST_BUDGET_MS });
        const recorded = fs.readFileSync(failureFile, "utf8");
        expect(JSON.parse(recorded)).toMatchObject({ redirected: true });
        expect(recorded).not.toContain("LOCATION-SECRET");
        const redirectWarnings = (): readonly unknown[] => collectDoctorReport({ paths, env: { PATH: "" } }).findings.filter((finding) => finding.message.includes("reached a redirect")).map((finding) => finding.subject);
        expect(redirectWarnings()).toEqual(["r"]);
        // What the warning says of a refresh the worker ran: the worker's failure in the door's own words, the error's class and the command that prints the detail, and no URL (the stand-in's address) and nothing of its Location.
        const message = collectDoctorReport({ paths, env: { PATH: "" } }).findings.find((finding) => finding.message.includes("reached a redirect"))?.message ?? "";
        expect(message).toContain("refresh-catalogue failed in its worker: it ended with CatalogueFetchError");
        expect(message).toContain("agent-shim provider models <name> --refresh");
        expect(message).not.toContain(String(address.port));
        expect(message).not.toContain("elsewhere.example");
        // The doctor half of what follows (a fixed base URL clears the warning, a failure file with no settings is ignored) is also pinned over files alone by doctorProviderReachability.test.ts and catalogueFailures.test.ts; here it is run through the real worker for the refresh half.
        // The base URL is fixed to an address that serves a list: the warning is gone at once (the provider's settings differ from the failure's), and the very next tick refreshes it through the worker, not after the retry period.
        const listing = http.createServer((_request, response) => {
          response.writeHead(OK_STATUS, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "served-model" }] }));
        });
        await new Promise<void>((resolve) => {
          listing.listen(0, "127.0.0.1", resolve);
        });
        try {
          const listingAddress = listing.address();
          if (listingAddress === null || typeof listingAddress === "string") {
            throw new Error("the stand-in listing has no port");
          }
          fs.writeFileSync(path.join(paths.providersDir, "r.json"), JSON.stringify({ displayName: "R", baseUrl: `http://127.0.0.1:${String(listingAddress.port)}`, credential: { sources: [{ literal: "placeholder" }] }, catalogue: { tier: "haiku" } }));
          expect(redirectWarnings()).toEqual([]);
          keeper.tick();
          await vi.waitFor(() => {
            expect(fs.existsSync(catalogueCachePath(paths, "r"))).toBe(true);
          }, { timeout: REAL_WORKER_TEST_BUDGET_MS });
          expect(fs.readFileSync(catalogueCachePath(paths, "r"), "utf8")).toContain("served-model");
          await vi.waitFor(() => {
            expect(fs.existsSync(catalogueSettingsPath(paths, "r"))).toBe(true);
          }, { timeout: REAL_WORKER_TEST_BUDGET_MS });
          // The digest file parses to the fingerprint of the provider as it was edited to, which a raw fingerprint written in its place would not.
          const fixed = listProviders(paths).find((entry) => entry.name === "r")?.provider;
          const stored = parseCatalogueCache(fs.readFileSync(catalogueCachePath(paths, "r"), "utf8"));
          const digest = parseCatalogueSettings(fs.readFileSync(catalogueSettingsPath(paths, "r"), "utf8"));
          expect(fixed !== undefined && isHttpProvider(fixed) && digest?.settings === catalogueSettingsFingerprint(fixed) && digest.fetchedAt === stored?.fetchedAt).toBe(true);
          await vi.waitFor(() => {
            expect(fs.existsSync(failureFile)).toBe(false);
          }, { timeout: REAL_WORKER_TEST_BUDGET_MS });
          expect(redirectWarnings()).toEqual([]);
          // Failure files an older door wrote record no settings, so they are ignored whatever they say.
          writeCatalogueStatus(realFarmFs, paths, supervisor, generation, "r", "failed", undefined, Date.now());
          writeCatalogueFailureReason(realFarmFs, paths, supervisor, generation, "r", "no catalogue: status 302", { redirected: true });
          expect(redirectWarnings()).toEqual([]);
        } finally {
          await new Promise<void>((resolve) => {
            listing.closeAllConnections();
            listing.close(() => {
              resolve();
            });
          });
        }
      } finally {
        host.stop();
        await new Promise<void>((resolve) => {
          upstream.closeAllConnections();
          upstream.close(() => {
            resolve();
          });
        });
      }
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );

  it(
    "reports the same path-resolution findings in a worker as the command line does, for a plain-bundle install on PATH, from the facts the door passes",
    async () => {
      // A plain-bundle install as npm lays it out: the bundle is a .cjs file, and a link named agent-shim in a directory on PATH points at it (so the loader reads it as CommonJS whatever the directories above it hold).
      const lib = path.join(dir, "install", "lib");
      const bin = path.join(dir, "install", "bin");
      fs.mkdirSync(lib, { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      const bundle = path.join(lib, "cli.cjs");
      fs.writeFileSync(bundle, code, { mode: 0o755 });
      const installed = path.join(bin, "agent-shim");
      fs.symlinkSync(bundle, installed);
      const root = path.join(dir, "home-path");
      fs.mkdirSync(root, { recursive: true });
      const before = { PATH: process.env.PATH, AGENT_SHIM_HOME: process.env.AGENT_SHIM_HOME };
      process.env.PATH = `${bin}${path.delimiter}${before.PATH ?? ""}`;
      process.env.AGENT_SHIM_HOME = root;
      const host = createDoorWorkerHost({ code, facts: { ownExecutablePath: installed, contentSourcePath: bundle }, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
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

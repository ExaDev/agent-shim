import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliBundleOptions } from "../../scripts/bundle-options.mts";
import { DoctorRunOutputSchema } from "./controlSchemas";
import { createDoorWorkerHost } from "./doorWorker";
import { enterProcessRole } from "../processRole";

/** The longest a test waits for the real worker to evaluate the bundle and answer: a bound a loaded machine does not reach, since the wait is on the worker's answer and not on a clock. */
const REAL_WORKER_TEST_BUDGET_MS = 120_000;

describe("a door worker running the real bundle", () => {
  let dir: string;
  let code: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-door-worker-"));
    const outfile = path.join(dir, "cli.cjs");
    await esbuild.build({ ...cliBundleOptions(path.resolve(__dirname, "..", "..")), outfile, logLevel: "silent" });
    // The text is read once, as the door reads it at start; the file goes away before any worker runs.
    code = fs.readFileSync(outfile, "utf8");
    fs.rmSync(outfile);
  }, REAL_WORKER_TEST_BUDGET_MS);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    "collects the doctor report in a thread of the door while the door's role refuses to block, from code that no longer exists on disk, and leaves the event loop running",
    async () => {
      const leave = enterProcessRole("frontdoor-supervisor");
      const host = createDoorWorkerHost({ code, deadlineMs: { check: REAL_WORKER_TEST_BUDGET_MS, doctor: REAL_WORKER_TEST_BUDGET_MS, "refresh-catalogue": REAL_WORKER_TEST_BUDGET_MS } });
      let ticks = 0;
      let running = true;
      const spin = (): void => {
        if (running) {
          ticks += 1;
          setImmediate(spin);
        }
      };
      spin();
      try {
        const root = path.join(dir, "home");
        fs.mkdirSync(root);
        const report = await host.run("doctor", { root }, (value) => DoctorRunOutputSchema.parse(value));
        expect(Array.isArray(report.findings)).toBe(true);
        // The door's own thread kept running while the report was collected.
        expect(ticks).toBeGreaterThan(1);
      } finally {
        running = false;
        host.stop();
        leave();
      }
    },
    REAL_WORKER_TEST_BUDGET_MS,
  );
});

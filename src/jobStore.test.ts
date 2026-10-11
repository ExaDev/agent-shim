import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Job } from "./config/schema";
import { addJob, readJobs, removeJob } from "./jobStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

const JOB: Job = { target: { identity: "work" }, trigger: { beforeReset: "fiveHour", lead: "1h" }, prompt: "go", cwd: "/work", timeout: "10m" };

let root: string;
let paths: LayoutPaths;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-job-store-"));
  paths = buildLayoutPaths(root);
  fs.writeFileSync(paths.globalConfigFile, `${JSON.stringify({ launch: { trackUsage: true } })}\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("jobStore", () => {
  it("adds and reads a job, keeping the rest of the configuration", () => {
    addJob(paths, "burn", JOB);
    expect(readJobs(paths)).toEqual({ burn: JOB });
    expect(JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8"))).toMatchObject({ launch: { trackUsage: true } });
  });

  it("removes the jobs key altogether with the last job, so an older agent-shim with a strict schema reads the file again", () => {
    addJob(paths, "burn", JOB);
    removeJob(paths, "burn");
    const stored: unknown = JSON.parse(fs.readFileSync(paths.globalConfigFile, "utf8"));
    expect(stored).toEqual({ launch: { trackUsage: true } });
    expect(typeof stored === "object" && stored !== null && "jobs" in stored).toBe(false);
  });

  it("keeps the key while another job remains", () => {
    addJob(paths, "burn", JOB);
    addJob(paths, "digest", JOB);
    removeJob(paths, "burn");
    expect(Object.keys(readJobs(paths))).toEqual(["digest"]);
  });
});

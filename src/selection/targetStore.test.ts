import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import type { UsageRecord } from "../usage/schema";
import { createTargetObservationStore } from "./targetStore";

/** Two latencies whose median is distinct from both, for the seeding assertion. */
const SEED_LATENCY_MS = 120;
const SECOND_SEED_LATENCY_MS = 240;
const MEDIAN_LATENCY_MS = 180;

/** A finished record written to the log for one provider and model. */
function logged(at: string, provider: string, model: string, latencyMs: number): string {
  return JSON.stringify({ schemaVersion: 1, at, provider, model, route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs, durationMs: latencyMs, outcome: "completed" } satisfies UsageRecord);
}

describe("createTargetObservationStore", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "target-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("seeds itself from the recent usage log, so a restarted door ranks by history", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.usageLogDir, { recursive: true });
    fs.writeFileSync(path.join(paths.usageLogDir, "2026-10-17.4242.jsonl"), [logged("2026-10-17T00:00:00.000Z", "z", "glm-5.3", SEED_LATENCY_MS), logged("2026-10-17T00:01:00.000Z", "z", "glm-5.3", SECOND_SEED_LATENCY_MS)].join("\n") + "\n");

    const store = createTargetObservationStore(realFarmFs, paths);

    expect(store.observation("z/glm-5.3")).toMatchObject({ latencyMs: MEDIAN_LATENCY_MS, successRate: 1 });
    expect(store.observation("z/other")).toBeUndefined();
  });

  it("folds each finished record in as it arrives, beside the seeded history", () => {
    const paths = buildLayoutPaths(root);
    fs.mkdirSync(paths.usageLogDir, { recursive: true });
    fs.writeFileSync(path.join(paths.usageLogDir, "2026-10-17.4242.jsonl"), logged("2026-10-17T00:00:00.000Z", "z", "glm-5.3", SEED_LATENCY_MS) + "\n");
    const store = createTargetObservationStore(realFarmFs, paths);

    store.observe({ schemaVersion: 1, at: "2026-10-17T00:02:00.000Z", provider: "z", model: "glm-5.3", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 50, durationMs: 60, outcome: "aborted" });

    expect(store.observation("z/glm-5.3")).toMatchObject({ latencyMs: SEED_LATENCY_MS, successRate: 0.5 });
  });
});

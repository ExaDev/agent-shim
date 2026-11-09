import { describe, expect, it } from "vitest";

import { BLOCKING_STEP_TIMEOUTS_MS, DOOR_WORKER_START_ALLOWANCE_MS, LONGEST_BLOCKING_STEP_MS } from "./doorBounds";
import { CATALOGUE_REFRESH_DEADLINE_MS, CATALOGUE_REFRESH_TIMEOUT_MS, CATALOGUE_WORKER_ALLOWANCE_MS } from "./providerCatalogue";
import { DOOR_WORKER_DEADLINES, DOOR_WORKER_STALL_LIMIT_MS, DOOR_WORKER_WATCHDOG_INTERVAL_MS } from "./frontdoor/doorWorker";
import { PROBE_WAIT_SLICE_MS } from "./frontdoor/probe";

describe("the door worker's bounds", () => {
  it("puts the stall limit above the longest blocking step by the watchdog's own look and the step's start and end, so a step inside its own timeout never looks stalled", () => {
    expect(LONGEST_BLOCKING_STEP_MS).toBe(Math.max(...Object.values(BLOCKING_STEP_TIMEOUTS_MS)));
    for (const timeout of Object.values(BLOCKING_STEP_TIMEOUTS_MS)) {
      expect(DOOR_WORKER_STALL_LIMIT_MS).toBeGreaterThan(timeout + DOOR_WORKER_WATCHDOG_INTERVAL_MS);
    }
    expect(DOOR_WORKER_STALL_LIMIT_MS).toBe(LONGEST_BLOCKING_STEP_MS + DOOR_WORKER_WATCHDOG_INTERVAL_MS + DOOR_WORKER_WATCHDOG_INTERVAL_MS);
  });

  it("beats more often than the watchdog looks and far more often than the stall limit", () => {
    expect(PROBE_WAIT_SLICE_MS).toBeLessThanOrEqual(DOOR_WORKER_WATCHDOG_INTERVAL_MS);
    expect(DOOR_WORKER_WATCHDOG_INTERVAL_MS).toBeLessThan(DOOR_WORKER_STALL_LIMIT_MS);
  });

  it("lets a catalogue refresh run for its fetch, its worker's start and its credential and version steps, and a report for longer than any one step", () => {
    expect(CATALOGUE_REFRESH_DEADLINE_MS).toBe(CATALOGUE_REFRESH_TIMEOUT_MS + CATALOGUE_WORKER_ALLOWANCE_MS);
    expect(CATALOGUE_WORKER_ALLOWANCE_MS).toBe(DOOR_WORKER_START_ALLOWANCE_MS + BLOCKING_STEP_TIMEOUTS_MS.credentialCommand + BLOCKING_STEP_TIMEOUTS_MS.codexVersion);
    expect(DOOR_WORKER_DEADLINES["refresh-catalogue"]).toBe(CATALOGUE_REFRESH_DEADLINE_MS);
    expect(DOOR_WORKER_DEADLINES.doctor).toBeGreaterThan(DOOR_WORKER_STALL_LIMIT_MS);
    expect(DOOR_WORKER_DEADLINES.check).toBeGreaterThan(DOOR_WORKER_STALL_LIMIT_MS);
  });
});

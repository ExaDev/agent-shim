import { describe, expect, it } from "vitest";

import { createFakeFarmFs, DAY_MS, paths } from "../test-helpers";
import { segmentName } from "../usage/read";
import { USAGE_SCHEMA_VERSION, type UsageRecord } from "../usage/schema";
import { readDoorCostUsd } from "./doorCost";

const LOG_DIR = paths.usageLogDir;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const PRICES = { "z/glm-5.3": { input: 1, output: 1 } };
const WRITER_PID = 7;

function line(epochMs: number, conversationId: string, tokens: number, launchSessionId = "launch-1"): string {
  const record: UsageRecord = {
    schemaVersion: USAGE_SCHEMA_VERSION,
    at: new Date(epochMs).toISOString(),
    provider: "z",
    sessionId: launchSessionId,
    clientSessionId: conversationId,
    route: "passthrough",
    method: "POST",
    endpoint: "/v1/messages",
    model: "glm-5.3",
    status: 200,
    latencyMs: 1,
    durationMs: 1,
    outcome: "completed",
    usage: { inputTokens: tokens },
  };
  return `${JSON.stringify(record)}\n`;
}

const MILLION = 1_000_000;

describe("readDoorCostUsd", () => {
  const fs = createFakeFarmFs({
    [`${LOG_DIR}/${segmentName("2026-10-18", WRITER_PID)}`]: line(NOW - DAY_MS, "mine", MILLION),
    [`${LOG_DIR}/${segmentName("2026-10-19", WRITER_PID)}`]: line(NOW - HOUR_MS, "mine", MILLION) + line(NOW - HOUR_MS, "theirs", MILLION),
  });
  const params = { fs, logDir: LOG_DIR, prices: PRICES, conversationId: "mine", nowMs: NOW };

  it("prices only the requests of the session asked about", () => {
    expect(readDoorCostUsd({ ...params, sessionDurationMs: undefined })).toBeCloseTo(2);
  });

  it("reads the log from the UTC day the session began on, so an earlier day's records are not the session's", () => {
    expect(readDoorCostUsd({ ...params, sessionDurationMs: 2 * HOUR_MS })).toBeCloseTo(1);
    expect(readDoorCostUsd({ ...params, sessionDurationMs: DAY_MS })).toBeCloseTo(2);
  });

  it("keeps the conversations of one launch apart, as when a conversation is cleared and a new one starts", () => {
    const launch = createFakeFarmFs({
      [`${LOG_DIR}/${segmentName("2026-10-19", WRITER_PID)}`]: line(NOW - 2 * HOUR_MS, "before-clear", MILLION) + line(NOW - HOUR_MS, "after-clear", MILLION) + line(NOW - HOUR_MS / 2, "after-clear", MILLION),
    });
    const both = { ...params, fs: launch };
    expect(readDoorCostUsd({ ...both, conversationId: "before-clear", sessionDurationMs: undefined })).toBeCloseTo(1);
    expect(readDoorCostUsd({ ...both, conversationId: "after-clear", sessionDurationMs: undefined })).toBeCloseTo(2);
  });

  it("states nothing for a session the door served no priced request for", () => {
    expect(readDoorCostUsd({ ...params, conversationId: "none", sessionDurationMs: undefined })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { createFakeFarmFs, fakeLog } from "../test-helpers";
import { createLifecycleRecorder } from "./lifecycle";

const SESSION = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-11-07T04:12:28.825Z");

describe("supervisor lifecycle diagnostics", () => {
  it("writes only allowed metadata to a private per-supervisor log", () => {
    const fs = createFakeFarmFs({});
    const log = fakeLog();
    const record = createLifecycleRecorder({ fs, logsDir: "/state/logs", fileId: "fixture", sessionId: SESSION, supervisorPid: 100, supervisorVersion: "11.87.3", entrypointSha256AtStart: "abc", now: () => NOW, log });
    record({ kind: "child_exited", childPid: 200, status: null, signal: "SIGTERM", spawnFailed: false });
    const text = fs.readFileUtf8("/state/logs/supervisor/fixture.jsonl");
    expect(text).toBeDefined();
    expect(JSON.parse(text ?? "")).toEqual({ schemaVersion: 1, at: "2026-11-07T04:12:28.825Z", sessionId: SESSION, supervisorPid: 100, supervisorVersion: "11.87.3", entrypointSha256AtStart: "abc", kind: "child_exited", childPid: 200, status: null, signal: "SIGTERM", spawnFailed: false });
    expect(log.warns).toEqual([]);
  });

  it("reports a storage failure once without leaking an error or stopping the session", () => {
    const fs = createFakeFarmFs({});
    const log = fakeLog();
    const record = createLifecycleRecorder({ fs: { ...fs, appendFilePrivate: () => { throw new Error("private credential"); } }, logsDir: "/state/logs", fileId: "fixture", sessionId: SESSION, supervisorPid: 100, supervisorVersion: "11.87.3", entrypointSha256AtStart: null, now: () => NOW, log });
    record({ kind: "departure", reason: "quota" });
    record({ kind: "departure", reason: "quota" });
    expect(log.warns).toEqual(["agent-shim: could not record supervisor lifecycle diagnostics"]);
  });
});

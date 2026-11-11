import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DoorWorkerMessage } from "./doorWorkerProtocol";
import { buildLayoutPaths } from "../paths";
import { CatalogueFetchError } from "../providerCatalogue";

const GENERATION = "10000000-0000-4000-8000-000000000001";
const SUPERVISOR_PID = 123;

const mocks = vi.hoisted(() => {
  const state: { posted: unknown[]; workerData: unknown; refresh: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn<() => unknown>>; doctor: ReturnType<typeof vi.fn<() => unknown>> } = { posted: [], workerData: undefined, refresh: vi.fn(), check: vi.fn<() => unknown>(), doctor: vi.fn<() => unknown>() };
  return state;
});

vi.mock("node:worker_threads", () => ({
  get parentPort() {
    return { postMessage: (message: unknown) => { mocks.posted.push(message); } };
  },
  get workerData() {
    return mocks.workerData;
  },
}));
vi.mock("../realCatalogueRefresh", () => ({ refreshCatalogueForReal: mocks.refresh }));
vi.mock("../checkReport", () => ({ collectCheckReport: mocks.check, checkReportToJson: (report: unknown) => ({ json: report }) }));
vi.mock("../doctorReport", () => ({ collectDoctorReport: mocks.doctor }));

/** The facts the door passes its workers about its own process. */
const FACTS = { ownExecutablePath: "/door/bin/agent-shim", contentSourcePath: "/door/lib/cli.cjs" };

/** What the worker posts for a task asked of it. */
async function postedFor(task: string, input: unknown, heartbeat: Readonly<SharedArrayBuffer> = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)): Promise<DoorWorkerMessage> {
  mocks.workerData = { doorWorker: { task, input, facts: FACTS, heartbeat } };
  mocks.posted.length = 0;
  const { runDoorWorkerEntry } = await import("./doorWorkerEntry");
  await runDoorWorkerEntry();
  expect(mocks.posted).toHaveLength(1);
  return mocks.posted[0] as DoorWorkerMessage;
}

/** `error` with `fields` defined on it, as a thrown error of another library carries a code. */
function errorWith(error: Error, fields: Readonly<Record<string, string>>): Error {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(error, key, { value, enumerable: true, configurable: true });
  }
  return error;
}

describe("the door worker entry", () => {
  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.check.mockReset();
    mocks.doctor.mockReset();
  });

  it("hands the supervisor and its generation to the catalogue refresh, so a refresh for a door that was replaced is refused there", async () => {
    const message = await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION });
    expect(message).toEqual({ kind: "done", value: undefined });
    expect(mocks.refresh).toHaveBeenCalledWith(buildLayoutPaths("/shim"), "c", process.env, SUPERVISOR_PID, GENERATION);
  });

  it("answers failed with the error's class name and code and never its message, which may hold what a credential command printed", async () => {
    mocks.refresh.mockRejectedValue(errorWith(new TypeError("credential command failed: TOPSECRET"), { code: "ECONNRESET" }));
    const message = await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION });
    expect(message).toEqual({ kind: "failed", name: "TypeError", code: "ECONNRESET" });
    expect(JSON.stringify(message)).not.toContain("TOPSECRET");
  });

  it("posts that a catalogue read met a redirect as a boolean beside the class name, whichever message the error has, and no other field of the error", async () => {
    mocks.refresh.mockRejectedValue(errorWith(new CatalogueFetchError("no catalogue from https://u:TOPSECRET@x.example: status 308", { redirected: true }), { token: "TOPSECRET" }));
    const message = await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION });
    expect(message).toEqual({ kind: "failed", name: "CatalogueFetchError", redirected: true });
    mocks.refresh.mockRejectedValue(new CatalogueFetchError("no catalogue: status 500"));
    expect(await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION })).toEqual({ kind: "failed", name: "CatalogueFetchError" });
  });

  it("posts no redirect flag for a thrown value that is not an error, whatever it holds", async () => {
    mocks.refresh.mockRejectedValue({ redirected: true, name: "CatalogueFetchError" });
    expect(await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION })).toEqual({ kind: "failed", name: "Error" });
  });

  it("posts a generic class name for an error whose name or code is not a short identifier", async () => {
    mocks.refresh.mockRejectedValue(errorWith(new Error("x"), { name: "my secret name!", code: "not an identifier" }));
    expect(await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION })).toEqual({ kind: "failed", name: "Error" });
  });

  it("refuses an input that does not fit its task, before any work", async () => {
    const message = await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: -1, generation: "not-a-uuid" });
    expect(message.kind).toBe("failed");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("collects the check report for the directory and identity asked, against the state root it was given", async () => {
    mocks.check.mockReturnValue("the report");
    expect(await postedFor("check", { root: "/shim", path: "/work", identity: "work" })).toEqual({ kind: "done", value: { json: "the report" } });
    expect(mocks.check).toHaveBeenCalledWith({ paths: buildLayoutPaths("/shim"), cwd: "/work", identity: "work", env: process.env });
  });

  it("collects the doctor report as ok and its findings", async () => {
    mocks.doctor.mockReturnValue({ ok: false, findings: [{ section: "provider", severity: "fail", message: "m" }], extra: "dropped" });
    expect(await postedFor("doctor", { root: "/shim" })).toEqual({ kind: "done", value: { ok: false, findings: [{ section: "provider", severity: "fail", message: "m" }] } });
    expect(mocks.doctor).toHaveBeenCalledWith({ paths: buildLayoutPaths("/shim"), env: process.env });
  });

  it("answers a task it does not know as a failure and runs nothing", async () => {
    expect(await postedFor("nonexistent", { root: "/shim" })).toMatchObject({ kind: "failed" });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.doctor).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("beats the heartbeat for every blocking step the task takes, and adopts the door's executable paths for the readers of them", async () => {
    const heartbeat = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const { realOwnExecutablePath, realContentSourcePath, realSleepSync } = await import("../realPorts");
    mocks.doctor.mockImplementation(function takeTwoBlockingSteps() {
      realSleepSync(0);
      realSleepSync(0);
      return { ok: true, findings: [] };
    });
    await postedFor("doctor", { root: "/shim" }, heartbeat);
    expect(Atomics.load(new Int32Array(heartbeat), 0)).toBeGreaterThanOrEqual(2);
    expect(realOwnExecutablePath()).toBe(FACTS.ownExecutablePath);
    expect(realContentSourcePath()).toBe(FACTS.contentSourcePath);
  });
});

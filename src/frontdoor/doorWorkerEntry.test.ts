import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DoorWorkerMessage } from "./doorWorkerProtocol";
import { buildLayoutPaths } from "../paths";

const GENERATION = "10000000-0000-4000-8000-000000000001";
const SUPERVISOR_PID = 123;

const mocks = vi.hoisted(() => {
  const state: { posted: unknown[]; workerData: unknown; refresh: ReturnType<typeof vi.fn> } = { posted: [], workerData: undefined, refresh: vi.fn() };
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

/** What the worker posts for a task asked of it. */
async function postedFor(task: string, input: unknown): Promise<DoorWorkerMessage> {
  mocks.workerData = { doorWorker: { task, input, heartbeat: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) } };
  mocks.posted.length = 0;
  const { runDoorWorkerEntry } = await import("./doorWorkerEntry");
  await runDoorWorkerEntry();
  expect(mocks.posted).toHaveLength(1);
  return mocks.posted[0] as DoorWorkerMessage;
}

describe("the door worker entry", () => {
  beforeEach(() => {
    mocks.refresh.mockReset().mockResolvedValue(undefined);
  });

  it("hands the supervisor and its generation to the catalogue refresh, so a refresh for a door that was replaced is refused there", async () => {
    const message = await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION });
    expect(message).toEqual({ kind: "done", value: undefined });
    expect(mocks.refresh).toHaveBeenCalledWith(buildLayoutPaths("/shim"), "c", process.env, SUPERVISOR_PID, GENERATION);
  });

  it("answers failed with the error's name and message when the task throws", async () => {
    mocks.refresh.mockRejectedValue(new TypeError("front door changed during catalogue refresh"));
    expect(await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: SUPERVISOR_PID, generation: GENERATION })).toEqual({ kind: "failed", name: "TypeError", message: "front door changed during catalogue refresh" });
  });

  it("refuses an input that does not fit its task, before any work", async () => {
    const message = await postedFor("refresh-catalogue", { root: "/shim", name: "c", supervisorPid: -1, generation: "not-a-uuid" });
    expect(message.kind).toBe("failed");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

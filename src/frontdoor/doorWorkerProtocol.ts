import type { CheckReportJson } from "../checkReportSchema";
import type { DoctorRunOutputSchema } from "./controlSchemas";

import { z } from "zod";

/** What each task takes, read by the worker at the boundary: the door sends structured clone, and the worker trusts nothing that arrives. */
export const doorWorkerInputSchemas = {
  /** `agent-shim check` for `path` as `identity` (the identity a launch there would resolve when absent). */
  check: z.strictObject({ root: z.string().min(1), path: z.string().min(1), identity: z.string().min(1).optional() }),
  /** `agent-shim doctor`. */
  doctor: z.strictObject({ root: z.string().min(1) }),
  /** Fetch and store one provider's model catalogue for the door generation that asked. */
  "refresh-catalogue": z.strictObject({ root: z.string().min(1), name: z.string().min(1), supervisorPid: z.int().positive(), generation: z.uuid() }),
} as const;

/**
 * The tasks the front door runs in a worker thread instead of its own event loop, each with the input it takes and the output it returns. A task is named, never a function or a path: the worker is given the code the door itself loaded, so the table is the whole contract between the door and the worker.
 */
export interface DoorWorkerTasks {
  readonly check: { readonly input: z.infer<typeof doorWorkerInputSchemas.check>; readonly output: CheckReportJson };
  readonly doctor: { readonly input: z.infer<typeof doorWorkerInputSchemas.doctor>; readonly output: z.infer<typeof DoctorRunOutputSchema> };
  readonly "refresh-catalogue": { readonly input: z.infer<typeof doorWorkerInputSchemas["refresh-catalogue"]>; readonly output: undefined };
}

/** The name of a task the door runs in a worker. */
export type DoorWorkerTaskName = keyof DoorWorkerTasks;

/** What a worker is started with: the task to run, its input and the shared heartbeat counter the door's watchdog reads. */
export interface DoorWorkerData {
  readonly doorWorker: {
    readonly task: DoorWorkerTaskName;
    readonly input: unknown;
    readonly heartbeat: SharedArrayBuffer;
  };
}

/** What a worker posts once, when its task ends: the value, or why it failed. */
export type DoorWorkerMessage = { readonly kind: "done"; readonly value: unknown } | { readonly kind: "failed"; readonly name: string; readonly message: string };

/** Whether `value` is the data a door worker is started with. */
export function isDoorWorkerData(value: unknown): value is DoorWorkerData {
  return typeof value === "object" && value !== null && "doorWorker" in value && typeof value.doorWorker === "object" && value.doorWorker !== null && "task" in value.doorWorker && "heartbeat" in value.doorWorker && value.doorWorker.heartbeat instanceof SharedArrayBuffer;
}

/** Whether `value` is a message a door worker posts. */
export function isDoorWorkerMessage(value: unknown): value is DoorWorkerMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  return (value.kind === "done" && "value" in value) || (value.kind === "failed" && "name" in value && typeof value.name === "string" && "message" in value && typeof value.message === "string");
}

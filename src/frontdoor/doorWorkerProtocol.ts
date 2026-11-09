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

/**
 * What a worker posts once, when its task ends: the value, or that it failed. A failure carries the error's class name and, when it has one, its short `code` (ENOENT, ETIMEDOUT), and nothing else: an error's message can hold what a credential command printed to its standard error, and the door must not carry that to a caller of its API or into its log. The detail is what `agent-shim doctor` and `agent-shim check` print from a shell.
 */
export type DoorWorkerMessage = { readonly kind: "done"; readonly value: unknown } | { readonly kind: "failed"; readonly name: string; readonly code?: string };

/** An error class name or code as a worker may post it: a short identifier, which cannot carry a message. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** Whether `value` is a short identifier. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

/** Whether `value` is the data a door worker is started with. */
export function isDoorWorkerData(value: unknown): value is DoorWorkerData {
  return typeof value === "object" && value !== null && "doorWorker" in value && typeof value.doorWorker === "object" && value.doorWorker !== null && "task" in value.doorWorker && "heartbeat" in value.doorWorker && value.doorWorker.heartbeat instanceof SharedArrayBuffer;
}

/** Whether `value` is a message a door worker posts, of exactly the shape `DoorWorkerMessage` allows. */
export function isDoorWorkerMessage(value: unknown): value is DoorWorkerMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  if (value.kind === "done") {
    return "value" in value && Object.keys(value).length === 2;
  }
  return value.kind === "failed" && "name" in value && isIdentifier(value.name) && (!("code" in value) || isIdentifier(value.code)) && Object.keys(value).every((key) => key === "kind" || key === "name" || key === "code");
}

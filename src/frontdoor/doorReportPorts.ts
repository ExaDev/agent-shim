import { CheckReportJsonSchema } from "../checkReportSchema";
import { DoctorRunOutputSchema } from "./controlSchemas";
import type { ControlApiDeps } from "./controlApi";
import type { DoorWorkerHost } from "./doorWorker";

/**
 * The `check.run` and `doctor.run` dependencies of the front door: each report is collected by a worker thread of the door (`doorWorker.ts`), off the event loop that answers every session, and the worker's answer is validated against the report's schema before it is returned. `root` is the state root the door serves, handed to the worker so it reads the same configuration.
 */
export function doorReportPorts(host: DoorWorkerHost, root: string): Pick<ControlApiDeps, "checkReport" | "doctorReport"> {
  return {
    checkReport: async (path, identity, signal) => await host.run("check", { root, path, ...(identity === undefined ? {} : { identity }) }, (value) => CheckReportJsonSchema.parse(value), signal),
    doctorReport: async (signal) => await host.run("doctor", { root }, (value) => DoctorRunOutputSchema.parse(value), signal),
  };
}

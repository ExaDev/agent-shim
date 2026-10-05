import path from "node:path";

import { z } from "zod";

import { DOCTOR_SECTIONS, DOCTOR_SEVERITIES } from "../doctorReport";
import { UsageSnapshotSchema } from "../usage/schema";
import { FrontDoorStateSchema } from "./state";

/**
 * The Zod schemas of the door's general control plane: the usage snapshots a remote consumer reads, the front door's own status and session registry, the check report over a path, and the doctor report, each one the input or output of a procedure in `controlApi.ts`. Like `rcSchemas.ts` this module is a plain Zod leaf (nothing here imports oRPC), and every shape it asserts is one the implementation already defines: the usage snapshot and front-door state schemas are the store's and the registry's own, the check report's is `checkReportSchema.ts`'s (`CheckReportJsonSchema`, imported straight by the procedure), and the doctor vocabulary is `doctorReport.ts`'s own, so contract and behaviour share one source and a drift fails the procedures' own validation rather than shipping silently.
 */

/** Every usage snapshot on this machine, one per identity that has routed a request through the door. */
export const UsageListOutputSchema = z.strictObject({ snapshots: z.readonly(z.array(UsageSnapshotSchema)) });

/** The windows query: one identity by name, and optionally the provider whose windows are wanted (`anthropic` for an OAuth session, the default). */
export const UsageWindowsInputSchema = z.strictObject({
  identity: z.string().min(1),
  provider: z.string().min(1).optional(),
});

/** One quota window as it stands now, exactly as `effectiveWindow` reads a recorded one: a window whose reset has passed is empty and carries no status, so every consumer agrees on what an old observation still means. */
export const EffectiveWindowSchema = z.strictObject({
  /** True when the window's reset time has passed, so the recorded observation describes a window that no longer exists. */
  reset: z.boolean(),
  /** The fraction used: 0 for a reset window, otherwise what was last observed, absent when none was reported. */
  utilization: z.number().optional(),
  /** The reset instant, for a window that has not reset yet and reported one. */
  resetsAtMs: z.number().optional(),
  /** The window's own status, for a window that has not reset yet. */
  status: z.string().optional(),
});

/** One identity's effective windows for a provider: what the snapshot last observed, read at the door's own clock. Absent fields mean the snapshot observed nothing there. */
export const UsageWindowsOutputSchema = z.strictObject({
  identity: z.string(),
  provider: z.string(),
  /** When the rate-limit state the windows come from was observed. */
  observedAt: z.iso.datetime().optional(),
  fiveHour: EffectiveWindowSchema.optional(),
  sevenDay: EffectiveWindowSchema.optional(),
});

/** One registered launch as the status surfaces list it: the launcher's pid and start time plus whether it is still running, never the session's capability token. */
export const FrontDoorSessionStatusSchema = z.strictObject({
  pid: z.int().positive(),
  startedAt: z.number(),
  alive: z.boolean(),
});

/** The headroom daemon's socket as the door's hop reads it: the path it may dial, or the reason it must not. The two never appear together. */
export const HeadroomSocketTargetSchema = z.union([z.strictObject({ socketPath: z.string() }), z.strictObject({ refused: z.string() })]);

/** Everything the door's status procedure returns: the supervisor state file's own record, its liveness, the registered launches, the headroom hop, and the door's log. */
export const FrontDoorStatusOutputSchema = z.strictObject({
  state: FrontDoorStateSchema,
  supervisorAlive: z.boolean(),
  sessions: z.readonly(z.array(FrontDoorSessionStatusSchema)),
  headroomSocket: HeadroomSocketTargetSchema.optional(),
  logPath: z.string(),
  logExists: z.boolean(),
});

/** The session registry's live launches, as the door's sessions procedure returns them. */
export const FrontDoorSessionsOutputSchema = z.strictObject({ sessions: z.readonly(z.array(FrontDoorSessionStatusSchema)) });

/** The check query: one absolute directory (the door has no working directory of the caller's to resolve a relative path against, so a relative one is refused rather than silently resolved somewhere else), and optionally the identity to check as `--identity` names it. */
export const CheckRunInputSchema = z
  .strictObject({
    path: z.string().min(1),
    identity: z.string().min(1).optional(),
  })
  .refine((input) => path.isAbsolute(input.path), { message: "path must be absolute: the door cannot resolve a relative path against the caller's working directory" });

/** One line of the doctor report: the section it belongs to, its severity, its message, and the identity/profile/rule it is about when there is one. */
export const DoctorFindingSchema = z.strictObject({
  section: z.enum(DOCTOR_SECTIONS),
  subject: z.string().optional(),
  severity: z.enum(DOCTOR_SEVERITIES),
  message: z.string(),
});

/** The doctor report as data: every finding and whether any of them failed. */
export const DoctorRunOutputSchema = z.strictObject({
  /** False exactly when any finding is a `fail`; a `warn` never fails the report on its own. */
  ok: z.boolean(),
  findings: z.readonly(z.array(DoctorFindingSchema)),
});

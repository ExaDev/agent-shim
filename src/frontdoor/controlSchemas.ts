import path from "node:path";

import { z } from "zod";

import { DOCTOR_SECTIONS, DOCTOR_SEVERITIES } from "../doctorReport";
import { UsageSnapshotSchema } from "../usage/schema";
import { RcLiveRateLimitSchema } from "./rcSchemas";
import { FrontDoorStateSchema } from "./state";

/**
 * The Zod schemas of the door's general control plane: the usage snapshots a remote consumer reads, the live rate-limit observations the event backbone files, the front door's own status and session registry, the check report over a path, and the doctor report, each one the input or output of a procedure in `controlApi.ts`. Like `rcSchemas.ts` this module is a plain Zod leaf (nothing here imports oRPC), and every shape it asserts is one the implementation already defines: the usage snapshot and front-door state schemas are the store's and the registry's own, the check report's is `checkReportSchema.ts`'s (`CheckReportJsonSchema`, imported straight by the procedure), and the doctor vocabulary is `doctorReport.ts`'s own, so contract and behaviour share one source and a drift fails the procedures' own validation rather than shipping silently.
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

/** The live quota read's answer: every per-session rate-limit observation the door's event backbone has filed, oldest-observed first, and the freshest one across every session. */
export const UsageLiveOutputSchema = z.strictObject({
  /** The freshest observation the door holds, never narrowed by the read's session filter because it is the door's single latest statement of the account's quota; absent while no rate_limit_event has been filed at all. */
  latest: RcLiveRateLimitSchema.optional(),
  /** One observation per session whose stream has filed a rate_limit_event this door generation. */
  sessions: z.readonly(z.array(RcLiveRateLimitSchema)),
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

/** The pool-pick query: one pool by name and one absolute directory, the same two facts a launch from that directory would rank the pool against (a sticky pick is directory-scoped), so a relative path is refused for the same reason the check query refuses one. */
export const PoolPickInputSchema = z
  .strictObject({
    pool: z.string().min(1),
    path: z.string().min(1),
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

/** The restart's answer: the pid of the door being replaced, which is the only part of the new generation the caller cannot yet know. The caller reopens its client from the state root once the door's supervisor pid differs from this one, because the replacement mints its own control token. */
export const FrontDoorRestartOutputSchema = z.strictObject({
  action: z.literal("restarting"),
  previousPid: z.int().positive(),
});

/** `update --check`'s report: the running version, the latest release, and whether they differ (`available`) or match (`current`). A check never installs, so `updated` is not an answer here. */
export const UpdateCheckOutputSchema = z.strictObject({
  current: z.string(),
  latest: z.string(),
  action: z.enum(["current", "available", "updated"]),
});

/** The Sign in with ChatGPT login's state as `codex status` reports it: no sign-in yet, signed in (with who, whether the plan scope was granted, and when the access token lapses), or a file that cannot be read. */
export const CodexSignInSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("signed-in"), email: z.string().optional(), planScope: z.boolean(), accessTokenExpiresAt: z.number() }),
  z.strictObject({ state: z.literal("unreadable"), message: z.string() }),
]);

/** What `codex status` reports about the translation's sign-in and the codex providers the machine defines; the door's own status and sessions are `frontdoor.status` and `frontdoor.sessions`. */
export const CodexStatusOutputSchema = z.strictObject({
  signIn: CodexSignInSchema,
  codexProviders: z.readonly(z.array(z.string())),
});

/** `codex logout`'s result: whether there was a login to remove, and whether the issuer was told to revoke it (a failed revocation still removes the login here). */
export const CodexLogoutOutputSchema = z.strictObject({
  hadGrant: z.boolean(),
  revoked: z.boolean(),
});

import { createORPCClient, ORPCError } from "@orpc/client";
import type { RouterClient } from "@orpc/server";

import { type CheckReport, checkReportToJson } from "../checkReport";
import { CheckReportJsonSchema } from "../checkReportSchema";
import type { DoctorReport } from "../doctorReport";
import { ANTHROPIC_PROVIDER } from "../usage/middleware";
import { effectiveWindow } from "../usage/preflight";
import type { UsageSnapshot } from "../usage/schema";
import {
  CheckRunInputSchema,
  DoctorRunOutputSchema,
  FrontDoorSessionsOutputSchema,
  FrontDoorStatusOutputSchema,
  UsageListOutputSchema,
  UsageLiveOutputSchema,
  UsageWindowsInputSchema,
  UsageWindowsOutputSchema,
} from "./controlSchemas";
import { createEventsApiRouter, type DoorEventsApiDeps } from "./eventsApi";
import { createRcApiRouter, doorApiAuth, doorApiNodeHandlerOf, frontDoorApiLink, type RcApiDeps } from "./rcApi";
import { RcSessionQuerySchema, type RcLiveRateLimit } from "./rcSchemas";
import type { RcSessionSummary } from "./rcSessions";
import { rcSessionNotObservedMessage } from "./rcWrites";
import type { FrontDoorStatus } from "./status";
import type { PrePipelineApi } from "./server";

/**
 * The door's general control plane as a typed oRPC API: the read-only surfaces a programmatic consumer (automation, a dashboard, another of this user's tools) needs beyond Remote Control, one router per domain, every procedure behind the same per-generation control token as `rc.*` and validating through the Zod schemas of `controlSchemas.ts`.
 *
 * - `usage.*` reads the per-identity usage snapshots the door's own middleware writes, reads a provider's quota windows the way every in-process consumer does (`effectiveWindow`: a window past its reset is empty and carries no status), and reads the live rate-limit observations the event backbone files off the Remote Control client stream (`live`: per-session latest state, exactly as fresh as the last turn a session completed, never a timer's derivation of it).
 * - `frontdoor.*` returns what `agent-shim frontdoor status` returns: the supervisor state, its liveness, the session registry's launches and the headroom hop.
 * - `check.run` and `doctor.run` return the reports `agent-shim check` and `agent-shim doctor` print, as data, `check.run` parameterised by an absolute directory path.
 *
 * Read-only by design: identity, configuration-profile, provider, pool and directory-rule management stay CLI-side, and adding writes over this mount is a decision of its own rather than a gap here. `createDoorApiNodeHandler` mounts these routers and the door-wide `events.subscribe` router beside the Remote Control router on the one prefix the provider listener already serves, so a consumer dials one address with one token for the whole door.
 */

/** Everything the control-plane procedures need, injected so they serve against fakes in tests exactly as the door's real wiring serves against this machine. */
export interface ControlApiDeps {
  /** This generation's control token: the same value the Remote Control router checks, since one mount serves both. */
  readonly expectedToken: string;
  /** Every identity's usage snapshot, as `listUsageSnapshots` reads them. */
  readonly usageSnapshots: () => readonly UsageSnapshot[];
  /** One identity's usage snapshot, as `readUsageSnapshot` reads it: undefined when the identity has none yet. */
  readonly usageSnapshotOf: (identity: string) => UsageSnapshot | undefined;
  /** The observed Remote Control sessions as the tracker lists them, so the live quota read can tell a session that never crossed this door from one that has completed no turn through it yet. */
  readonly list: () => readonly RcSessionSummary[];
  /** The live rate-limit observations the door's event backbone has filed, as the live usage state reads them, filtered to one session when named. */
  readonly liveRateLimits: (sessionId?: string) => readonly RcLiveRateLimit[];
  /** The freshest live rate-limit observation across every session, as the live usage state reads it: undefined while no rate_limit_event has been filed at all. */
  readonly latestRateLimit: () => RcLiveRateLimit | undefined;
  /** The clock the window semantics read a recorded window at. */
  readonly now: () => number;
  /** The door's read-only status, as `collectFrontDoorStatus` collects it. */
  readonly frontDoorStatus: () => FrontDoorStatus;
  /** The check report for one directory, as `collectCheckReport` collects it. */
  readonly checkReport: (path: string, identity?: string) => CheckReport;
  /** The doctor report, as `collectDoctorReport` collects it. */
  readonly doctorReport: () => DoctorReport;
}

/** Builds the control-plane routers: one procedure per read, every one behind the control-token middleware. */
export function createControlApiRouter(deps: ControlApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    usage: {
      list: authed.output(UsageListOutputSchema).handler(() => ({ snapshots: deps.usageSnapshots() })),
      effectiveWindow: authed
        .input(UsageWindowsInputSchema)
        .output(UsageWindowsOutputSchema)
        .handler(({ input }) => {
          const snapshot = deps.usageSnapshotOf(input.identity);
          // An identity with no snapshot is refused rather than answered as empty, so a mistyped name never reads as "observed, nothing used" (the Remote Control router's own rule for a named session).
          if (snapshot === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `identity ${input.identity} has no usage snapshot yet, so no quota window has been observed for it` });
          }
          const provider = input.provider ?? ANTHROPIC_PROVIDER;
          const rateLimit = snapshot.providers[provider]?.rateLimit;
          const unified = rateLimit?.unified;
          // One clock reading serves both windows, so a pair returned together describes the same instant.
          const now = deps.now();
          return {
            identity: snapshot.identity,
            provider,
            ...(rateLimit === undefined ? {} : { observedAt: rateLimit.observedAt }),
            ...(unified?.fiveHour === undefined ? {} : { fiveHour: effectiveWindow(unified.fiveHour, now) }),
            ...(unified?.sevenDay === undefined ? {} : { sevenDay: effectiveWindow(unified.sevenDay, now) }),
          };
        }),
      live: authed
        .input(RcSessionQuerySchema)
        .output(UsageLiveOutputSchema)
        .handler(({ input }) => {
          const sessions = deps.liveRateLimits(input.session);
          if (input.session !== undefined && sessions.length === 0) {
            // The same refusal rule the snapshot reads keep: a named session answered as empty would read as "observed, no quota", so the two causes are named instead, using the tracker's list to tell them apart.
            if (deps.list().some((session) => session.id === input.session)) {
              throw new ORPCError("NOT_FOUND", { message: `session ${input.session} has filed no rate_limit_event on its stream yet: the worker emits one only once a turn has completed, so retry after this session's next turn` });
            }
            throw new ORPCError("NOT_FOUND", { message: rcSessionNotObservedMessage(input.session) });
          }
          return { latest: deps.latestRateLimit(), sessions };
        }),
    },
    frontdoor: {
      status: authed.output(FrontDoorStatusOutputSchema).handler(() => deps.frontDoorStatus()),
      sessions: authed.output(FrontDoorSessionsOutputSchema).handler(() => ({ sessions: deps.frontDoorStatus().sessions })),
    },
    check: {
      // The report's own JSON shape is the contract (the same one `check --json` prints and `checkReportSchema.ts` defines), so the procedure returns exactly that conversion.
      run: authed
        .input(CheckRunInputSchema)
        .output(CheckReportJsonSchema)
        .handler(({ input }) => checkReportToJson(deps.checkReport(input.path, input.identity))),
    },
    doctor: {
      run: authed.output(DoctorRunOutputSchema).handler(() => deps.doctorReport()),
    },
  };
}

/** The control-plane routers, as the merged mount's and the client's own types are derived from them. */
export type ControlApiRouter = ReturnType<typeof createControlApiRouter>;

/** The control plane alone as a client sees it: every call presents the control token, over TLS trusting only the CA file the door's own state names. */
export type ControlApiClient = RouterClient<ControlApiRouter>;

/** Everything the door's whole typed API needs: the Remote Control operations, the control-plane reads and the door-wide event stream, one deps object because one mount serves them under one token. */
export interface DoorApiDeps extends RcApiDeps, ControlApiDeps, DoorEventsApiDeps {}

/** Builds the door's whole typed API: the Remote Control router, the control-plane routers and the events router beside them, one object for the one handler the provider listener mounts. */
export function createDoorApiRouter(deps: DoorApiDeps) {
  return { ...createRcApiRouter(deps), ...createControlApiRouter(deps), ...createEventsApiRouter(deps) };
}

/** The door's whole typed API, as the client the door's own verbs and library consumers use is derived from it. */
export type DoorApiRouter = ReturnType<typeof createDoorApiRouter>;

/**
 * Builds the node handler for the door's whole typed API, Remote Control and control plane together: the pre-pipeline surface the provider listener hands every request under `RC_ORPC_PATH_PREFIX`.
 */
export function createDoorApiNodeHandler(deps: DoorApiDeps): PrePipelineApi {
  return doorApiNodeHandlerOf(createDoorApiRouter(deps));
}

/** The door's whole typed API as a client sees it: every call presents the control token, over TLS trusting only the CA file the door's own state names. */
export type DoorApiClient = RouterClient<DoorApiRouter>;

/** Builds the client for the door's whole typed API: the same address, CA and per-generation control token the Remote Control client uses, with the control-plane procedures beside `rc.*`. */
export function frontDoorApiClient(port: number, ca: string, token: string): DoorApiClient {
  return createORPCClient(frontDoorApiLink(port, ca, token));
}

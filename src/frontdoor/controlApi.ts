import { createORPCClient, ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";
import type { RouterClient } from "@orpc/server";

import { type CheckReport, checkReportToJson } from "../checkReport";
import { CheckReportJsonSchema } from "../checkReportSchema";
import type { DoctorReport } from "../doctorReport";
import { ANTHROPIC_PROVIDER } from "../usage/middleware";
import { effectiveWindow } from "../usage/preflight";
import { PoolPickReportSchema, type PoolPickReport } from "../usage/pickReportSchema";
import type { UsageSnapshot } from "../usage/schema";
import {
  CheckRunInputSchema,
  DoctorRunOutputSchema,
  FrontDoorSessionsOutputSchema,
  FrontDoorStatusOutputSchema,
  PoolPickInputSchema,
  UsageListOutputSchema,
  UsageLiveOutputSchema,
  UsageWindowsInputSchema,
  UsageWindowsOutputSchema,
} from "./controlSchemas";
import { createCodexApiRouter, type CodexApiDeps } from "./codexApi";
import { createEventsApiRouter, type DoorEventsApiDeps } from "./eventsApi";
import { createLifecycleApiRouter, type LifecycleApiDeps } from "./lifecycleApi";
import { createLaunchApiRouter, type LaunchApiDeps } from "./launchApi";
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
 * - `pool.pick` returns what `agent-shim pool pick` prints, the ranked pick for one pool exactly as a launch from the named absolute directory would make it right now, so a programmatic consumer can ask which identity to use without reading the door host's files.
 *
 * This router is reads only; the door's writes live in routers of their own so each is a decision of its own (`lifecycleApi.ts` for the restart and the update check, `codexApi.ts` for the Codex sign-in), and identity, configuration-profile, provider, pool and directory-rule management stay CLI-side. `createDoorApiNodeHandler` mounts these routers and the door-wide `events.subscribe` router beside the Remote Control router on the one prefix the provider listener already serves, so a consumer dials one address with one token for the whole door.
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
  /** The ranked pick for one pool as a launch from one absolute directory would make it right now, exactly `pool pick`'s own product; undefined when the pool table names no such pool. */
  readonly poolPick: (pool: string, directory: string) => PoolPickReport | undefined;
  /** The pool table's live names, so an unknown pool is refused naming the real ones rather than answered as an empty ranking. */
  readonly poolNames: () => readonly string[];
}

/** The OpenAPI tags the control-plane routers group under in the document, one per domain a consumer reads. */
const USAGE_API_TAG = "usage";
const FRONTDOOR_API_TAG = "frontdoor";
const CHECK_API_TAG = "check";
const DOCTOR_API_TAG = "doctor";
const POOL_API_TAG = "pool";

/** Builds the control-plane routers: one procedure per read, every one behind the control-token middleware. */
export function createControlApiRouter(deps: ControlApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    usage: {
      list: authed
        .meta(openapi({ method: "GET", path: "/rest/usage/snapshots", summary: "List every identity's usage snapshot", tags: [USAGE_API_TAG] }))
        .output(UsageListOutputSchema)
        .handler(() => ({ snapshots: deps.usageSnapshots() })),
      effectiveWindow: authed
        .meta(openapi({ method: "GET", path: "/rest/usage/windows", summary: "Read one identity's effective quota windows", tags: [USAGE_API_TAG] }))
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
        .meta(openapi({ method: "GET", path: "/rest/usage/live", summary: "Read the live rate-limit observations the event backbone files", tags: [USAGE_API_TAG] }))
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
      status: authed
        .meta(openapi({ method: "GET", path: "/rest/frontdoor/status", summary: "Read the front door's status", tags: [FRONTDOOR_API_TAG] }))
        .output(FrontDoorStatusOutputSchema)
        .handler(() => deps.frontDoorStatus()),
      sessions: authed
        .meta(openapi({ method: "GET", path: "/rest/frontdoor/sessions", summary: "Read the front door's session registry", tags: [FRONTDOOR_API_TAG] }))
        .output(FrontDoorSessionsOutputSchema)
        .handler(() => ({ sessions: deps.frontDoorStatus().sessions })),
    },
    check: {
      // The report's own JSON shape is the contract (the same one `check --json` prints and `checkReportSchema.ts` defines), so the procedure returns exactly that conversion.
      run: authed
        .meta(openapi({ method: "GET", path: "/rest/check", summary: "Run the check report for one directory", tags: [CHECK_API_TAG] }))
        .input(CheckRunInputSchema)
        .output(CheckReportJsonSchema)
        .handler(({ input }) => checkReportToJson(deps.checkReport(input.path, input.identity))),
    },
    doctor: {
      run: authed
        .meta(openapi({ method: "GET", path: "/rest/doctor", summary: "Run the doctor report", tags: [DOCTOR_API_TAG] }))
        .output(DoctorRunOutputSchema)
        .handler(() => deps.doctorReport()),
    },
    pool: {
      pick: authed
        .meta(openapi({ method: "GET", path: "/rest/pool/pick", summary: "Rank one pool exactly as a launch from a directory would right now", tags: [POOL_API_TAG] }))
        .input(PoolPickInputSchema)
        .output(PoolPickReportSchema)
        .handler(({ input }) => {
          const report = deps.poolPick(input.pool, input.path);
          // The same refusal rule every named read keeps: an unknown pool answered as an empty ranking would read as "observed, nothing eligible", so the real pool names are stated instead.
          if (report === undefined) {
            const live = deps.poolNames();
            throw new ORPCError("NOT_FOUND", {
              message: live.length === 0 ? `no pools are configured, so none is named ${input.pool}` : `no pool is named ${input.pool}; the live pools are ${live.map((name) => `"${name}"`).join(", ")}`,
            });
          }
          return report;
        }),
    },
  };
}

/** The control-plane routers, as the merged mount's and the client's own types are derived from them. */
export type ControlApiRouter = ReturnType<typeof createControlApiRouter>;

/** The control plane alone as a client sees it: every call presents the control token, over TLS trusting only the CA file the door's own state names. */
export type ControlApiClient = RouterClient<ControlApiRouter>;

/** Everything the door's whole typed API needs: the Remote Control operations, the control-plane reads and the door-wide event stream, one deps object because one mount serves them under one token. */
export interface DoorApiDeps extends RcApiDeps, ControlApiDeps, DoorEventsApiDeps, LifecycleApiDeps, CodexApiDeps, LaunchApiDeps {}

/** Builds the door's whole typed API: the Remote Control router, the control-plane routers and the events router beside them, one object for the one handler the provider listener mounts. */
export function createDoorApiRouter(deps: DoorApiDeps) {
  const control = createControlApiRouter(deps);
  const lifecycle = createLifecycleApiRouter(deps);
  // `frontdoor` is one namespace two routers contribute to (the status reads and the restart), so it is merged beside the top-level spread, which would otherwise keep only the last.
  return { ...createRcApiRouter(deps), ...control, ...lifecycle, ...createCodexApiRouter(deps), ...createLaunchApiRouter(deps), ...createEventsApiRouter(deps), frontdoor: { ...control.frontdoor, ...lifecycle.frontdoor } };
}

/** The door's whole typed API, as the client the door's own verbs and library consumers use is derived from it. */
export type DoorApiRouter = ReturnType<typeof createDoorApiRouter>;

/**
 * Builds the node handler for the door's whole typed API, Remote Control and control plane together: the pre-pipeline surface the provider listener hands every request under `RC_ORPC_PATH_PREFIX`.
 */
export function createDoorApiNodeHandler(deps: DoorApiDeps): PrePipelineApi {
  return doorApiNodeHandlerOf(createDoorApiRouter(deps), deps.expectedToken);
}

/** The door's whole typed API as a client sees it: every call presents the control token, over TLS trusting only the CA file the door's own state names. */
export type DoorApiClient = RouterClient<DoorApiRouter>;

/** Builds the client for the door's whole typed API: the same address, CA and per-generation control token the Remote Control client uses, with the control-plane procedures beside `rc.*`. */
export function frontDoorApiClient(port: number, ca: string, token: string): DoorApiClient {
  return createORPCClient(frontDoorApiLink(port, ca, token));
}

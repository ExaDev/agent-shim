import { ORPCError } from "@orpc/client";
import type { Command } from "commander";

import { withExamples } from "../cli/commandDeps";
import { UsageError } from "../cliError";
import type { LayoutPaths } from "../paths";
import { frontDoorApiFromState } from "./doorClient";
import type { RcSessionEvent } from "./rcEventLog";

/**
 * The `agent-shim frontdoor rc events` verb: one subscription across every observed Remote Control session, printing each session appearing or ending, each worker state change and each pending request's birth and retirement as it happens, through the typed API's `rcSessions.events` stream. Kept in its own module so the `frontdoor rc` tree in `rcCommands.ts` only registers it.
 */

/** What one event says beyond its kind, on the line `frontdoor rc events` prints. */
function detailOf(event: RcSessionEvent): string {
  if (event.kind === "session-ended") {
    return event.reason;
  }
  if (event.kind === "worker-state") {
    return event.previous === undefined ? event.state : `${event.previous} -> ${event.state}`;
  }
  if (event.kind === "pending-born") {
    return `${event.requestId} ${event.type}${event.summary === "" ? "" : ` ${event.summary}`}`;
  }
  if (event.kind === "pending-retired") {
    return `${event.requestId} ${event.reason}`;
  }
  // A session appearing says nothing beyond its kind.
  return "";
}

/** Formats one session event as `frontdoor rc events` prints it: the cursor a resume names, when the tracker filed it, the session, the kind and its detail. */
export function formatRcSessionEvent(event: RcSessionEvent): string {
  const detail = detailOf(event);
  return `${event.cursor}  ${new Date(event.at).toISOString()}  ${event.session}  ${event.kind}${detail === "" ? "" : `  ${detail}`}`;
}

/** Whether a thrown value is the stream's expired-cursor refusal, read through the error's own fields rather than cast. */
function expiredHeadOf(error: unknown): string | undefined {
  if (!(error instanceof ORPCError) || error.code !== "GONE") {
    return undefined;
  }
  const data: unknown = error.data;
  return typeof data === "object" && data !== null && "head" in data && typeof data.head === "string" ? data.head : undefined;
}

/** Registers `frontdoor rc events` on the `frontdoor rc` command. */
export function registerRcEventsCommand(rc: Command, paths: LayoutPaths): void {
  withExamples(
    rc
      .command("events")
      .description(
        "Follow every observed Remote Control session at once: each session appearing or ending, each worker state change (idle, running, requires_action), and each pending control request's birth and retirement, every line tagged with its session and the cursor a later --since resumes after. A cursor the door no longer holds (evicted, or from a previous door) fails naming the head to resume after once `frontdoor rc status` has restated the present. Read-only, until Ctrl-C leaves.",
      )
      .argument("[session]", "One cse_ session id, to follow that session alone; every observed session when omitted.")
      .option("--all", "Follow every observed session: the explicit spelling of omitting the session.")
      .option("--since <cursor>", "Resume after this cursor, replaying what was missed; only what happens next when omitted.")
      .option("--json", "Print each event as one JSON line as it arrives.")
      .action(async (session: string | undefined, options: Readonly<{ all?: boolean; since?: string; json?: boolean }>) => {
        if (options.all === true && session !== undefined) {
          throw new UsageError("name one session or pass --all, not both");
        }
        const client = frontDoorApiFromState(paths);
        // Ctrl-C leaves rather than killing the process: the abort ends the subscription, the stream's own cleanup runs, and the verb returns. A second Ctrl-C still terminates, because the handler installed here is a one-shot.
        const leave = new AbortController();
        const onInterrupt = (): void => {
          leave.abort();
        };
        process.once("SIGINT", onInterrupt);
        try {
          const stream = await client.rcSessions.events({ ...(session === undefined ? {} : { session }), ...(options.since === undefined ? {} : { since: options.since }) }, { signal: leave.signal });
          for await (const event of stream) {
            console.log(options.json === true ? JSON.stringify(event) : formatRcSessionEvent(event));
          }
        } catch (error) {
          if (leave.signal.aborted) {
            return;
          }
          const head = expiredHeadOf(error);
          if (head !== undefined && error instanceof Error) {
            throw new Error(`${error.message} (resume with --since ${head})`, { cause: error });
          }
          throw error;
        } finally {
          process.off("SIGINT", onInterrupt);
        }
      }),
    ["agent-shim frontdoor rc events --all", "agent-shim frontdoor rc events --all --since 00000000-0000-4000-8000-000000000000.42 --json"],
  );
}

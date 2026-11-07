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

/** A stream that failed after printing up to `lastCursor`: the original failure is the `cause`. */
export class RcSessionEventsStreamEndedError extends Error {
  readonly lastCursor: string | undefined;

  constructor(cause: unknown, lastCursor: string | undefined) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RcSessionEventsStreamEndedError";
    this.lastCursor = lastCursor;
  }
}

/**
 * Prints one stream's events as `frontdoor rc events` does, one line each, and resolves to the cursor of the last event printed (or `since` when none was), the cursor a later `--since` resumes after. A failure is rethrown with that cursor attached as `lastCursor`, so the caller can say where to resume whatever ended the stream.
 */
export async function printRcSessionEvents(events: Readonly<AsyncIterable<RcSessionEvent>>, options: Readonly<{ json: boolean; since: string | undefined }>, write: (line: string) => void): Promise<string | undefined> {
  let last = options.since;
  try {
    for await (const event of events) {
      write(options.json ? JSON.stringify(event) : formatRcSessionEvent(event));
      last = event.cursor;
    }
  } catch (error: unknown) {
    throw new RcSessionEventsStreamEndedError(error, last);
  }
  return last;
}

/** The cursor to resume after once a stream stopped with `error`: the last event printed when the stream had begun, otherwise the cursor the verb started after. */
export function lastCursorOf(error: unknown, since: string | undefined): string | undefined {
  return error instanceof RcSessionEventsStreamEndedError ? error.lastCursor : since;
}

/** How a stream's end is reported: where to resume after the last event printed. */
function resumeHint(lastCursor: string | undefined): string {
  return lastCursor === undefined ? "no event was printed; follow afresh, or resume after the head `frontdoor rc events` names" : `resume with --since ${lastCursor}`;
}

/** Registers `frontdoor rc events` on the `frontdoor rc` command. */
export function registerRcEventsCommand(rc: Command, paths: LayoutPaths): void {
  withExamples(
    rc
      .command("events")
      .description(
        "Follow every observed Remote Control session at once: each session appearing or ending, each worker state change (idle, running, requires_action), and each pending control request's birth and retirement, every line tagged with its session and the cursor a later --since resumes after. A cursor the door no longer holds (evicted, or from a previous door) fails naming the head to resume after once `frontdoor rc status` has restated the present. It does not reconnect: when the stream ends or fails (a door restart above all, whose new generation would refuse the cursor anyway), or Ctrl-C leaves it, it names the last cursor printed. Read-only, until Ctrl-C leaves.",
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
          const last = await printRcSessionEvents(stream, { json: options.json === true, since: options.since }, (line) => {
            console.log(line);
          });
          // The door ended the stream cleanly (it is shutting down): say where to resume, since this verb does not reconnect.
          console.error(`agent-shim: the event stream ended; ${resumeHint(last)}`);
        } catch (error) {
          if (leave.signal.aborted) {
            // Leaving with Ctrl-C is the ordinary way out, so it says where to resume exactly as an ending stream does.
            console.error(`agent-shim: left the event stream; ${resumeHint(lastCursorOf(error, options.since))}`);
            return;
          }
          const cause = error instanceof RcSessionEventsStreamEndedError ? error.cause : error;
          const head = expiredHeadOf(cause);
          if (head !== undefined && cause instanceof Error) {
            throw new Error(`${cause.message} (resume with --since ${head})`, { cause: error });
          }
          if (error instanceof RcSessionEventsStreamEndedError) {
            throw new Error(`${error.message}; ${resumeHint(error.lastCursor)}`, { cause: error });
          }
          throw error;
        } finally {
          process.off("SIGINT", onInterrupt);
        }
      }),
    ["agent-shim frontdoor rc events --all", "agent-shim frontdoor rc events --all --since 00000000-0000-4000-8000-000000000000.42 --json"],
  );
}

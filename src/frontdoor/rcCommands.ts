import { randomBytes, randomUUID } from "node:crypto";

import type { Command } from "commander";
import { printJson, withExamples } from "../cli/commandDeps";
import { UsageError } from "../cliError";
import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { frontDoorRcApiClient, type RcApiClient } from "./rcApi";
import { frontDoorRcControl, realRcControlTransport, type FrontDoorRcControl } from "./rcControl";
import { mintRcSelfHostCredential, type RcSelfHostMintResult } from "./rcSelfHostMint";
import { RC_PENDING_SUMMARY_EXCERPT_CHARS, type RcPendingRequestSummary, type RcSessionStatus, type RcSessionSummary } from "./rcSessions";
import { RC_CONTEXT_USAGE_DETAILS, RC_PERMISSION_MODES, RC_READ_FILE_ENCODINGS, isRcContextUsageDetail, isRcPermissionMode, isRcReadFileEncoding, type RcEventWriteResult } from "./rcWrites";
import type { RcStreamEvent } from "./rcSchemas";
import { readFrontDoorState } from "./state";

/**
 * The `agent-shim frontdoor rc` command tree, its output formatters, and the two state-reading client openers its verbs dial the serving door through: the CLI's whole Remote Control surface, extracted from `commands.ts` so each file stays a readable size. The verbs ride the door's control client (the bespoke token-gated routes) for the reads and writes, and the typed API's TLS-pinned client for the stream watch.
 */

/** How much random material a locally minted token carries: 32 bytes is the session-key scale, far past any guessing surface a local credential needs. */
export const MINTED_TOKEN_RANDOM_BYTES = 32;

/** Reports one control write's result for a `frontdoor rc` verb: the JSON answer names the minted request id (whose echo on `frontdoor rc watch` is how the worker's answer is matched) and the assigned sequence numbers, and the plain line says the same in one row. Throws the operation's verbose failure when the write did not deliver. */
function reportControlWrite(what: string, session: string, result: RcEventWriteResult, json: boolean | undefined, extra: Readonly<Record<string, unknown>> = {}): void {
  if (!result.ok) {
    throw new Error(result.message);
  }
  if (json === true) {
    printJson({ session, ...(result.requestId === undefined ? {} : { request: result.requestId }), sequenceNums: result.sequenceNums, ...extra });
    return;
  }
  console.log(`${what} on ${session}${result.requestId === undefined ? "" : `: request ${result.requestId}`} sequence_num ${result.sequenceNums.join(", ")}`);
}

/** Formats `agent-shim frontdoor rc list`, one line per observed session. */
export function formatRcSessionList(sessions: readonly RcSessionSummary[]): string[] {
  if (sessions.length === 0) {
    return ["no Remote Control sessions observed"];
  }
  return sessions.map((session) => `${session.id}  created ${new Date(session.createdAt).toISOString()}  last seen ${new Date(session.lastSeenAt).toISOString()}`);
}

/** Formats `agent-shim frontdoor rc status`: one line per observed session, its worker facts, and its pending control requests indented beneath. */
export function formatRcSessionStatus(statuses: readonly RcSessionStatus[]): string[] {
  if (statuses.length === 0) {
    return ["no Remote Control sessions observed"];
  }
  const lines: string[] = [];
  for (const status of statuses) {
    lines.push(`${status.id}  created ${new Date(status.createdAt).toISOString()}  last seen ${new Date(status.lastSeenAt).toISOString()}`);
    const worker =
      status.workerState === undefined && status.workerIdleSeconds === undefined
        ? "not observed"
        : [
            status.workerState === undefined ? "state unknown" : `state ${status.workerState.value} since ${new Date(status.workerState.observedAt).toISOString()}`,
            status.workerIdleSeconds === undefined ? "idle unknown" : `idle ${String(status.workerIdleSeconds.value)} s as of ${new Date(status.workerIdleSeconds.observedAt).toISOString()}`,
          ].join(", ");
    lines.push(`  worker: ${worker}`);
    if (status.pending.length === 0) {
      lines.push("  pending: none");
    } else {
      lines.push("  pending:");
      for (const pending of status.pending) {
        lines.push(...formatRcPendingList([pending]).map((line) => `    ${line}`));
      }
    }
  }
  return lines;
}

/** Formats `agent-shim frontdoor rc pending`, one line per control request awaiting an answer. */
export function formatRcPendingList(pending: readonly RcPendingRequestSummary[]): string[] {
  if (pending.length === 0) {
    return ["no pending control requests observed"];
  }
  return pending.map((request) => `${request.sessionId}  ${request.requestId}  ${request.type}${request.summary === "" ? "" : `  ${request.summary}`}  observed ${new Date(request.observedAt).toISOString()}`);
}

/** One excerpt kept to the log-detail budget this surface already applies, marked when it was cut. */
function eventExcerpt(text: string): string {
  return text.length <= RC_PENDING_SUMMARY_EXCERPT_CHARS ? text : `${text.slice(0, RC_PENDING_SUMMARY_EXCERPT_CHARS)}...`;
}

/** Formats one client read stream event, as `frontdoor rc watch` prints each line of it: the session, the envelope's own identification, and a bounded sketch of the payload. */
export function formatRcStreamEvent(event: RcStreamEvent): string {
  const { envelope } = event;
  const sketch = envelope.payload === undefined ? "" : `  ${eventExcerpt(JSON.stringify(envelope.payload))}`;
  return `${event.session}  ${envelope.event_type}  sequence_num ${String(envelope.sequence_num)}  source ${envelope.source}${sketch}`;
}

/** Formats `frontdoor rc selfhost mint`'s result: names and next steps only, never a token. */
export function formatRcSelfHostMint(result: RcSelfHostMintResult): string[] {
  return [
    `identity:       ${result.identity} (organisation ${result.organizationUuid})`,
    `credential:     ${result.credentialsFile}${result.replaced ? " (replacing this door's previous mint)" : ""}`,
    `account block:  ${result.claudeJsonFile} (oauthAccount and the feature-cache seed merged in)`,
    `door record:    ${result.recordFile} (the copy the door's served surface authenticates against)`,
    "next:           start the door with AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1 and its transparent surface pointed at the interception port, then launch this identity and switch Remote Control on; no claude.ai login is involved",
  ];
}

/**
 * Opens the serving door's Remote Control control client: the provider listener's address from the same state file `frontdoor status` reads, its CA from the same CA path, and this generation's control token from the owner-only file the door writes. Throws with the verbose reason when the door is not serving or its control material is missing, so a verb never dials anything on a guess.
 */
export function frontDoorRcControlFromState(fsPort: HeadroomFs, paths: LayoutPaths): FrontDoorRcControl {
  const state = readFrontDoorState(fsPort, paths.frontdoorStateFile);
  if (state?.port === undefined) {
    throw new Error("the front door is not serving: Remote Control sessions are observed only while it runs, so start a session through the door first");
  }
  const ca = fsPort.readFileUtf8(paths.frontdoorCaCertFile);
  if (ca === undefined) {
    throw new Error(`the front door's CA certificate is missing at ${paths.frontdoorCaCertFile}, so its control listener cannot be authenticated`);
  }
  const token = fsPort.readFileUtf8(paths.frontdoorControlTokenFile)?.trim();
  if (token === undefined || token === "") {
    throw new Error(`the serving front door's control token is missing at ${paths.frontdoorControlTokenFile}`);
  }
  return frontDoorRcControl(realRcControlTransport(state.port, ca), token);
}

/**
 * Opens the serving door's typed Remote Control API client, from the same state file, CA path and owner-only control token file the bespoke control client reads. Throws with the verbose reason when the door is not serving or its control material is missing, so a verb never dials anything on a guess.
 */
export function frontDoorRcApiFromState(fsPort: HeadroomFs, paths: LayoutPaths): RcApiClient {
  const state = readFrontDoorState(fsPort, paths.frontdoorStateFile);
  if (state?.port === undefined) {
    throw new Error("the front door is not serving: Remote Control sessions are observed only while it runs, so start a session through the door first");
  }
  const ca = fsPort.readFileUtf8(paths.frontdoorCaCertFile);
  if (ca === undefined) {
    throw new Error(`the front door's CA certificate is missing at ${paths.frontdoorCaCertFile}, so its typed API cannot be authenticated`);
  }
  const token = fsPort.readFileUtf8(paths.frontdoorControlTokenFile)?.trim();
  if (token === undefined || token === "") {
    throw new Error(`the serving front door's control token is missing at ${paths.frontdoorControlTokenFile}`);
  }
  return frontDoorRcApiClient(state.port, ca, token);
}
/** Registers the `frontdoor rc` verbs on the frontdoor command: the reads, the writes, the watch, and the self-hosted minting. */
export function registerRcCommand(frontdoor: Command, paths: LayoutPaths): void {
  const rc = withExamples(
    frontdoor.command("rc").description("Observe the Remote Control sessions passing through the front door, watch the stream their attached client receives, send a prompt into one, answer its pending control requests, and steer one with the client half's own control requests (interrupt, model, permission mode, end-session, the usage and context queries, read-file, file-suggestions, keep-alive, and the mcp_* family)."),
    ["agent-shim frontdoor rc list", "agent-shim frontdoor rc pending"],
  );

  withExamples(
    rc
      .command("list")
      .description("List the Remote Control sessions the front door has observed, with when each was created and last seen. Read-only.")
      .option("--json", "Print the sessions as JSON.")
      .action(async (options: Readonly<{ json?: boolean }>) => {
        const sessions = await frontDoorRcControlFromState(realFarmFs, paths).listSessions();
        if (options.json === true) {
          printJson({ sessions });
          return;
        }
        for (const line of formatRcSessionList(sessions)) {
          console.log(line);
        }
      }),
    ["agent-shim frontdoor rc list", "agent-shim frontdoor rc list --json"],
  );

  withExamples(
    rc
      .command("status")
      .description("Report each observed Remote Control session's worker state and idle from its latest observed heartbeat and registration, with its pending control requests. Read-only.")
      .argument("[session]", "One cse_ session id, as `frontdoor rc list` shows it; every observed session when omitted.")
      .option("--json", "Print the statuses as JSON.")
      .action(async (session: string | undefined, options: Readonly<{ json?: boolean }>) => {
        const statuses = await frontDoorRcControlFromState(realFarmFs, paths).statusOf(session);
        if (options.json === true) {
          printJson({ statuses });
          return;
        }
        for (const line of formatRcSessionStatus(statuses)) {
          console.log(line);
        }
      }),
    ["agent-shim frontdoor rc status", "agent-shim frontdoor rc status cse_00000000-0000-4000-8000-000000000000 --json"],
  );

  withExamples(
    rc
      .command("pending")
      .description("List the control requests (tool and plan approvals above all) the front door has observed and that are still awaiting an answer. Read-only.")
      .argument("[session]", "One cse_ session id, as `frontdoor rc list` shows it; every observed session when omitted.")
      .option("--json", "Print the pending requests as JSON.")
      .action(async (session: string | undefined, options: Readonly<{ json?: boolean }>) => {
        const pending = await frontDoorRcControlFromState(realFarmFs, paths).pendingOf(session);
        if (options.json === true) {
          printJson({ pending });
          return;
        }
        for (const line of formatRcPendingList(pending)) {
          console.log(line);
        }
      }),
    ["agent-shim frontdoor rc pending", "agent-shim frontdoor rc pending --json"],
  );

  withExamples(
    rc
      .command("send")
      .description("Send a text prompt into one observed Remote Control session, arriving as a message from an attached client would.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--text <text>", "The prompt text to deliver.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; text: string; json?: boolean }>) => {
        const result = await frontDoorRcControlFromState(realFarmFs, paths).sendPrompt(options.session, options.text);
        if (!result.ok) {
          throw new Error(result.message);
        }
        if (options.json === true) {
          printJson({ session: options.session, sequenceNums: result.sequenceNums });
          return;
        }
        console.log(`sent to ${options.session}: sequence_num ${result.sequenceNums.join(", ")}`);
      }),
    ['agent-shim frontdoor rc send --session cse_00000000-0000-4000-8000-000000000000 --text "run the tests"'],
  );

  withExamples(
    rc
      .command("answer")
      .description("Answer one pending control request on an observed session, approving or denying it as an attached client's approval would.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--request <id>", "The control request's id, as `frontdoor rc pending` shows it.")
      .option("--approve", "Approve the request.")
      .option("--deny", "Deny the request.")
      .option("--text <text>", "The denial message the worker sees; applies to --deny only.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; request: string; approve?: boolean; deny?: boolean; text?: string; json?: boolean }>) => {
        if (options.approve === options.deny) {
          throw new UsageError("answer exactly one way: pass --approve or --deny, not both and not neither");
        }
        if (options.approve === true && options.text !== undefined) {
          throw new UsageError("--text is the denial message; an approval carries no text (the protocol's allow result has no message field)");
        }
        const result = await frontDoorRcControlFromState(realFarmFs, paths).answerRequest(options.session, options.request, { approve: options.approve === true, message: options.deny === true ? options.text : undefined });
        if (!result.ok) {
          throw new Error(result.message);
        }
        if (options.json === true) {
          printJson({ session: options.session, request: options.request, sequenceNums: result.sequenceNums });
          return;
        }
        console.log(`${options.approve === true ? "approved" : "denied"} ${options.request} on ${options.session}: sequence_num ${result.sequenceNums.join(", ")}`);
      }),
    [
      "agent-shim frontdoor rc answer --session cse_00000000-0000-4000-8000-000000000000 --request req_00000000-0000-4000-8000-000000000000 --approve",
      'agent-shim frontdoor rc answer --session cse_00000000-0000-4000-8000-000000000000 --request req_00000000-0000-4000-8000-000000000000 --deny --text "not today"',
    ],
  );

  withExamples(
    rc
      .command("interrupt")
      .description("Interrupt one observed Remote Control session's running turn, as an attached client's stop button would. Queued commands survive the interrupt.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; json?: boolean }>) => {
        reportControlWrite("interrupted", options.session, await frontDoorRcControlFromState(realFarmFs, paths).interruptSession(options.session), options.json);
      }),
    ["agent-shim frontdoor rc interrupt --session cse_00000000-0000-4000-8000-000000000000"],
  );

  withExamples(
    rc
      .command("set-model")
      .description("Set the model one observed Remote Control session's subsequent turns use, as an attached client's model picker would.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--model <model>", "The model id to switch the session to.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; model: string; json?: boolean }>) => {
        reportControlWrite(`set model ${options.model}`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).setModel(options.session, options.model), options.json, { model: options.model });
      }),
    ["agent-shim frontdoor rc set-model --session cse_00000000-0000-4000-8000-000000000000 --model claude-opus-5-5"],
  );

  withExamples(
    rc
      .command("set-permission-mode")
      .description("Set one observed Remote Control session's permission mode, as an attached client's mode switcher would.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--mode <mode>", `The permission mode to set; one of the SDK's own modes (${RC_PERMISSION_MODES.join(", ")}).`)
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; mode: string; json?: boolean }>) => {
        if (!isRcPermissionMode(options.mode)) {
          throw new UsageError(`--mode must be one of the SDK's own permission modes (${RC_PERMISSION_MODES.join(", ")}), not "${options.mode}"`);
        }
        reportControlWrite(`set permission mode ${options.mode}`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).setPermissionMode(options.session, options.mode), options.json, { mode: options.mode });
      }),
    [
      "agent-shim frontdoor rc set-permission-mode --session cse_00000000-0000-4000-8000-000000000000 --mode plan",
      "agent-shim frontdoor rc set-permission-mode --session cse_00000000-0000-4000-8000-000000000000 --mode acceptEdits",
    ],
  );

  withExamples(
    rc
      .command("end-session")
      .description("End one observed Remote Control session, as an attached client closing it would: the worker aborts its turn and shuts down on receipt of the request.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .option("--reason <text>", "The reason the worker's own log names; omitted means the protocol's unspecified form.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; reason?: string; json?: boolean }>) => {
        reportControlWrite("ended", options.session, await frontDoorRcControlFromState(realFarmFs, paths).endSession(options.session, options.reason), options.json);
      }),
    ["agent-shim frontdoor rc end-session --session cse_00000000-0000-4000-8000-000000000000 --reason done for today"],
  );

  withExamples(
    rc
      .command("get-usage")
      .description("Ask one observed session's worker for its structured usage (session totals plus the plan's rate limits). The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .option("--skip-behaviors", "Skip the worker's local-transcript scan that fills the answer's behaviours section.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; skipBehaviors?: boolean; json?: boolean }>) => {
        reportControlWrite("requested usage", options.session, await frontDoorRcControlFromState(realFarmFs, paths).getUsage(options.session, options.skipBehaviors === true ? true : undefined), options.json);
      }),
    ["agent-shim frontdoor rc get-usage --session cse_00000000-0000-4000-8000-000000000000 --skip-behaviors"],
  );

  withExamples(
    rc
      .command("get-context-usage")
      .description("Ask one observed session's worker for its context-window breakdown by category. The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .option("--detail <level>", `The detail level; one of the SDK's own levels (${RC_CONTEXT_USAGE_DETAILS.join(", ")}); the worker defaults to full.`)
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; detail?: string; json?: boolean }>) => {
        if (options.detail !== undefined && !isRcContextUsageDetail(options.detail)) {
          throw new UsageError(`--detail must be one of the SDK's own context-usage levels (${RC_CONTEXT_USAGE_DETAILS.join(", ")}), not "${options.detail}"`);
        }
        reportControlWrite("requested context usage", options.session, await frontDoorRcControlFromState(realFarmFs, paths).getContextUsage(options.session, options.detail), options.json);
      }),
    ["agent-shim frontdoor rc get-context-usage --session cse_00000000-0000-4000-8000-000000000000 --detail summary"],
  );

  withExamples(
    rc
      .command("read-file")
      .description("Ask one observed session's worker to read one file from the session filesystem, gated by its own read-permission rules. The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--path <path>", "The file's path, as the worker resolves it against the session's cwd.")
      .option("--max-bytes <n>", "The byte cap on the read, a positive whole number.")
      .option("--encoding <encoding>", `How the answer encodes the contents; one of the SDK's own encodings (${RC_READ_FILE_ENCODINGS.join(", ")}).`)
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; path: string; maxBytes?: string; encoding?: string; json?: boolean }>) => {
        if (options.maxBytes !== undefined && !/^[1-9][0-9]*$/.test(options.maxBytes)) {
          throw new UsageError(`--max-bytes must be a positive whole number of bytes, not "${options.maxBytes}"`);
        }
        if (options.encoding !== undefined && !isRcReadFileEncoding(options.encoding)) {
          throw new UsageError(`--encoding must be one of the SDK's own read-file encodings (${RC_READ_FILE_ENCODINGS.join(", ")}), not "${options.encoding}"`);
        }
        reportControlWrite(`requested a read of ${options.path}`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).readFile(options.session, options.path, { ...(options.maxBytes === undefined ? {} : { maxBytes: Number(options.maxBytes) }), ...(options.encoding === undefined ? {} : { encoding: options.encoding }) }), options.json, { path: options.path });
      }),
    [
      'agent-shim frontdoor rc read-file --session cse_00000000-0000-4000-8000-000000000000 --path src/index.ts',
      "agent-shim frontdoor rc read-file --session cse_00000000-0000-4000-8000-000000000000 --path screenshot.png --encoding base64 --max-bytes 65536",
    ],
  );

  withExamples(
    rc
      .command("file-suggestions")
      .description("Ask one observed session's worker for its at-mention file suggestions for a partial path prefix, the same fuzzy-matched results the TUI shows. The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--query <prefix>", "The partial path prefix to fuzzy-match; the empty string is the root listing.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; query: string; json?: boolean }>) => {
        reportControlWrite(`requested file suggestions for "${options.query}"`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).fileSuggestions(options.session, options.query), options.json);
      }),
    ['agent-shim frontdoor rc file-suggestions --session cse_00000000-0000-4000-8000-000000000000 --query "src/frontdoor/rc"'],
  );

  withExamples(
    rc
      .command("keep-alive")
      .description("Send one liveness heartbeat into an observed session: the payload every receiver ignores by its own contract, useful to keep the client half's stream warm without saying anything.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; json?: boolean }>) => {
        reportControlWrite("sent a keep-alive", options.session, await frontDoorRcControlFromState(realFarmFs, paths).keepAlive(options.session), options.json);
      }),
    ["agent-shim frontdoor rc keep-alive --session cse_00000000-0000-4000-8000-000000000000"],
  );

  withExamples(
    rc
      .command("mcp-status")
      .description("Ask one observed session's worker for the status of its MCP server connections. The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; json?: boolean }>) => {
        reportControlWrite("requested MCP status", options.session, await frontDoorRcControlFromState(realFarmFs, paths).mcpStatus(options.session), options.json);
      }),
    ["agent-shim frontdoor rc mcp-status --session cse_00000000-0000-4000-8000-000000000000"],
  );

  withExamples(
    rc
      .command("mcp-reconnect")
      .description("Ask one observed session's worker to reconnect one MCP server, named exactly as `mcp-status` reports it.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--server <name>", "The MCP server's name, as `mcp-status` reports it.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; server: string; json?: boolean }>) => {
        reportControlWrite(`requested a reconnect of MCP server ${options.server}`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).mcpReconnect(options.session, options.server), options.json);
      }),
    ["agent-shim frontdoor rc mcp-reconnect --session cse_00000000-0000-4000-8000-000000000000 --server github"],
  );

  withExamples(
    rc
      .command("mcp-authenticate")
      .description("Start one MCP server's OAuth handshake on an observed session, naming the redirect URI the flow redirects back to. The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--server <name>", "The MCP server's name, as `mcp-status` reports it.")
      .requiredOption("--redirect-uri <uri>", "The URI the server's OAuth flow redirects back to.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; server: string; redirectUri: string; json?: boolean }>) => {
        reportControlWrite(`requested authentication of MCP server ${options.server}`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).mcpAuthenticate(options.session, options.server, options.redirectUri), options.json);
      }),
    ["agent-shim frontdoor rc mcp-authenticate --session cse_00000000-0000-4000-8000-000000000000 --server github --redirect-uri https://example.com/oauth/callback"],
  );

  withExamples(
    rc
      .command("mcp-oauth-callback-url")
      .description("Hand one MCP server's OAuth callback URL to an observed session's worker, completing the handshake `mcp-authenticate` started. The worker's answer arrives on `frontdoor rc watch` as the control_response echoing the printed request id.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--server <name>", "The MCP server's name, as `mcp-status` reports it.")
      .requiredOption("--callback-url <url>", "The callback URL the browser landed on.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; server: string; callbackUrl: string; json?: boolean }>) => {
        reportControlWrite(`handed MCP server ${options.server} its OAuth callback`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).mcpOAuthCallbackUrl(options.session, options.server, options.callbackUrl), options.json);
      }),
    ["agent-shim frontdoor rc mcp-oauth-callback-url --session cse_00000000-0000-4000-8000-000000000000 --server github --callback-url https://example.com/oauth/callback?code=x"],
  );

  withExamples(
    rc
      .command("teleport")
      .description("Send one teleport marker into an observed session over the teleport-events channel, the write half the cloud UI's ultrapan path owns on the real service. The marker rides the SDK user-message shape, the line the teleport relay anchors on.")
      .requiredOption("--session <id>", "The cse_ session id, as `frontdoor rc list` shows it.")
      .requiredOption("--marker <text>", "The marker text, the string content the teleport relay anchors on.")
      .option("--json", "Print the delivery result as JSON.")
      .action(async (options: Readonly<{ session: string; marker: string; json?: boolean }>) => {
        reportControlWrite(`teleported a marker into the session`, options.session, await frontDoorRcControlFromState(realFarmFs, paths).teleport(options.session, options.marker), options.json, { marker: options.marker });
      }),
    ['agent-shim frontdoor rc teleport --session cse_00000000-0000-4000-8000-000000000000 --marker "__ULTRAPAN_TELEPORT_LOCAL__"'],
  );

  withExamples(
    rc
      .command("watch")
      .description("Print the observed sessions' client read stream events as they arrive, the approvals the door's held stream receives above all, until Ctrl-C leaves. Read-only.")
      .argument("[session]", "One cse_ session id, as `frontdoor rc list` shows it; every observed session when omitted.")
      .option("--json", "Print each event as one JSON line as it arrives.")
      .action(async (session: string | undefined, options: Readonly<{ json?: boolean }>) => {
        const client = frontDoorRcApiFromState(realFarmFs, paths);
        // Ctrl-C leaves the watch rather than killing the process: the abort ends the subscription, the stream's own cleanup runs, and the verb returns. A second Ctrl-C still terminates, because the handler installed here is a one-shot.
        const leave = new AbortController();
        const onInterrupt = (): void => {
          leave.abort();
        };
        process.once("SIGINT", onInterrupt);
        try {
          for await (const event of await client.rc.subscribe(session === undefined ? {} : { session }, { signal: leave.signal })) {
            if (options.json === true) {
              console.log(JSON.stringify(event));
              continue;
            }
            console.log(formatRcStreamEvent(event));
          }
        } catch (error) {
          if (!leave.signal.aborted) {
            throw error;
          }
        } finally {
          process.off("SIGINT", onInterrupt);
        }
      }),
    ["agent-shim frontdoor rc watch", "agent-shim frontdoor rc watch cse_00000000-0000-4000-8000-000000000000 --json"],
  );

  const selfhost = withExamples(
    rc
      .command("selfhost")
      .description("Mint the local credential behind the door's self-hosted Remote Control surface: the opt-in mode (AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1 in the door's environment) where the door serves the CCR surface itself and a session activates Remote Control with no Anthropic credential anywhere."),
    ["agent-shim frontdoor rc selfhost mint rig"],
  );

  withExamples(
    selfhost
      .command("mint")
      .description("Mint the local OAuth credential, account block and feature-cache seed one identity needs to activate Remote Control against the door's own served surface, and record the door-side copy the surface authenticates against. Refuses to replace a real claude.ai login unless --force. Never prints a token.")
      .argument("<identity>", "The identity to mint into, as `agent-shim identity list` names it.")
      .option("--force", "Replace an existing OAuth credential this door did not mint.")
      .option("--json", "Print the mint result as JSON.")
      .action((identity: string, options: Readonly<{ force?: boolean; json?: boolean }>) => {
        const result = mintRcSelfHostCredential({
          fs: realFarmFs,
          identitiesDir: paths.identitiesDir,
          frontdoorDir: paths.frontdoorDir,
          identity,
          newUuid: randomUUID,
          randomToken: () => randomBytes(MINTED_TOKEN_RANDOM_BYTES).toString("base64url"),
          force: options.force === true,
          now: () => Date.now(),
        });
        if (options.json === true) {
          printJson(result);
          return;
        }
        for (const line of formatRcSelfHostMint(result)) {
          console.log(line);
        }
      }),
    ["agent-shim frontdoor rc selfhost mint rig", "agent-shim frontdoor rc selfhost mint rig --force"],
  );
}

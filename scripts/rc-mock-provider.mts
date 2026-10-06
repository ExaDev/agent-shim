#!/usr/bin/env node
// A deterministic Anthropic-messages provider for the Remote Control interception rig: no model, no credential of its own, loopback only. The rig's self-hosted proof needs somewhere for inference to land ("a provider of your own", docs/rc-interception-rig.md), and this server also verifies the one property that proof is about: every request must arrive carrying the provider file's own credential (the front door attaches it at the provider route, whatever the CLI presented), so a wrong or missing credential is answered with the 401 a real provider would give and the mismatch is logged.
//
// Behaviour: the first turn of a conversation answers with a Bash tool_use running PROOF_COMMAND, which makes a real CLI raise a real permission request for an attached Remote Control client to answer; once the tool result comes back it answers with final text naming what the tool printed. With RC_MOCK_TOOLSEARCH=1 the driver instead walks the deferred-tool-loading flow: a ToolSearch tool_use first, then a tool_use for the rig MCP tool once the search result is in the history, then final text, which is what drives a real CLI through the tool_reference capture behind issue #226. With RC_MOCK_WEBFETCH=1 it walks the web proxy flow instead: a WebFetch tool_use for RC_MOCK_WEBFETCH_URL (https://example.com/ unless overridden) first, then final text naming what the fetch returned, which is what drives a real CLI through the door's served worker web-fetch endpoint when its environment sets CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY. Both streaming and non-streaming shapes are answered. Usage: node scripts/rc-mock-provider.mts [--port 47474] [--token <expected credential>] [--target bearer|apiKey]; the token defaults to RC_MOCK_TOKEN so it never has to appear in a process listing, and RC_MOCK_DUMP=<file> additionally appends every request body verbatim as JSON lines (bodies only, never headers, so the credential never reaches the dump).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

// The command writes a file, which is what makes the real CLI raise a real permission request: a plain `echo` is classified read-only and auto-approved without one, so the proof would never reach the approval path.
const PROOF_COMMAND = "echo APPROVAL-PROOF-OK > /tmp/approval-proof-ok && cat /tmp/approval-proof-ok";
const DEFAULT_PORT = 47474;
/** How many hex characters of a presented credential's digest the log names: enough to tell two credentials apart, never enough to be one. */
const FINGERPRINT_CHARS = 12;
/** The characters-per-token estimate count_tokens answers with; a rough estimate is all compaction heuristics needs. */
const CHARS_PER_TOKEN = 4;

/** How many characters of the fetched page the summarisation head's answer echoes: enough to name the page in the pane, short enough to stay a citation. */
const SUMMARISED_EXCERPT_CHARS = 120;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
/** The MCP tool the ToolSearch driver asks for, in the fully-qualified name a real CLI uses (server name, then tool name, joined on double underscores). */
const RIG_TOOL_NAME = "mcp__rigtools__rig_echo";

/** One content block as this server reads it: identified by its type, everything else carried loosely. */
interface Block {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly content?: unknown;
}

/** The slice of an Anthropic Messages request this server decides on. */
interface MessagesRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly messages: readonly { readonly role: string; readonly content: string | readonly Block[] }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessagesRequest(value: unknown): MessagesRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return undefined;
  }
  const messages: { readonly role: string; readonly content: string | readonly Block[] }[] = [];
  for (const raw of value.messages) {
    if (!isRecord(raw) || typeof raw.role !== "string") {
      return undefined;
    }
    const content =
      typeof raw.content === "string"
        ? raw.content
        : Array.isArray(raw.content)
          ? raw.content.filter(isRecord).map((block) => ({
              type: typeof block.type === "string" ? block.type : "",
              ...(typeof block.text === "string" ? { text: block.text } : {}),
              ...(typeof block.name === "string" ? { name: block.name } : {}),
              ...("content" in block ? { content: block.content } : {}),
            }))
          : undefined;
    if (content === undefined) {
      return undefined;
    }
    messages.push({ role: raw.role, content });
  }
  return { model: typeof value.model === "string" ? value.model : "", stream: value.stream === true, messages };
}

function argument(name: string, fallback: string): string {
  const flag = process.argv.indexOf(`--${name}`);
  return flag !== -1 && flag + 1 < process.argv.length ? (process.argv[flag + 1] ?? fallback) : fallback;
}

const port = Number(argument("port", process.env.RC_MOCK_PORT ?? String(DEFAULT_PORT)));
const expectedToken = argument("token", process.env.RC_MOCK_TOKEN ?? "");
const target = argument("target", "bearer");
const dumpFile = process.env.RC_MOCK_DUMP ?? "";
const toolSearchDriver = process.env.RC_MOCK_TOOLSEARCH === "1";
const webFetchDriver = process.env.RC_MOCK_WEBFETCH === "1";
/** The URL the web-fetch driver tells the CLI to fetch: a real public page by default, because the CLI rewrites any http URL to https before it reaches the door's proxy, so the rig's loopback stand-ins cannot serve it and the public internet is the honest target. */
const WEBFETCH_URL = process.env.RC_MOCK_WEBFETCH_URL ?? "https://example.com/";

/** Appends one request body to the dump as a JSON line. The body is stored verbatim (never headers), and the file is disposable rig evidence, never committed. */
function dumpRequest(method: string, url: string, body: string): void {
  if (dumpFile === "") {
    return;
  }
  fs.appendFileSync(dumpFile, `${JSON.stringify({ ts: new Date().toISOString(), method, url, body })}\n`);
}

/** A one-way fingerprint of a presented credential, so the log names which credential arrived without ever printing one. */
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, FINGERPRINT_CHARS);
}

/** The conversation's last USER message: the CLI appends system messages after a tool result, so the turn's state is read from the newest message the user side of the protocol owns. */
function lastUserMessage(body: MessagesRequest) {
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message?.role === "user") {
      return message;
    }
  }
  return undefined;
}

/** Every tool name the assistant side of the history has ever called, in order, which is how the ToolSearch driver tells which step of the walk the conversation is on. */
function assistantToolUseNames(body: MessagesRequest): string[] {
  const names: string[] = [];
  for (const message of body.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        names.push(block.name);
      }
    }
  }
  return names;
}

function toolResultText(content: readonly Block[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      parts.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
    }
  }
  return parts.join(" ").trim();
}

/** Whether the conversation's last turn carries a tool result, which is the follow-up half of the proof: the tool_use was answered and the final text is due. */
function sawToolResult(body: MessagesRequest): boolean {
  const last = lastUserMessage(body);
  return last !== undefined && typeof last.content !== "string" && last.content.some((block) => block.type === "tool_result");
}

function anthropicError(res: http.ServerResponse, status: number, type: string, message: string): void {
  const text = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

function usage(): { input_tokens: number; output_tokens: number } {
  return { input_tokens: 1, output_tokens: 1 };
}

function messageFor(body: MessagesRequest): { id: string; type: "message"; role: "assistant"; model: string; content: readonly ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> })[]; stop_reason: string; stop_sequence: null; usage: { input_tokens: number; output_tokens: number } } {
  const last = lastUserMessage(body);
  const lastResultText = last === undefined || typeof last.content === "string" ? "" : toolResultText(last.content);
  if (toolSearchDriver) {
    const called = assistantToolUseNames(body);
    if (called.includes(RIG_TOOL_NAME)) {
      return {
        id: `msg_mock_${String(Date.now())}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: `the rig tool ran and printed: ${lastResultText}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: usage(),
      };
    }
    if (called.includes("ToolSearch")) {
      return {
        id: `msg_mock_${String(Date.now())}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          { type: "text", text: "the search brought the schema back, calling it now" },
          { type: "tool_use", id: `toolu_mock_${String(Date.now())}`, name: RIG_TOOL_NAME, input: { text: "toolref-pass" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: usage(),
      };
    }
    return {
      id: `msg_mock_${String(Date.now())}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [
        { type: "text", text: "searching for the rig tool first" },
        { type: "tool_use", id: `toolu_mock_${String(Date.now())}`, name: "ToolSearch", input: { query: `select:${RIG_TOOL_NAME}`, max_results: 5 } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: usage(),
    };
  }
  if (webFetchDriver) {
    // The CLI's fetch pipeline summarises the fetched page with a small-model head before the tool result is due, a one-shot conversation whose user message is the page itself (a plain string or one text block); answering it with plain text (rather than another tool_use) is what makes the tool result readable in the pane, so the driver picks it out by that head's model family and echoes the page's opening.
    const pageText = last === undefined ? undefined : typeof last.content === "string" ? last.content : last.content.every((block) => block.type === "text") ? last.content.map((block) => block.text ?? "").join("") : undefined;
    if (body.model.startsWith("claude-haiku") && pageText !== undefined) {
      return {
        id: `msg_mock_${String(Date.now())}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: `the fetched page opens with: ${pageText.slice(0, SUMMARISED_EXCERPT_CHARS)}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: usage(),
      };
    }
    if (last !== undefined && sawToolResult(body)) {
      return {
        id: `msg_mock_${String(Date.now())}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: `the fetch came back with: ${typeof last.content === "string" ? last.content : toolResultText(last.content)}` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: usage(),
      };
    }
    return {
      id: `msg_mock_${String(Date.now())}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [
        { type: "text", text: "fetching the page through the door's web proxy now" },
        { type: "tool_use", id: `toolu_mock_${String(Date.now())}`, name: "WebFetch", input: { url: WEBFETCH_URL, prompt: "Describe what this page says." } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: usage(),
    };
  }
  if (last !== undefined && sawToolResult(body)) {
    return {
      id: `msg_mock_${String(Date.now())}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: `the proof step ran and printed: ${typeof last.content === "string" ? last.content : toolResultText(last.content)}` }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: usage(),
    };
  }
  return {
    id: `msg_mock_${String(Date.now())}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [
      { type: "text", text: "running the proof step now" },
      { type: "tool_use", id: `toolu_mock_${String(Date.now())}`, name: "Bash", input: { command: PROOF_COMMAND } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: usage(),
  };
}

type Message = ReturnType<typeof messageFor>;

function respondJson(res: http.ServerResponse, message: Message): void {
  const text = JSON.stringify(message);
  res.writeHead(HTTP_OK, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

function respondStream(res: http.ServerResponse, message: Message): void {
  res.writeHead(HTTP_OK, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", { type: "message_start", message: { id: message.id, type: "message", role: "assistant", model: message.model, content: [], stop_reason: null, usage: usage() } });
  message.content.forEach((block, index) => {
    send("content_block_start", { type: "content_block_start", index, content_block: block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, input: {} } : { type: "text", text: "" } });
    if (block.type === "text") {
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const presented = target === "apiKey" ? req.headers["x-api-key"] : req.headers.authorization;
    const presentedValue = target === "apiKey" ? String(presented ?? "") : String(presented ?? "").replace(/^Bearer /, "");
    const verdict = presentedValue === expectedToken && presentedValue !== "" ? "ok" : "unexpected";
    console.log(`${new Date().toISOString()} ${req.method ?? ""} ${req.url ?? ""} auth=${verdict} fingerprint=${fingerprint(presentedValue)}`);
    if (verdict === "unexpected") {
      anthropicError(res, HTTP_UNAUTHORIZED, "authentication_error", "the mock provider demands its own configured credential; the front door attaches it at the provider route");
      return;
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    dumpRequest(req.method ?? "", req.url ?? "", rawBody);
    // The CLI sends its query string along (?beta=true), so the path is matched on its own.
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      const text = JSON.stringify({ input_tokens: Math.ceil(rawBody.length / CHARS_PER_TOKEN) });
      res.writeHead(HTTP_OK, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
      res.end(text);
      return;
    }
    if (req.method !== "POST" || path !== "/v1/messages") {
      res.writeHead(HTTP_NOT_FOUND);
      res.end();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      anthropicError(res, HTTP_BAD_REQUEST, "invalid_request_error", "request body is not JSON");
      return;
    }
    const body = parseMessagesRequest(parsed);
    if (body === undefined) {
      anthropicError(res, HTTP_BAD_REQUEST, "invalid_request_error", "request body is not an Anthropic Messages request");
      return;
    }
    const message = messageFor(body);
    const last = lastUserMessage(body);
    const lastShape = last === undefined ? "none" : `${last.role}:${typeof last.content === "string" ? "text" : last.content.map((block) => block.type).join("+")}`;
    console.log(`answering model=${body.model} stream=${String(body.stream)} stop=${message.stop_reason} turn=${sawToolResult(body) ? "follow-up" : "tool-use"} last=${lastShape}`);
    if (body.stream) {
      respondStream(res, message);
      return;
    }
    respondJson(res, message);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock provider listening on 127.0.0.1:${String(port)} (target ${target})`);
});

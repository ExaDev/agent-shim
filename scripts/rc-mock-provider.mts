#!/usr/bin/env node
// A deterministic Anthropic-messages provider for the Remote Control interception rig: no model, no credential of its own, loopback only. The rig's self-hosted proof needs somewhere for inference to land ("a provider of your own", docs/rc-interception-rig.md), and this server also verifies the one property that proof is about: every request must arrive carrying the provider file's own credential (the front door attaches it at the provider route, whatever the CLI presented), so a wrong or missing credential is answered with the 401 a real provider would give and the mismatch is logged.
//
// Behaviour: the first turn of a conversation answers with a Bash tool_use running PROOF_COMMAND, which makes a real CLI raise a real permission request for an attached Remote Control client to answer; once the tool result comes back it answers with final text naming what the tool printed. Both streaming and non-streaming shapes are answered. Usage: node scripts/rc-mock-provider.mts [--port 47474] [--token <expected credential>] [--target bearer|apiKey]; the token defaults to RC_MOCK_TOKEN so it never has to appear in a process listing.

import { createHash } from "node:crypto";
import * as http from "node:http";

// The command writes a file, which is what makes the real CLI raise a real permission request: a plain `echo` is classified read-only and auto-approved without one, so the proof would never reach the approval path.
const PROOF_COMMAND = "echo APPROVAL-PROOF-OK > /tmp/approval-proof-ok && cat /tmp/approval-proof-ok";
const DEFAULT_PORT = 47474;
/** How many hex characters of a presented credential's digest the log names: enough to tell two credentials apart, never enough to be one. */
const FINGERPRINT_CHARS = 12;
/** The characters-per-token estimate count_tokens answers with; a rough estimate is all compaction heuristics needs. */
const CHARS_PER_TOKEN = 4;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

/** One content block as this server reads it: identified by its type, everything else carried loosely. */
interface Block {
  readonly type: string;
  readonly text?: string;
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

function messageFor(body: MessagesRequest): { id: string; type: "message"; role: "assistant"; model: string; content: readonly ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: { command: string } })[]; stop_reason: string; stop_sequence: null; usage: { input_tokens: number; output_tokens: number } } {
  const last = lastUserMessage(body);
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
    // The CLI sends its query string along (?beta=true), so the path is matched on its own.
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      const text = JSON.stringify({ input_tokens: Math.ceil(Buffer.concat(chunks).toString("utf8").length / CHARS_PER_TOKEN) });
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
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

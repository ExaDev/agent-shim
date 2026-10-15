import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import { z } from "zod";

import type { ResolvedAntigravityConfig } from "./translate";
import type { GeminiCandidate, GeminiGenerateContentRequest, GeminiGenerateContentResponseChunk } from "./geminiSchema";

const DEFAULT_ACP_COMMAND = ["antigravity-acp"];

export interface LocalUpstreamParams {
  readonly config: ResolvedAntigravityConfig;
  readonly model: string;
  readonly request: GeminiGenerateContentRequest;
  readonly signal: AbortSignal;
  /** Injected connector for testing without OS IPC. */
  readonly connector?: (config: ResolvedAntigravityConfig, signal: AbortSignal) => AcpConnection;
}

export interface AcpConnection {
  readonly send: (msg: unknown) => void;
  readonly lines: AsyncIterable<string>;
  readonly close: () => void;
}

function connectSocket(socketPath: string): AcpConnection {
  const socket = net.createConnection({ path: socketPath });
  const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

  return {
    send: (msg: unknown) => {
      socket.write(`${JSON.stringify(msg)}\n`);
    },
    lines: rl,
    close: () => {
      socket.destroy();
    },
  };
}

function spawnProcess(command: readonly string[], signal: AbortSignal): AcpConnection {
  const bin = command[0];
  if (bin === undefined) {
    throw new Error("ACP command cannot be empty");
  }
  const args = command.slice(1);
  const proc: ChildProcess = spawn(bin, args, {
    stdio: ["pipe", "pipe", "inherit"],
    signal,
  });

  if (proc.stdin === null || proc.stdout === null) {
    throw new Error(`Failed to establish stdio pipes with ACP process "${command.join(" ")}"`);
  }

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

  return {
    send: (msg: unknown) => {
      proc.stdin?.write(`${JSON.stringify(msg)}\n`);
    },
    lines: rl,
    close: () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore already terminated
      }
    },
  };
}

const AcpStreamMessageSchema = z.looseObject({
  jsonrpc: z.string().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z
    .looseObject({
      delta: z
        .looseObject({
          text: z.string().optional(),
          toolCall: z
            .looseObject({
              id: z.string().optional(),
              name: z.string(),
              arguments: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      finishReason: z.string().optional(),
      chunk: z.looseObject({}).optional(),
    })
    .optional(),
  result: z
    .looseObject({
      chunk: z.looseObject({}).optional(),
    })
    .optional(),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFinishReason(reason?: string): GeminiCandidate["finishReason"] {
  if (reason === undefined) {
    return undefined;
  }
  if (reason === "STOP" || reason === "MAX_TOKENS" || reason === "SAFETY" || reason === "RECITATION" || reason === "OTHER") {
    return reason;
  }
  const lower = reason.toLowerCase();
  if (lower === "stop" || lower === "end_turn") {
    return "STOP";
  }
  if (lower === "max_tokens" || lower === "length") {
    return "MAX_TOKENS";
  }
  return "OTHER";
}

function parseJsonRecord(raw: string | undefined): Readonly<Record<string, unknown>> {
  if (raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

/**
 * Communicates with a local Antigravity ACP server and yields streaming chunks.
 */
export async function* callLocalAntigravity(
  params: LocalUpstreamParams,
): AsyncIterable<GeminiGenerateContentResponseChunk> {
  const { config, signal } = params;
  let conn: AcpConnection | undefined;

  try {
    if (params.connector !== undefined) {
      conn = params.connector(config, signal);
    } else if (config.local.socketPath !== undefined) {
      conn = connectSocket(config.local.socketPath);
    } else {
      const cmd = config.local.command ?? DEFAULT_ACP_COMMAND;
      conn = spawnProcess(cmd, signal);
    }

    let nextId = 1;
    // Step 1: Initialize ACP handshake
    const initId = nextId++;
    conn.send({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "1.0",
        clientInfo: { name: "agent-shim", version: "1.0" },
      },
    });

    // Step 2: Send session prompt
    const promptId = nextId++;
    conn.send({
      jsonrpc: "2.0",
      id: promptId,
      method: "session/prompt",
      params: {
        model: params.model,
        request: params.request,
      },
    });

    for await (const line of conn.lines) {
      if (signal.aborted) {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsedJson: unknown = JSON.parse(trimmed);
        const parsed = AcpStreamMessageSchema.safeParse(parsedJson);
        if (!parsed.success) {
          continue;
        }
        const msg = parsed.data;

        if (msg.params?.chunk !== undefined) {
          yield msg.params.chunk;
        } else if (msg.result?.chunk !== undefined) {
          yield msg.result.chunk;
        } else if (msg.method === "session/update" && msg.params?.delta !== undefined) {
          const delta = msg.params.delta;
          const parts = [];
          if (delta.text !== undefined && delta.text.length > 0) {
            parts.push({ text: delta.text });
          }
          if (delta.toolCall !== undefined) {
            const argsObj = parseJsonRecord(delta.toolCall.arguments);
            parts.push({ functionCall: { name: delta.toolCall.name, args: argsObj } });
          }

          yield {
            candidates: [
              {
                content: { parts },
                finishReason: normalizeFinishReason(msg.params.finishReason),
              },
            ],
          };
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } finally {
    conn?.close();
  }
}

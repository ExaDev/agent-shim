/**
 * Measures what headroom's transforms are worth on real conversations, offline: replays requests rebuilt from local Claude Code transcripts through scratch headroom daemons, one per settings variant, with a local fake upstream standing in for the provider.
 *
 * Usage: node scripts/headroom-measure.mts [--transcript FILE]... [--projects-dir DIR]... [--sessions N] [--requests N] [--variants NAME,NAME] [--out DIR] [--dry-run]
 *
 * Nothing leaves the machine: each daemon runs with `HEADROOM_OFFLINE=1` (headroom's no-egress switch), no telemetry and a throwaway workspace, and it forwards only to the loopback fake upstream, which answers every request with a canned reply. The replayed conversations are your own transcripts, so the per-request records written to `--out` carry token counts, transform names and timings but never message content, and sessions are named s1, s2, ... rather than by file.
 *
 * Settings come from the same `settingsArgs` and `settingsEnv` agent-shim uses to start its own daemon, so a variant is exactly what the corresponding `headroom` config block would run. The system prompt and tools are fixed placeholders of realistic size (the transcripts do not contain the real ones); they are the stable head of every request's prefix.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { settingsArgs, settingsEnv, type HeadroomSettings } from "../src/headroom/settings";
import {
  buildRequests,
  CACHE_READ_RATIO_DEFAULT,
  CACHE_READ_RATIO_OPUS,
  mainChain,
  parseTranscript,
  parseTransforms,
  pickTranscripts,
  placeholderPrefix,
  preservedPrefix,
  renderTable,
  renderTransforms,
  segmentsOf,
  summarise,
  toMessages,
  type ChatMessage,
  type RequestRecord,
  type TranscriptCandidate,
  type TranscriptEntry,
} from "./headroom-measure-core";

/** How many sessions the default workload replays: enough to cover several kinds of work without making a run last hours. */
const DEFAULT_SESSIONS = 6;

/** How many consecutive requests of each session are replayed by default: long enough for prefix behaviour to show across turns. */
const DEFAULT_REQUESTS = 25;

/** The smallest transcript considered, in bytes: smaller files rarely hold a conversation long enough to fill the requested window. */
const MINIMUM_TRANSCRIPT_BYTES = 500_000;

/** The largest transcript read, in bytes: bounds parse time and memory, since every line is held while the main chain is walked. */
const MAXIMUM_TRANSCRIPT_BYTES = 80_000_000;

/** The largest replayed request body, in bytes (about 300 thousand tokens): bounds the run time of the slowest transform and stays within the context a request can carry. */
const MAXIMUM_BODY_BYTES = 1_200_000;

/** Token sizes of the placeholder system prompt and tool block, in the range Claude Code's own occupy. */
const DEFAULT_SYSTEM_TOKENS = 12_000;
const DEFAULT_TOOLS_TOKENS = 10_000;

/** How long a daemon may take to answer its readiness probe: the first start also loads the compression model. */
const DAEMON_READY_TIMEOUT_MS = 180_000;
const DAEMON_READY_POLL_MS = 500;

/** How long one replayed request may take before the run gives up on it. */
const REQUEST_TIMEOUT_MS = 180_000;

/** How long a daemon gets to exit after SIGTERM before it is killed by pid. */
const DAEMON_EXIT_TIMEOUT_MS = 10_000;

/** The HTTP status of a request headroom served. */
const HTTP_OK = 200;

/** How long one readiness probe may take: a few polling intervals, since a loaded machine answers slowly. */
const READY_PROBE_POLLS = 4;
const READY_PROBE_TIMEOUT_MS = DAEMON_READY_POLL_MS * READY_PROBE_POLLS;

/** How many records the warm-up request's synthetic tool result holds: enough JSON for the compressors to load and run, small enough to be quick. */
const WARMUP_RECORDS = 300;

/** The model name replayed requests claim: the one most Claude Code traffic on the measured machine used. */
const REPLAY_MODEL = "claude-opus-5-5";

/** Output tokens requested: the fake upstream ignores it, but the field is required. */
const REPLAY_MAX_TOKENS = 64;

/** The read multipliers reported side by side: the documented default and Opus 5.5's. */
const READ_RATIOS = { default: CACHE_READ_RATIO_DEFAULT, opus: CACHE_READ_RATIO_OPUS };

interface Variant {
  readonly name: string;
  readonly settings: HeadroomSettings;
}

/** The experiment matrix from the measurement issue: modes, target ratios, recoverability and the experimental channels. */
const VARIANTS: readonly Variant[] = [
  { name: "cache (default)", settings: {} },
  { name: "cache, target ratio 0.5", settings: { targetRatio: 0.5 } },
  { name: "cache, target ratio 0.3", settings: { targetRatio: 0.3 } },
  { name: "cache, lossless", settings: { ccr: "lossless" } },
  { name: "cache, no retrieval", settings: { ccr: "none" } },
  { name: "token", settings: { mode: "token" } },
  { name: "token, target ratio 0.5", settings: { mode: "token", targetRatio: 0.5 } },
  { name: "cache, tool-result interceptors (canary)", settings: { rolloutChannel: "canary", interceptToolResults: true } },
  { name: "cache, read maturation (beta)", settings: { rolloutChannel: "beta", readMaturation: true } },
];

interface Options {
  readonly transcripts: readonly string[];
  readonly projectsDirs: readonly string[];
  readonly sessions: number;
  readonly requests: number;
  readonly variants: readonly string[];
  readonly out: string | undefined;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const transcripts: string[] = [];
  const projectsDirs: string[] = [];
  let sessions = DEFAULT_SESSIONS;
  let requests = DEFAULT_REQUESTS;
  let variants: string[] = [];
  let out: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) {
      break;
    }
    const value = (): string => {
      index += 1;
      const next = argv[index];
      if (next === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      return next;
    };
    switch (flag) {
      case "--transcript":
        transcripts.push(value());
        break;
      case "--projects-dir":
        projectsDirs.push(value());
        break;
      case "--sessions":
        sessions = Number(value());
        break;
      case "--requests":
        requests = Number(value());
        break;
      case "--variants":
        variants = value().split(",").map((name) => name.trim());
        break;
      case "--out":
        out = value();
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  return { transcripts, projectsDirs: projectsDirs.length > 0 ? projectsDirs : [path.join(os.homedir(), ".claude", "projects")], sessions, requests, variants, out, dryRun };
}

function discover(roots: readonly string[]): TranscriptCandidate[] {
  const candidates: TranscriptCandidate[] = [];
  for (const root of roots) {
    let projects: string[];
    try {
      projects = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      const directory = path.join(root, project);
      let names: string[];
      try {
        names = fs.readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) {
          continue;
        }
        const file = path.join(directory, name);
        const bytes = fs.statSync(file).size;
        if (bytes <= MAXIMUM_TRANSCRIPT_BYTES) {
          candidates.push({ file, project, bytes });
        }
      }
    }
  }
  return candidates;
}

async function readLines(file: string): Promise<string[]> {
  const lines: string[] = [];
  const reader = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) {
    lines.push(line);
  }
  return lines;
}

interface ReplaySession {
  readonly name: string;
  readonly userId: string;
  readonly bodies: readonly Record<string, unknown>[];
}

/** The JSON size of a value in bytes, the unit the body cap is stated in. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The longest leading run of messages whose request body, with the fixed prefix, stays within the body cap. */
function withinBodyCap(messages: readonly ChatMessage[], prefixBytes: number): ChatMessage[] {
  let total = prefixBytes;
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    total += jsonBytes(message);
    if (total > MAXIMUM_BODY_BYTES) {
      break;
    }
    kept.push(message);
  }
  return kept;
}

async function loadSession(file: string, index: number, requests: number, prefix: ReturnType<typeof placeholderPrefix>): Promise<ReplaySession | undefined> {
  const entries: TranscriptEntry[] = parseTranscript(await readLines(file));
  const messages = withinBodyCap(toMessages(mainChain(entries)), jsonBytes(prefix));
  const built = buildRequests(messages, requests);
  if (built.length === 0) {
    return undefined;
  }
  const sessionId = randomUUID();
  const userId = `user_${createHash("sha256").update(sessionId).digest("hex")}_account__session_${sessionId}`;
  return {
    name: `s${String(index + 1)}`,
    userId,
    bodies: built.map((request) => ({ model: REPLAY_MODEL, max_tokens: REPLAY_MAX_TOKENS, stream: false, system: prefix.system, tools: prefix.tools, messages: request.messages, metadata: { user_id: userId } })),
  };
}

/**
 * A request unlike any replayed one, sent once per daemon before the replay: the first compression after a start loads the model, which would otherwise be charged to a measured request, and a warm-up identical to a replayed request would be answered from headroom's response cache without compressing anything.
 */
function warmupBody(prefix: ReturnType<typeof placeholderPrefix>): Record<string, unknown> {
  const records = Array.from({ length: WARMUP_RECORDS }, (_, index) => ({ id: index, name: `warmup-${String(index)}`, state: "ok", tags: ["a", "b", "c"] }));
  return {
    model: REPLAY_MODEL,
    max_tokens: REPLAY_MAX_TOKENS,
    stream: false,
    system: prefix.system,
    tools: prefix.tools,
    metadata: { user_id: `user_${createHash("sha256").update("warmup").digest("hex")}_account__session_${randomUUID()}` },
    messages: [
      { role: "user", content: [{ type: "text", text: "list the warm-up records" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_warmup", name: "PlaceholderTool0", input: { input: "list" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_warmup", content: JSON.stringify(records) }] },
    ],
  };
}

interface FakeUpstream {
  readonly port: number;
  /** The body the upstream last received on the headroom route, parsed. */
  readonly lastBody: () => unknown;
  readonly close: () => Promise<void>;
}

/** The route the replay sends straight to the upstream, bypassing headroom, to time the same body with no daemon in the path. */
const DIRECT_PATH = "/direct/v1/messages";

async function startFakeUpstream(): Promise<FakeUpstream> {
  let last: unknown;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (request.url !== DIRECT_PATH) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          last = parsed;
        } catch {
          last = undefined;
        }
      }
      response.writeHead(HTTP_OK, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_replay", type: "message", role: "assistant", model: REPLAY_MODEL, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake upstream has no port");
  }
  return {
    port: address.port,
    lastBody: () => last,
    close: async () => {
      await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
    },
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

interface Daemon {
  readonly port: number;
  readonly warmupMs: number;
  readonly close: () => Promise<void>;
}

/** The environment a scratch daemon gets: only what it needs to run, never this process's credentials, with every egress and persistence path switched off. */
function daemonEnv(workspace: string, upstreamPort: number, settings: Readonly<HeadroomSettings>): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  return {
    ...inherited,
    HEADROOM_WORKSPACE_DIR: workspace,
    HEADROOM_STATELESS: "1",
    HEADROOM_OFFLINE: "1",
    HF_HUB_OFFLINE: "1",
    DO_NOT_TRACK: "1",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    HEADROOM_HTTP2: "0",
    HEADROOM_ALLOWED_BASE_URLS: `http://127.0.0.1:${String(upstreamPort)}`,
    ...settingsEnv(settings),
  };
}

function headroomBinary(): string {
  return path.join(os.homedir(), ".local", "share", "uv", "tools", "headroom-ai", "bin", "headroom");
}

function replayHeaders(upstreamPort: number): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": "not-a-real-key",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.0 (external, cli)",
    "x-headroom-base-url": `http://127.0.0.1:${String(upstreamPort)}`,
    "x-headroom-project-id": "headroom-measurement",
  };
}

async function waitReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the scratch headroom exited with code ${String(child.exitCode)} before it was ready`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`, { signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) });
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DAEMON_READY_POLL_MS);
    });
  }
  throw new Error("the scratch headroom did not become ready in time");
}

async function startDaemon(variant: Variant, upstream: FakeUpstream, scratch: string, warmup: Readonly<Record<string, unknown>>): Promise<Daemon> {
  const port = await freePort();
  const workspace = fs.mkdtempSync(path.join(scratch, "ws-"));
  const child = spawn(headroomBinary(), ["proxy", "--host", "127.0.0.1", "--port", String(port), "--no-rate-limit", ...settingsArgs(variant.settings)], {
    env: daemonEnv(workspace, upstream.port, variant.settings),
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitReady(port, child);
  const started = performance.now();
  await fetch(`http://127.0.0.1:${String(port)}/v1/messages`, { method: "POST", headers: replayHeaders(upstream.port), body: JSON.stringify(warmup), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const warmupMs = performance.now() - started;
  return {
    port,
    warmupMs,
    close: async () => {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, DAEMON_EXIT_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

function headerNumber(headers: Headers, name: string): number {
  const raw = headers.get(name);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Replays every session's requests in order through one daemon and records what headroom reported and what the upstream received. */
async function replay(daemon: Daemon, upstream: FakeUpstream, sessions: readonly ReplaySession[]): Promise<RequestRecord[]> {
  const records: RequestRecord[] = [];
  for (const session of sessions) {
    let previous: string[] | undefined;
    let previousOriginal: string[] | undefined;
    for (const [index, body] of session.bodies.entries()) {
      const payload = JSON.stringify(body);
      const directStarted = performance.now();
      await fetch(`http://127.0.0.1:${String(upstream.port)}${DIRECT_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const directMs = performance.now() - directStarted;
      const throughStarted = performance.now();
      const response = await fetch(`http://127.0.0.1:${String(daemon.port)}/v1/messages`, { method: "POST", headers: replayHeaders(upstream.port), body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      await response.arrayBuffer();
      const throughMs = performance.now() - throughStarted;
      const received = upstream.lastBody();
      const segments = typeof received === "object" && received !== null ? segmentsOf(received) : [];
      const { preservedBytes, totalBytes } = preservedPrefix(previous, segments);
      previous = segments;
      const originalSegments = segmentsOf(body);
      const original = preservedPrefix(previousOriginal, originalSegments);
      previousOriginal = originalSegments;
      records.push({
        session: session.name,
        index,
        status: response.status,
        tokensBefore: headerNumber(response.headers, "x-headroom-tokens-before"),
        tokensAfter: headerNumber(response.headers, "x-headroom-tokens-after"),
        transforms: parseTransforms(response.headers.get("x-headroom-transforms")),
        preservedBytes,
        totalBytes,
        baselinePreservedBytes: original.preservedBytes,
        baselineTotalBytes: original.totalBytes,
        throughMs,
        directMs,
      });
    }
  }
  return records;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prefix = placeholderPrefix({ systemTokens: DEFAULT_SYSTEM_TOKENS, toolsTokens: DEFAULT_TOOLS_TOKENS });
  const files = options.transcripts.length > 0 ? options.transcripts : pickTranscripts(discover(options.projectsDirs), options.sessions, MINIMUM_TRANSCRIPT_BYTES).map((pick) => pick.file);
  const sessions: ReplaySession[] = [];
  for (const [index, file] of files.entries()) {
    const session = await loadSession(file, index, options.requests, prefix);
    if (session !== undefined) {
      sessions.push(session);
    }
  }
  const requestCount = sessions.reduce((sum, session) => sum + session.bodies.length, 0);
  console.log(`workload: ${String(sessions.length)} sessions, ${String(requestCount)} requests`);
  for (const session of sessions) {
    const sizes = session.bodies.map((body) => jsonBytes(body));
    console.log(`  ${session.name}: ${String(session.bodies.length)} requests, body ${String(Math.min(...sizes))} to ${String(Math.max(...sizes))} bytes`);
  }
  if (options.dryRun || sessions.length === 0) {
    return;
  }
  const selected = options.variants.length === 0 ? VARIANTS : VARIANTS.filter((variant) => options.variants.includes(variant.name));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-measure-"));
  const upstream = await startFakeUpstream();
  const warmup = warmupBody(prefix);
  const summaries = [];
  const reference: RequestRecord[] = [];
  try {
    for (const variant of selected) {
      console.log(`variant: ${variant.name}`);
      const daemon = await startDaemon(variant, upstream, scratch, warmup);
      try {
        const records = await replay(daemon, upstream, sessions);
        const usable = records.filter((record) => record.status === HTTP_OK && record.tokensBefore > 0);
        const failed = records.length - usable.length;
        const failedStatuses = [...new Set(records.filter((record) => !usable.includes(record)).map((record) => record.status))].sort((a, b) => a - b);
        console.log(`  warm-up ${daemon.warmupMs.toFixed(0)} ms, ${String(usable.length)} usable of ${String(records.length)} requests${failed > 0 ? ` (${String(failed)} failed, status ${failedStatuses.join(", ")})` : ""}`);
        if (reference.length === 0) {
          reference.push(...usable);
        }
        summaries.push({ summary: summarise(variant.name, usable, READ_RATIOS), warmupMs: daemon.warmupMs, failed });
        if (options.out !== undefined) {
          fs.mkdirSync(options.out, { recursive: true });
          fs.writeFileSync(path.join(options.out, `records-${slug(variant.name)}.json`), `${JSON.stringify(usable, null, 2)}\n`);
        }
      } finally {
        await daemon.close();
      }
    }
  } finally {
    await upstream.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const unmodified = summarise(
    "unmodified (no headroom)",
    reference.map((record) => ({ ...record, tokensAfter: record.tokensBefore, preservedBytes: record.baselinePreservedBytes, totalBytes: record.baselineTotalBytes, throughMs: record.directMs })),
    READ_RATIOS,
  );
  const all = [unmodified, ...summaries.map((entry) => entry.summary)];
  console.log(`\n${renderTable(all)}\n`);
  for (const entry of summaries) {
    console.log(`warm-up (first request after start): ${entry.summary.name}: ${entry.warmupMs.toFixed(0)} ms`);
  }
  for (const entry of summaries.slice(0, 1)) {
    console.log(`\ntransforms, ${entry.summary.name}:\n${renderTransforms(entry.summary)}`);
  }
  if (options.out !== undefined) {
    fs.writeFileSync(path.join(options.out, "summary.json"), `${JSON.stringify(all, null, 2)}\n`);
  }
}

await main();

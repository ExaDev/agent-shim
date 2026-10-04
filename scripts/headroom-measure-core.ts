/**
 * The pure half of the headroom measurement harness: turns recorded conversations into replayable Messages requests, scores how much of each request's prefix a provider prompt cache could still reuse after headroom rewrote it, prices that with the published cache multipliers, and aggregates per-variant results. Nothing here touches a process, a socket or the filesystem, so every rule is tested without a daemon.
 *
 * Why the cache is part of the metric: headroom's own stats report tokens removed, but an input token served from the provider's prefix cache costs a small fraction of an uncached one, so compression that rewrites earlier turns can lose more than it saves. A request is priced as reused-prefix tokens at the cache-read multiplier plus everything else at the cache-write multiplier.
 */
import { z } from "zod";

/** Anthropic's published multipliers on the base input-token price (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, Pricing): a 5-minute cache write costs 1.25 times base. */
export const CACHE_WRITE_RATIO = 1.25;

/** The published cache-read multiplier for most models. Some models differ (Opus 5.5 reads at 0.05), so callers pass the ratio they mean; this is the documented default. */
export const CACHE_READ_RATIO_DEFAULT = 0.1;

/** The published cache-read multiplier for Opus 5.5, the model most traffic on the measured machine used. */
export const CACHE_READ_RATIO_OPUS = 0.05;

/** Converts a ratio to a percentage. */
const PERCENT = 100;

/** The percentiles reported for added latency: the typical request and the tail. */
const MEDIAN_PERCENTILE = 50;
const TAIL_PERCENTILE = 95;

/** The multiplier and increment of the classic linear congruential generator (ANSI C), used only to make the placeholder prefix a fixed pseudo-random word stream. */
const LCG_MULTIPLIER = 1103515245;
const LCG_INCREMENT = 12345;

/** Seeds that make the placeholder system prompt differ from every placeholder tool description. */
const PLACEHOLDER_SYSTEM_SEED = 9001;

/** Characters per token used only to size the placeholder system prompt and tool block, never to score anything: scoring uses the token counts headroom reports for each request. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** The block types a replayed request keeps. Thinking blocks carry signatures bound to the original request, and images are large base64 that no transform here touches, so both are dropped. */
const KEPT_BLOCK_TYPES: ReadonlySet<string> = new Set(["text", "tool_use", "tool_result"]);

const BlockSchema = z.record(z.string(), z.unknown());
type Block = z.infer<typeof BlockSchema>;

/** The fields of one transcript line this module reads; every other field is ignored. */
const TranscriptEntrySchema = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
  message: z
    .object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(BlockSchema)]),
    })
    .optional(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

/** One conversation message as a Messages request carries it. */
export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly Block[];
}

/** Parses transcript lines, skipping any that are not valid JSON or do not match the fields read here: a transcript is append-only and may end in a partial line. */
export function parseTranscript(lines: Readonly<Iterable<string>>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = TranscriptEntrySchema.safeParse(raw);
    if (parsed.success) {
      entries.push(parsed.data);
    }
  }
  return entries;
}

/**
 * The main conversation: from the last non-sidechain user or assistant entry, follow `parentUuid` back to the root and return the chain oldest first. Walking parents (rather than taking file order) drops abandoned branches and sidechains, which never reach the model as part of this conversation.
 */
export function mainChain(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }
  const isConversation = (entry: TranscriptEntry): boolean => entry.message !== undefined && entry.isSidechain !== true && (entry.type === "user" || entry.type === "assistant");
  const last = [...entries].reverse().find(isConversation);
  if (last === undefined) {
    return [];
  }
  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let cursor: TranscriptEntry | undefined = last;
  while (cursor !== undefined) {
    if (cursor.uuid !== undefined) {
      if (seen.has(cursor.uuid)) {
        break;
      }
      seen.add(cursor.uuid);
    }
    if (isConversation(cursor)) {
      chain.push(cursor);
    }
    cursor = cursor.parentUuid === null || cursor.parentUuid === undefined ? undefined : byUuid.get(cursor.parentUuid);
  }
  return chain.reverse();
}

/** What a replayed tool result carries when everything but text is stripped from it and nothing was left, so the call stays answered. */
export const OMITTED_TOOL_RESULT = "(tool output omitted from the replay)";

/**
 * A tool result as the replay sends it: a string stays as it is, and a list keeps only its text items. `tool_reference` items name deferred tools that the placeholder tool block cannot define, which headroom would "repair" in a way a live request (whose tool block does define them) never triggers, and images are large base64 that no transform measured here touches.
 */
export function replayableToolResult(block: Block): Block {
  const content = block.content;
  if (!Array.isArray(content)) {
    return block;
  }
  const texts = content.filter((item): boolean => isRecord(item) && item.type === "text");
  return { ...block, content: texts.length > 0 ? texts : OMITTED_TOOL_RESULT };
}

function blocksOf(content: string | readonly Block[]): Block[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  return content.filter((block) => typeof block.type === "string" && KEPT_BLOCK_TYPES.has(block.type)).map((block) => (block.type === "tool_result" ? replayableToolResult(block) : block));
}

/**
 * Turns the main chain into alternating Messages-API messages. Claude Code writes one transcript line per content block of an assistant message and one per tool result, so consecutive same-role lines are merged into one message (the API needs every result of a parallel tool call in the single following user message). A tool result whose call is not in the previous assistant message is dropped, as is any message left empty by the block filter.
 */
export function toMessages(chain: readonly TranscriptEntry[]): ChatMessage[] {
  const merged: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const entry of chain) {
    if (entry.message === undefined) {
      continue;
    }
    const blocks = blocksOf(entry.message.content);
    if (blocks.length === 0) {
      continue;
    }
    const previous = merged.at(-1);
    if (previous?.role === entry.message.role) {
      previous.content.push(...blocks);
    } else {
      merged.push({ role: entry.message.role, content: [...blocks] });
    }
  }
  const result: ChatMessage[] = [];
  for (const message of merged) {
    let content = message.content;
    if (message.role === "user") {
      const calls = new Set<string>();
      const before = result.at(-1);
      if (before?.role === "assistant") {
        for (const block of before.content) {
          if (block.type === "tool_use" && typeof block.id === "string") {
            calls.add(block.id);
          }
        }
      }
      content = content.filter((block) => block.type !== "tool_result" || (typeof block.tool_use_id === "string" && calls.has(block.tool_use_id)));
    }
    if (content.length > 0) {
      result.push({ role: message.role, content });
    }
  }
  while (result.length > 0 && result[0]?.role !== "user") {
    result.shift();
  }
  return result;
}

/** One replayable request: the conversation up to and including a user-side message. */
export interface ReplayRequest {
  readonly messages: readonly ChatMessage[];
}

/**
 * The last `count` requests of a conversation, oldest first. A request is made after every user-side message, and request k+1 always begins with exactly request k's messages, so replaying them in order gives headroom the same growing prefix a live session does. The window is contiguous because prefix reuse is only meaningful between consecutive requests.
 */
export function buildRequests(messages: readonly ChatMessage[], count: number): ReplayRequest[] {
  const points: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      points.push(index);
    }
  });
  return points.slice(-count).map((index) => ({ messages: messages.slice(0, index + 1) }));
}

/** A deterministic pseudo-random word stream, so the placeholder prefix is identical on every run and carries no repetition for a compressor to exploit. */
function words(seed: number, characters: number): string {
  const vocabulary = ["session", "tool", "result", "file", "path", "project", "command", "output", "stream", "token", "branch", "commit", "review", "config", "schema", "daemon", "socket", "header", "request", "response"];
  let state = seed;
  const parts: string[] = [];
  // The joined length is the words plus one separator between each pair, so it is one less than a running total that counts a separator after every word.
  let joinedLength = -1;
  while (joinedLength < characters) {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    const word = vocabulary[state % vocabulary.length] ?? "token";
    parts.push(word);
    joinedLength += word.length + 1;
  }
  return parts.join(" ");
}

/** The fixed `system` and `tools` every replayed request carries, sized to stand in for Claude Code's own: they are the stable head of the prefix, which no transform here is expected to change. */
export function placeholderPrefix(sizes: Readonly<{ systemTokens: number; toolsTokens: number }>): { readonly system: string; readonly tools: readonly Record<string, unknown>[] } {
  const toolCount = 20;
  const perToolCharacters = Math.floor((sizes.toolsTokens * CHARS_PER_TOKEN_ESTIMATE) / toolCount);
  const tools = Array.from({ length: toolCount }, (_, index) => ({
    name: `PlaceholderTool${String(index)}`,
    description: words(index + 1, perToolCharacters),
    input_schema: { type: "object", properties: { input: { type: "string", description: "placeholder" } }, required: ["input"] },
  }));
  return { system: words(PLACEHOLDER_SYSTEM_SEED, sizes.systemTokens * CHARS_PER_TOKEN_ESTIMATE), tools };
}

/** True for a plain object (not null, not an array): the shape whose keys `canonical` orders. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively drops `cache_control` keys and orders object keys, so two renderings of the same content compare equal whatever their key order or breakpoint placement: a breakpoint moves every turn and does not change what a cache matches on. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key !== "cache_control") {
        result[key] = canonical(value[key]);
      }
    }
    return result;
  }
  return value;
}

/**
 * A request body split into the segments a prompt cache hashes in order: `tools`, then `system`, then each message. A change in one segment invalidates it and every later one, so comparing segment lists from the front finds exactly the reusable prefix.
 */
export function segmentsOf(body: Readonly<{ tools?: unknown; system?: unknown; messages?: unknown }>): string[] {
  const messages: readonly unknown[] = Array.isArray(body.messages) ? body.messages : [];
  return [JSON.stringify(canonical(body.tools ?? null)), JSON.stringify(canonical(body.system ?? null)), ...messages.map((message) => JSON.stringify(canonical(message)))];
}

/** How much of a request a cache could reuse from the one before it: the byte length of the leading segments that are identical, over the request's total bytes. */
export function preservedPrefix(previous: readonly string[] | undefined, next: readonly string[]): { readonly preservedBytes: number; readonly totalBytes: number } {
  const totalBytes = next.reduce((sum, segment) => sum + segment.length, 0);
  if (previous === undefined) {
    return { preservedBytes: 0, totalBytes };
  }
  let preservedBytes = 0;
  for (let index = 0; index < next.length; index += 1) {
    const segment = next[index];
    if (segment === undefined || segment !== previous[index]) {
      break;
    }
    preservedBytes += segment.length;
  }
  return { preservedBytes, totalBytes };
}

/** The relative cost of one request's input under prefix caching: reused tokens at the read multiplier, everything else at the write multiplier, in units of the base input-token price. */
export function cacheWeightedCost(tokens: number, preservedFraction: number, readRatio: number): number {
  return tokens * preservedFraction * readRatio + tokens * (1 - preservedFraction) * CACHE_WRITE_RATIO;
}

/** What headroom reported for one replayed request, parsed from its `x-headroom-*` response headers, plus what the replay observed. */
export interface RequestRecord {
  readonly session: string;
  readonly index: number;
  readonly status: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly transforms: readonly string[];
  /** Bytes of the segments identical to the previous request's, and the request's total bytes, as the upstream received them. */
  readonly preservedBytes: number;
  readonly totalBytes: number;
  /** The same two figures for the request as it was sent, before headroom touched it: what the unmodified conversation would have reused, since its newest messages are never cached yet. */
  readonly baselinePreservedBytes: number;
  readonly baselineTotalBytes: number;
  /** Round trip through headroom and the same body sent straight to the upstream, in milliseconds. */
  readonly throughMs: number;
  readonly directMs: number;
}

/** Splits `x-headroom-transforms` (a comma-separated list such as `router:tool_result:smart_crusher,cache_mode:prefix_frozen`) into its names. */
export function parseTransforms(header: string | null | undefined): string[] {
  return header === null || header === undefined || header.trim() === "" ? [] : header.split(",").map((name) => name.trim()).filter((name) => name !== "");
}

/** The p-th percentile (0 to 100) by nearest rank of the sorted values, or 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / PERCENT) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

/** One variant's results over the whole workload. */
export interface VariantSummary {
  readonly name: string;
  readonly requests: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensRemovedPercent: number;
  readonly compressedPercent: number;
  /** Token-weighted share of each request that the previous request's prefix covers. */
  readonly prefixPreservedPercent: number;
  /** Cache-weighted input cost relative to the same requests sent unmodified, one figure per read multiplier given. */
  readonly costVersusBaselinePercent: Readonly<Record<string, number>>;
  readonly addedLatencyP50Ms: number;
  readonly addedLatencyP95Ms: number;
  /** For each transform name: the requests it appeared in and the tokens those requests saved (a request with several transforms counts toward each). */
  readonly transforms: readonly { readonly name: string; readonly requests: number; readonly tokensSaved: number }[];
}

/** The share of a request that the previous request covers, from byte counts: 0 when there is nothing to compare. */
function fraction(preservedBytes: number, totalBytes: number): number {
  return totalBytes === 0 ? 0 : preservedBytes / totalBytes;
}

/**
 * What the unmodified requests would have cost: each request's previous request is its prefix (the conversation only grows) and its newest messages are written fresh, so the reused share is that of the original bodies, measured the same way as for a variant. The first request of a session reuses nothing.
 */
export function baselineCost(records: readonly RequestRecord[], readRatio: number): number {
  return records.reduce((sum, record) => sum + cacheWeightedCost(record.tokensBefore, fraction(record.baselinePreservedBytes, record.baselineTotalBytes), readRatio), 0);
}

/** Aggregates one variant's per-request records against the unmodified baseline for the same requests. */
export function summarise(name: string, records: readonly RequestRecord[], readRatios: Readonly<Record<string, number>>): VariantSummary {
  const tokensBefore = records.reduce((sum, record) => sum + record.tokensBefore, 0);
  const tokensAfter = records.reduce((sum, record) => sum + record.tokensAfter, 0);
  const compressed = records.filter((record) => record.tokensAfter < record.tokensBefore).length;
  const weightedPreserved = records.reduce((sum, record) => sum + record.tokensAfter * fraction(record.preservedBytes, record.totalBytes), 0);
  const cost: Record<string, number> = {};
  for (const [label, ratio] of Object.entries(readRatios)) {
    const actual = records.reduce((sum, record) => sum + cacheWeightedCost(record.tokensAfter, fraction(record.preservedBytes, record.totalBytes), ratio), 0);
    const baseline = baselineCost(records, ratio);
    cost[label] = baseline === 0 ? 0 : (actual / baseline - 1) * PERCENT;
  }
  const added = records.map((record) => record.throughMs - record.directMs);
  const byTransform = new Map<string, { requests: number; tokensSaved: number }>();
  for (const record of records) {
    for (const transform of new Set(record.transforms)) {
      const entry = byTransform.get(transform) ?? { requests: 0, tokensSaved: 0 };
      entry.requests += 1;
      entry.tokensSaved += Math.max(0, record.tokensBefore - record.tokensAfter);
      byTransform.set(transform, entry);
    }
  }
  return {
    name,
    requests: records.length,
    tokensBefore,
    tokensAfter,
    tokensRemovedPercent: tokensBefore === 0 ? 0 : ((tokensBefore - tokensAfter) / tokensBefore) * PERCENT,
    compressedPercent: records.length === 0 ? 0 : (compressed / records.length) * PERCENT,
    prefixPreservedPercent: tokensAfter === 0 ? 0 : (weightedPreserved / tokensAfter) * PERCENT,
    costVersusBaselinePercent: cost,
    addedLatencyP50Ms: percentile(added, MEDIAN_PERCENTILE),
    addedLatencyP95Ms: percentile(added, TAIL_PERCENTILE),
    transforms: [...byTransform.entries()].map(([transformName, value]) => ({ name: transformName, ...value })).sort((a, b) => b.tokensSaved - a.tokensSaved),
  };
}

/** Renders summaries as a markdown table: one row per variant, with the cache-weighted cost shown for every read multiplier the summaries carry. */
export function renderTable(summaries: readonly VariantSummary[]): string {
  const labels = Object.keys(summaries[0]?.costVersusBaselinePercent ?? {});
  const header = ["variant", "requests", "tokens removed", "requests compressed", "prefix preserved", ...labels.map((label) => `input cost vs unmodified (${label})`), "added latency p50 / p95"];
  const rows = summaries.map((summary) => [
    summary.name,
    String(summary.requests),
    `${summary.tokensRemovedPercent.toFixed(2)}%`,
    `${summary.compressedPercent.toFixed(1)}%`,
    `${summary.prefixPreservedPercent.toFixed(1)}%`,
    ...labels.map((label) => `${(summary.costVersusBaselinePercent[label] ?? 0).toFixed(2)}%`),
    `${summary.addedLatencyP50Ms.toFixed(0)} ms / ${summary.addedLatencyP95Ms.toFixed(0)} ms`,
  ]);
  return [header, header.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

/** Renders one variant's transform frequencies as a markdown table. */
export function renderTransforms(summary: VariantSummary): string {
  const rows = summary.transforms.map((transform) => `| ${transform.name} | ${String(transform.requests)} | ${String(transform.tokensSaved)} |`);
  return ["| transform | requests | tokens saved by those requests |", "| --- | --- | --- |", ...rows].join("\n");
}

/** One transcript file considered for the workload. */
export interface TranscriptCandidate {
  readonly file: string;
  readonly project: string;
  readonly bytes: number;
}

/** Picks up to `count` transcripts, largest first but at most one per project so the workload covers different kinds of work, ignoring any too small to hold a long conversation. */
export function pickTranscripts(candidates: readonly TranscriptCandidate[], count: number, minimumBytes: number): TranscriptCandidate[] {
  const picked: TranscriptCandidate[] = [];
  const projects = new Set<string>();
  for (const candidate of [...candidates].sort((a, b) => b.bytes - a.bytes)) {
    if (picked.length >= count) {
      break;
    }
    if (candidate.bytes < minimumBytes || projects.has(candidate.project)) {
      continue;
    }
    projects.add(candidate.project);
    picked.push(candidate);
  }
  return picked;
}

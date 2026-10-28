import { z } from "zod";

import { PROMPT_CACHE_TTL_SECONDS } from "../../config/statusline";
import { visibleDisplayText } from "../sanitise";
import { recordTimeMs, type TranscriptRecord } from "./record";

/**
 * What the prompt cache's clock needs while records are read in order. The cache's lifetime starts with the request that reads or writes it, not with the response, so a response is anchored to the record it answers: `previousMainAtMs` trails the main conversation, and the request fields hold the anchor for the request being read. Records of subagents are left out of all of it, because a subagent runs against a cache of its own.
 */
const PromptCacheClockSchema = z.strictObject({
  previousMainAtMs: z.number().optional(),
  requestId: z.string().optional(),
  requestAnchorAtMs: z.number().optional(),
  anchorAtMs: z.number().optional(),
  /** The tier the latest request that wrote to the cache used. */
  ttlSeconds: z.union([z.literal(PROMPT_CACHE_TTL_SECONDS.fiveMinutes), z.literal(PROMPT_CACHE_TTL_SECONDS.oneHour)]).optional(),
  /** The time of a request that has been sent and not yet answered: it has already refreshed the cache. */
  pendingAtMs: z.number().optional(),
});

/** The facts that add up over the whole transcript, or begin it, so only a read of every record makes them exact: when the session began, and how many times it was compacted. */
const CumulativeStateSchema = z.strictObject({
  startedAtMs: z.number().optional(),
  /** True once the start of the transcript was read and held no timestamp, so a timestamp met later is not the session's start. */
  startUnknown: z.literal(true).optional(),
  compactions: z.number().int().nonnegative(),
});

/** A compaction the transcript records: when its `compact_boundary` record was written, and the tokens the context held once it was done, where the client recorded them (truncated to a whole token). The tokens are any whole number of 0 or more, beyond `Number.MAX_SAFE_INTEGER` included, which Zod's `int()` refuses: the fold keeps every `postTokens` the client writes that is a finite number of 0 or more, and keeps a boundary whose `postTokens` is anything else (a negative number, one JSON parses to Infinity, or not a number) with none, and a state it saves must load again. */
const CompactionSchema = z.strictObject({
  atMs: z.number(),
  postTokens: z
    .number()
    .nonnegative()
    .refine((tokens) => Number.isInteger(tokens))
    .optional(),
});

/** A compaction the transcript records, as `CompactionSchema` describes it. */
export type Compaction = z.infer<typeof CompactionSchema>;

/** The facts that are the newest value of something rather than a total: the latest response, the names, the newest compaction, and the prompt cache's clock (see `foldLatest` for which records set each). */
export const LatestStateSchema = z.strictObject({
  lastAssistantAtMs: z.number().optional(),
  /** The compaction with the latest timestamp, as claude-hud picks it among boundaries stamped with a date string: a boundary stamped no later than the one held does not replace it, and one is counted, as on the compactions row, only when its timestamp is a string `Date.parse` reads as a date. claude-hud counts a boundary whose timestamp is truthy and which `new Date` reads as a valid date, whatever its type, so the two differ only on a timestamp that is truthy, is not a string and that `new Date` reads as a valid date, which Claude Code never writes (see the parity document's kept differences). */
  compaction: CompactionSchema.optional(),
  customTitle: z.string().optional(),
  slug: z.string().optional(),
  aiTitle: z.string().optional(),
  cache: PromptCacheClockSchema,
});

/** Everything the session facts are folded from, one transcript record at a time, in the two kinds the facts come in. It is JSON-serialisable, because the statusline is a new process at every refresh and keeps it between them. */
export const SessionStateSchema = z.strictObject({ cumulative: CumulativeStateSchema, latest: LatestStateSchema });
type CumulativeState = z.infer<typeof CumulativeStateSchema>;
export type LatestState = z.infer<typeof LatestStateSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;

/** The state before any record has been read. */
export const EMPTY_SESSION_STATE: SessionState = { cumulative: { compactions: 0 }, latest: { cache: {} } };

/** The latest-state facts before any record has been read. */
export const EMPTY_LATEST_STATE: LatestState = EMPTY_SESSION_STATE.latest;

/** The openers of user text that Claude Code produces locally: a slash command writes its invocation, its output and its caveat as user records, and an interrupt writes a marker, and none of them sends a request. */
const LOCAL_ONLY_USER_TEXT_PREFIXES = ["<command-name>", "<command-message>", "<local-command-", "[Request interrupted by user"];

function isLocalOnlyUserText(text: string): boolean {
  return LOCAL_ONLY_USER_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Whether a user record opens a request rather than being a local note. A prompt or a tool result is sent as soon as it is written, so the record marks the request's start; a record of an unrecognised shape is taken for a prompt, being far likelier a message than a client-side aside. */
function opensRequest(record: TranscriptRecord): boolean {
  const content = record.message?.content;
  if (typeof content === "string") {
    return !isLocalOnlyUserText(content);
  }
  if (Array.isArray(content)) {
    // A text of nothing is the same nothing either way, so the fallback on it reads the same.
    return content.some((block) => block.type === "tool_result") || !content.some((block) => block.type === "text" && isLocalOnlyUserText(block.text ?? ""));
  }
  return true;
}

/** The tier a request's cache writes used, from its per-tier write counters. A request that wrote nothing (a pure cache read) says nothing, so the tier seen earlier stands. A request that wrote to both tiers takes the shorter, which is the first part of the prefix to lapse. */
function ttlOf(record: TranscriptRecord): LatestState["cache"]["ttlSeconds"] {
  const writes = record.message?.usage?.cache_creation;
  // The counters are never negative, so a counter of zero falls back to the same zero and either way reads the same.
  if ((writes?.ephemeral_5m_input_tokens ?? 0) > 0) {
    return PROMPT_CACHE_TTL_SECONDS.fiveMinutes;
  }
  return (writes?.ephemeral_1h_input_tokens ?? 0) > 0 ? PROMPT_CACHE_TTL_SECONDS.oneHour : undefined;
}

/** The cache clock after one record of the main conversation. */
function foldPromptCache(cache: LatestState["cache"], record: TranscriptRecord, atMs: number | undefined): LatestState["cache"] {
  if (atMs === undefined) {
    return cache;
  }
  let next = cache;
  if (record.type === "assistant") {
    // A record with no request id is a request of its own, anchored to the record before it: later than the true start of the request, never later than the response.
    const startsRequest = record.requestId === undefined || record.requestId !== cache.requestId;
    const requestAnchorAtMs = startsRequest ? cache.previousMainAtMs : cache.requestAnchorAtMs;
    // With no record before it, or one stamped after the response it led to, the response itself is the latest defensible anchor. An anchor stamped at the response gives the same time either way of comparing, and a tier named is never a zero, so both fallbacks read the same.
    const anchorAtMs = requestAnchorAtMs !== undefined && requestAnchorAtMs <= atMs ? requestAnchorAtMs : atMs;
    const ttlSeconds = ttlOf(record) ?? cache.ttlSeconds;
    next = { ...cache, requestId: startsRequest ? record.requestId : cache.requestId, requestAnchorAtMs, anchorAtMs, ttlSeconds, pendingAtMs: undefined };
  }
  if (record.type === "user" && opensRequest(record)) {
    next = { ...next, pendingAtMs: atMs };
  }
  return { ...next, previousMainAtMs: atMs };
}

/** The cumulative facts after one more transcript record, read in file order. */
function foldCumulative(state: Readonly<CumulativeState>, record: TranscriptRecord): CumulativeState {
  const atMs = recordTimeMs(record);
  const next: CumulativeState = { ...state };
  if (record.type === "system" && record.subtype === "compact_boundary" && atMs !== undefined) {
    next.compactions += 1;
  }
  if (atMs !== undefined && next.startedAtMs === undefined && next.startUnknown !== true) {
    next.startedAtMs = atMs;
  }
  return next;
}

/** Of two compactions, the one stamped later, or the first when neither is later, as claude-hud keeps the first of boundaries stamped alike. */
function laterCompaction(held: Compaction | undefined, met: Compaction | undefined): Compaction | undefined {
  return held === undefined || (met !== undefined && met.atMs > held.atMs) ? met : held;
}

/** The latest-state facts after one more transcript record, read in file order. Folded from the end of a transcript alone, the latest response and the names are the ones the whole of it gives as long as the end holds a record that sets each; the prompt cache's clock is anchored to records within the end alone, and the newest compaction is the one stamped latest within the end, which can be earlier than one before it, so `sessionFactsOf` takes the later of the end's and the one the part read so far holds. */
export function foldLatest(state: LatestState, record: TranscriptRecord): LatestState {
  const atMs = recordTimeMs(record);
  const next: LatestState = { ...state };
  if (record.type === "custom-title" && record.customTitle !== undefined) {
    next.customTitle = record.customTitle;
  } else if (record.type === "ai-title" && record.aiTitle !== undefined) {
    next.aiTitle = record.aiTitle;
  } else if (record.slug !== undefined) {
    next.slug = record.slug;
  }
  if (record.type === "assistant" && atMs !== undefined) {
    next.lastAssistantAtMs = atMs;
  }
  if (record.type === "system" && record.subtype === "compact_boundary" && atMs !== undefined) {
    const postTokens = record.compactMetadata?.postTokens;
    next.compaction = laterCompaction(state.compaction, { atMs, ...(postTokens === undefined ? {} : { postTokens: Math.trunc(postTokens) }) });
  }
  if (record.isSidechain !== true) {
    next.cache = foldPromptCache(state.cache, record, atMs);
  }
  return next;
}

/** `state` after one more transcript record, read in file order. */
export function foldSession(state: SessionState, record: TranscriptRecord): SessionState {
  return { cumulative: foldCumulative(state.cumulative, record), latest: foldLatest(state.latest, record) };
}

/** What the session's transcript says about the session. */
export interface SessionFacts {
  /** The name `/rename` gave the session, else its generated slug, else the title Claude Code generated for it; names are text a person or the model wrote, so each is reduced to the text a person would see (escape sequences, control characters and characters that draw nothing removed, edge space trimmed), and a name left empty by that is no name. */
  readonly title: string | undefined;
  readonly startedAtMs: number | undefined;
  /** When the latest assistant record was written, subagents' included. */
  readonly lastResponseAtMs: number | undefined;
  readonly compactions: number;
  /** The compaction stamped latest among the records the reader has read: the whole transcript once `TranscriptFacts.complete` is true, and while it is catching up the part read so far and the end it folds alone, so a compaction in the part between is not counted until the reader reaches it (the parity document's kept difference on the transcript reader catching up). Undefined when none of those records is a `compact_boundary` with a timestamp. */
  readonly lastCompaction: Compaction | undefined;
  /** The prompt cache's clock: when the request that last refreshed it was sent, and the tier its writes used (undefined until a write has shown one). Undefined when the main conversation has no request yet. */
  readonly promptCache: { readonly anchorAtMs: number; readonly ttlSeconds: number | undefined } | undefined;
}

/** Whether a prompt cache clock holds a request: one that has seen none says nothing about the cache. */
function hasRequest(cache: LatestState["cache"]): boolean {
  return cache.anchorAtMs !== undefined || cache.pendingAtMs !== undefined;
}

/**
 * The facts a state holds. `newer`, when given, is the latest-state facts folded from the end of the transcript alone while the cumulative ones are still being caught up: each of its facts that is set replaces the state's, because the end of the transcript is later than anything the state has read, and one it lacks is left as the state has it (the prompt cache's clock is the end's once the end holds a request, with the state's tier where the end shows none); the newest compaction is the one of the two stamped later, as it is within either.
 */
export function sessionFactsOf(state: SessionState, newer?: LatestState): SessionFacts {
  const { cumulative } = state;
  // A tier named is never a zero, and a pending request stamped at the anchor gives the same anchor either way of comparing, so both fallbacks read the same.
  const latest: LatestState = newer === undefined ? state.latest : { ...state.latest, ...newer, cache: hasRequest(newer.cache) ? { ...newer.cache, ttlSeconds: newer.cache.ttlSeconds ?? state.latest.cache.ttlSeconds } : state.latest.cache };
  const { cache } = latest;
  // A request still waiting for its response has already refreshed the cache, so it is the live anchor once it is later than the last response's. A pending request stamped earlier than that response is clock skew, and the earlier anchor is the one that cannot overstate the lifetime left.
  const anchorAtMs = cache.pendingAtMs !== undefined && (cache.anchorAtMs === undefined || cache.pendingAtMs > cache.anchorAtMs) ? cache.pendingAtMs : cache.anchorAtMs;
  return {
    title: [latest.customTitle, latest.slug, latest.aiTitle].flatMap((name) => (name === undefined ? [] : visibleDisplayText(name))).find((name) => name !== ""),
    startedAtMs: cumulative.startedAtMs,
    lastResponseAtMs: latest.lastAssistantAtMs,
    compactions: cumulative.compactions,
    lastCompaction: laterCompaction(state.latest.compaction, newer?.compaction),
    promptCache: anchorAtMs === undefined ? undefined : { anchorAtMs, ttlSeconds: cache.ttlSeconds },
  };
}

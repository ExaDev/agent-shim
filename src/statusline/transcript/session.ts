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

/** The facts that are the newest value of something, so the end of the transcript settles them whatever came before: the latest response, the names, and the prompt cache's clock. */
export const LatestStateSchema = z.strictObject({
  lastAssistantAtMs: z.number().optional(),
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
    return content.some((block) => block.type === "tool_result") || !content.some((block) => block.type === "text" && isLocalOnlyUserText(block.text ?? ""));
  }
  return true;
}

/** The tier a request's cache writes used, from its per-tier write counters. A request that wrote nothing (a pure cache read) says nothing, so the tier seen earlier stands. A request that wrote to both tiers takes the shorter, which is the first part of the prefix to lapse. */
function ttlOf(record: TranscriptRecord): LatestState["cache"]["ttlSeconds"] {
  const writes = record.message?.usage?.cache_creation;
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
    // With no record before it, or one stamped after the response it led to, the response itself is the latest defensible anchor.
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

/** The latest-state facts after one more transcript record, read in file order. Folding the records of the end of a transcript alone gives the facts the whole of it would, as long as the end holds a record that sets each. */
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
  /** The prompt cache's clock: when the request that last refreshed it was sent, and the tier its writes used (undefined until a write has shown one). Undefined when the main conversation has no request yet. */
  readonly promptCache: { readonly anchorAtMs: number; readonly ttlSeconds: number | undefined } | undefined;
}

/** Whether a prompt cache clock holds a request: one that has seen none says nothing about the cache. */
function hasRequest(cache: LatestState["cache"]): boolean {
  return cache.anchorAtMs !== undefined || cache.pendingAtMs !== undefined;
}

/**
 * The facts a state holds. `newer`, when given, is the latest-state facts folded from the end of the transcript alone while the cumulative ones are still being caught up: each of its facts that is set replaces the state's, because the end of the transcript is later than anything the state has read, and one it lacks is left as the state has it.
 */
export function sessionFactsOf(state: SessionState, newer?: LatestState): SessionFacts {
  const { cumulative } = state;
  const latest: LatestState = newer === undefined ? state.latest : { ...state.latest, ...definedOnly(newer), cache: hasRequest(newer.cache) ? newer.cache : state.latest.cache };
  const { cache } = latest;
  // A request still waiting for its response has already refreshed the cache, so it is the live anchor once it is later than the last response's. A pending request stamped earlier than that response is clock skew, and the earlier anchor is the one that cannot overstate the lifetime left.
  const anchorAtMs = cache.pendingAtMs !== undefined && (cache.anchorAtMs === undefined || cache.pendingAtMs > cache.anchorAtMs) ? cache.pendingAtMs : cache.anchorAtMs;
  return {
    title: [latest.customTitle, latest.slug, latest.aiTitle].flatMap((name) => (name === undefined ? [] : visibleDisplayText(name))).find((name) => name !== ""),
    startedAtMs: cumulative.startedAtMs,
    lastResponseAtMs: latest.lastAssistantAtMs,
    compactions: cumulative.compactions,
    promptCache: anchorAtMs === undefined ? undefined : { anchorAtMs, ttlSeconds: cache.ttlSeconds },
  };
}

/** The fields of `state` that are set, without the prompt cache clock. */
function definedOnly(state: LatestState): Omit<LatestState, "cache"> {
  const { lastAssistantAtMs, customTitle, slug, aiTitle } = state;
  return {
    ...(lastAssistantAtMs === undefined ? {} : { lastAssistantAtMs }),
    ...(customTitle === undefined ? {} : { customTitle }),
    ...(slug === undefined ? {} : { slug }),
    ...(aiTitle === undefined ? {} : { aiTitle }),
  };
}

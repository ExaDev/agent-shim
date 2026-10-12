import type { RoutingSetting } from "../headroom/routingSetting";
import { choiceFor } from "../headroom/routingSetting";
import { PROMPT_CACHE_TTL_MS } from "../usage/pick";

/** What the decision remembers about one session between its requests. */
interface SessionState {
  /** What was decided for the session's last request. */
  readonly viaHeadroom: boolean;
  /** When the session's last response finished, in epoch milliseconds. */
  readonly lastEndedAtMs: number;
  /** How much more the session's last response read from the prompt cache than it had to write or send afresh: positive when the cache carried most of the context, zero or negative when most of it was written new. */
  readonly cacheSurplusTokens: number;
  /** The force token of the last `--now` setting this session applied, so one request is applied once. */
  readonly appliedForce: number | undefined;
}

/** A finished response, as the decision learns it. */
interface ObservedResponse {
  readonly sessionId: string | undefined;
  readonly endedAtMs: number;
  /** What the response read from the prompt cache, wrote to it and sent uncached; undefined when the response reported no usage. */
  readonly cache: { readonly readTokens: number; readonly writtenTokens: number; readonly uncachedTokens: number } | undefined;
}

/**
 * Whether a session's requests cross headroom, decided per session rather than per launch.
 *
 * Anthropic's prompt cache keys on the exact bytes of the prefix, and headroom rewrites the history it forwards. Switching a session's routing while its cache is warm therefore presents a different prefix and rewrites the whole context. A session's decision is kept for as long as its cache could still be warm and re-taken only at a cache boundary, where nothing is lost by changing: no earlier response is known, the last one is older than the cache lifetime, or the last one read nothing from the cache (the session's cache was already cold, as after a compaction).
 */
export interface HeadroomDecision {
  /**
   * Whether this session's next request crosses headroom. What is wanted is the live routing setting that covers the session (its own, else the global one), else `launchFlag`, what its launch asked for. `available` asks whether the daemon can serve a request right now.
   *
   * Both are taken only at a boundary, where a session that wants headroom but finds the daemon unavailable goes direct, since it has no cache to lose and is better served than refused; it rejoins at its next boundary once the daemon is available. A setting made with `--now` is a boundary for the one request that first sees it, because the person chose to pay for the cache rewrite. Between boundaries the session's earlier choice stands, so a session already using headroom keeps replaying through it rather than being sent uncompressed. A request with no session id has no cache to protect and takes the same choice outright.
   */
  readonly decide: (sessionId: string | undefined, launchFlag: boolean, nowMs: number, available: () => Promise<boolean>) => Promise<boolean>;
  /** Records a finished response, which is what makes the next boundary known. */
  readonly observe: (response: ObservedResponse) => void;
}

/** Creates the decision, holding its per-session memory in process. `setting` is the live routing setting, read on every decision. An entry older than the cache lifetime is a boundary anyway, so it is dropped as responses are observed and the memory stays bounded by the sessions active within one cache lifetime. */
export function createHeadroomDecision(setting: () => RoutingSetting): HeadroomDecision {
  const sessions = new Map<string, SessionState>();
  return {
    decide: async (sessionId, launchFlag, nowMs, available) => {
      const choice = choiceFor(setting(), sessionId);
      const wanted = choice?.viaHeadroom ?? launchFlag;
      if (sessionId === undefined) {
        return wanted && (await available());
      }
      const state = sessions.get(sessionId);
      const forced = choice?.force !== undefined && choice.force !== state?.appliedForce;
      const atBoundary = forced || state === undefined || nowMs - state.lastEndedAtMs > PROMPT_CACHE_TTL_MS || state.cacheSurplusTokens <= 0;
      const viaHeadroom = atBoundary ? wanted && (await available()) : state.viaHeadroom;
      sessions.set(sessionId, {
        viaHeadroom,
        lastEndedAtMs: state?.lastEndedAtMs ?? nowMs,
        cacheSurplusTokens: state?.cacheSurplusTokens ?? 0,
        appliedForce: choice?.force ?? state?.appliedForce,
      });
      return viaHeadroom;
    },
    observe: ({ sessionId, endedAtMs, cache }) => {
      if (sessionId === undefined || cache === undefined) {
        return;
      }
      const cacheSurplusTokens = cache.readTokens - cache.writtenTokens - cache.uncachedTokens;
      const state = sessions.get(sessionId);
      if (state !== undefined) {
        sessions.set(sessionId, { ...state, lastEndedAtMs: endedAtMs, cacheSurplusTokens });
      }
      for (const [id, held] of sessions) {
        if (endedAtMs - held.lastEndedAtMs > PROMPT_CACHE_TTL_MS) {
          sessions.delete(id);
        }
      }
    },
  };
}

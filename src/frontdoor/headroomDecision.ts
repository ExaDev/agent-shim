import { PROMPT_CACHE_TTL_MS } from "../usage/pick";

/** What the decision remembers about one session between its requests. */
interface SessionState {
  /** What was decided for the session's last request. */
  readonly viaHeadroom: boolean;
  /** When the session's last response finished, in epoch milliseconds. */
  readonly lastEndedAtMs: number;
  /** The tokens the session's last response read from the prompt cache. */
  readonly cacheReadInputTokens: number;
}

/** A finished response, as the decision learns it. */
interface ObservedResponse {
  readonly sessionId: string | undefined;
  readonly endedAtMs: number;
  readonly cacheReadInputTokens: number | undefined;
}

/**
 * Whether a session's requests cross headroom, decided per session rather than per launch.
 *
 * Anthropic's prompt cache keys on the exact bytes of the prefix, and headroom rewrites the history it forwards. Switching a session's routing while its cache is warm therefore presents a different prefix and rewrites the whole context. A session's decision is kept for as long as its cache could still be warm and re-taken only at a cache boundary, where nothing is lost by changing: no earlier response is known, the last one is older than the cache lifetime, or the last one read nothing from the cache (the session's cache was already cold, as after a compaction).
 */
export interface HeadroomDecision {
  /**
   * Whether this session's next request crosses headroom. `wanted` is what the routing policy would choose now; it is taken only at a boundary, and otherwise the session's earlier choice stands. A request with no session id has no cache to protect and takes `wanted` outright.
   */
  readonly decide: (sessionId: string | undefined, wanted: boolean, nowMs: number) => boolean;
  /** Records a finished response, which is what makes the next boundary known. */
  readonly observe: (response: ObservedResponse) => void;
}

/** Creates the decision, holding its per-session memory in process. An entry older than the cache lifetime is a boundary anyway, so it is dropped as responses are observed and the memory stays bounded by the sessions active within one cache lifetime. */
export function createHeadroomDecision(): HeadroomDecision {
  const sessions = new Map<string, SessionState>();
  return {
    decide: (sessionId, wanted, nowMs) => {
      if (sessionId === undefined) {
        return wanted;
      }
      const state = sessions.get(sessionId);
      const atBoundary = state === undefined || nowMs - state.lastEndedAtMs > PROMPT_CACHE_TTL_MS || state.cacheReadInputTokens === 0;
      const viaHeadroom = atBoundary ? wanted : state.viaHeadroom;
      sessions.set(sessionId, { viaHeadroom, lastEndedAtMs: state?.lastEndedAtMs ?? nowMs, cacheReadInputTokens: state?.cacheReadInputTokens ?? 0 });
      return viaHeadroom;
    },
    observe: ({ sessionId, endedAtMs, cacheReadInputTokens }) => {
      if (sessionId === undefined || cacheReadInputTokens === undefined) {
        return;
      }
      const state = sessions.get(sessionId);
      if (state !== undefined) {
        sessions.set(sessionId, { ...state, lastEndedAtMs: endedAtMs, cacheReadInputTokens });
      }
      for (const [id, held] of sessions) {
        if (endedAtMs - held.lastEndedAtMs > PROMPT_CACHE_TTL_MS) {
          sessions.delete(id);
        }
      }
    },
  };
}

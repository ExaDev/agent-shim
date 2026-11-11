/**
 * Whether `nowMs` is within `windowMs` after `sinceMs`: the time since a stamp, bounded on both sides. A clock that has stepped backwards since the stamp (a time sync, a resume, a manual change) gives a negative age, which is no age within any window: a stamp from "the future" is stale, never fresh for as long as the step was long. A comparison of a stamp taken from the wall clock with a later reading of it goes through here.
 */
export function within(sinceMs: number, nowMs: number, windowMs: number): boolean {
  const age = nowMs - sinceMs;
  return age >= 0 && age < windowMs;
}

/**
 * For a window that holds something back (a retry backoff, a refresh allowance, a log interval): whether `nowMs` is within `windowMs` after `sinceMs`, and the stamp to keep. A clock that has stepped backwards since the stamp gives a stamp from the future, which `within` takes as no age at all: right for a cache, which is then read again, and wrong here, where it would lift the hold for as long as the step lasts. A hold restarts instead: the stamp is taken as `nowMs`, so the window runs from the step and is held for a whole window at most. The caller stores the returned `sinceMs`.
 */
export function holdFrom(sinceMs: number, nowMs: number, windowMs: number): { readonly held: boolean; readonly sinceMs: number } {
  const since = Math.min(sinceMs, nowMs);
  return { held: nowMs - since < windowMs, sinceMs: since };
}

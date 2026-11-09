/**
 * A deadline on the monotonic clock (`performance.now`): it moves only forward and at the rate of elapsed time, so a wall clock stepped by a daylight saving change, a time sync or a sleeping laptop neither fires a deadline early nor stretches it. Used wherever a local duration is bounded (a worker's deadline and stall limit, a launch's wait on the door); stamps another process reads back stay on the wall clock, since a monotonic reading means nothing outside its own process.
 */
export function deadlineAfter(ms: number, now: () => number = () => performance.now()): () => boolean {
  const end = now() + ms;
  return () => now() >= end;
}

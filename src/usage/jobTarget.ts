import type { Job, Pool } from "../config/schema";
import type { LayoutPaths } from "../paths";
import { rankPoolGraph } from "./poolPick";
import type { UsageReadFs } from "./read";

/** What resolving a job's target reads: the layout, the usage files, the pool table and the clock. */
export interface JobTargetDeps {
  readonly paths: LayoutPaths;
  readonly fs: UsageReadFs;
  readonly pools: Readonly<Record<string, Pool>>;
  readonly nowMs: number;
  readonly identityExists: (name: string) => boolean;
}

/**
 * The identity a job runs as: the identity it names, or the member the pool's ranking picks right now, undefined when none can be picked. Throws `PoolGraphError` for a pool that is not defined or a cycle, as a launch does.
 */
export function resolveJobIdentity(deps: Readonly<JobTargetDeps>, target: Job["target"]): string | undefined {
  if ("identity" in target) {
    return target.identity;
  }
  return rankPoolGraph({ fs: deps.fs, paths: deps.paths, pools: deps.pools, poolName: target.pool, nowMs: deps.nowMs, resuming: false, identityExists: deps.identityExists }).ranking.pick?.identity;
}

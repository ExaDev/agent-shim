import type { Pool } from "./config/schema";
import { splitMembers } from "./launcher/pool";
import type { FarmFs, FsPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";
import { rankPoolFromStore, readStickyPick } from "./usage/poolPick";
import type { Candidate, PoolRanking } from "./usage/pick";

/** What `pool pick` reports: the ranking a launch from `directory` would act on right now. */
export interface PoolPickReport {
  readonly pool: string;
  readonly directory: string;
  /** The member a launch would run as, absent when every member is refused. */
  readonly pick?: string;
  readonly candidates: readonly PoolPickCandidateView[];
  /** Members that name an identity that does not exist; a launch skips them. */
  readonly missing: readonly string[];
  /** When nothing can be picked, the soonest any member returns. */
  readonly earliestReturn?: { readonly identity: string; readonly at: string };
  /** Why the last-pick record could not be read, when that is the case. */
  readonly stickyProblem?: string;
}

/** One ranked member as `pool pick --json` prints it. */
interface PoolPickCandidateView {
  readonly identity: string;
  readonly class: Candidate["class"];
  readonly score?: number;
  readonly feasible: boolean;
  readonly blockedUntil?: string;
  readonly plan: Candidate["plan"];
  readonly reasons: readonly string[];
}

function candidateView(candidate: Candidate): PoolPickCandidateView {
  return {
    identity: candidate.identity,
    class: candidate.class,
    ...(candidate.score === undefined ? {} : { score: candidate.score }),
    feasible: candidate.feasible,
    ...(candidate.blockedUntilMs === undefined ? {} : { blockedUntil: new Date(candidate.blockedUntilMs).toISOString() }),
    plan: candidate.plan,
    reasons: candidate.reasons,
  };
}

/**
 * Ranks a pool exactly as a launch from `directory` would right now, without recording a pick. Shares `rankPoolFromStore` with the launcher, so what this prints is what a launch does.
 */
export function collectPoolPick(params: Readonly<{ paths: LayoutPaths; fs: FsPort; usageFs: FarmFs; poolName: string; pool: Pool; directory: string; nowMs: number }>): PoolPickReport {
  const { present, missing } = splitMembers(params.pool, params.paths, params.fs);
  const sticky = readStickyPick(params.usageFs, params.paths.usagePicksFile, params.directory);
  const ranking: PoolRanking = rankPoolFromStore({
    fs: params.usageFs,
    paths: params.paths,
    identities: present,
    nowMs: params.nowMs,
    resuming: false,
    ...(sticky.sticky === undefined ? {} : { sticky: sticky.sticky }),
  });
  return {
    pool: params.poolName,
    directory: params.directory,
    ...(ranking.pick === undefined ? {} : { pick: ranking.pick.identity }),
    candidates: ranking.candidates.map(candidateView),
    missing,
    ...(ranking.earliestReturn === undefined ? {} : { earliestReturn: { identity: ranking.earliestReturn.identity, at: new Date(ranking.earliestReturn.atMs).toISOString() } }),
    ...(sticky.problem === undefined ? {} : { stickyProblem: sticky.problem }),
  };
}

import type { Pool } from "./config/schema";
import { identityIdResolver } from "./launcher/identity";
import type { FarmFs, FsPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";
import { rankPoolGraph, readStickyPick, type ProviderOf } from "./usage/poolPick";
import type { Candidate, PoolRanking } from "./usage/pick";
import type { PoolPickReport } from "./usage/pickReportSchema";

type PoolPickCandidateView = PoolPickReport["candidates"][number];

function candidateView(candidate: Candidate): PoolPickCandidateView {
  return {
    identity: candidate.identity,
    class: candidate.class,
    ...(candidate.score === undefined ? {} : { score: candidate.score }),
    ...(candidate.scoreWindow === undefined ? {} : { scoreWindow: candidate.scoreWindow }),
    feasible: candidate.feasible,
    ...(candidate.blockedUntilMs === undefined ? {} : { blockedUntil: new Date(candidate.blockedUntilMs).toISOString() }),
    plan: candidate.plan,
    ...(candidate.provider === undefined ? {} : { provider: candidate.provider }),
    reasons: [...candidate.reasons],
  };
}

/**
 * Ranks a pool exactly as a launch from `directory` would right now, without recording a pick. Shares `rankPoolGraph` with the launcher, so what this prints is what a launch does. `providerOf` names the provider a launch of each member routes through, so the report ranks each member on that provider's quota; without it every member is ranked on its Claude account.
 */
export function collectPoolPick(params: Readonly<{ paths: LayoutPaths; fs: FsPort; usageFs: FarmFs; poolName: string; pools: Readonly<Record<string, Pool>>; directory: string; nowMs: number; providerOf?: ProviderOf }>): PoolPickReport {
  const sticky = readStickyPick(params.usageFs, params.paths.usagePicksFile, params.directory);
  const { ranking, missing }: { ranking: PoolRanking; missing: readonly { pool: string; identity: string }[] } = rankPoolGraph({
    fs: params.usageFs,
    paths: params.paths,
    pools: params.pools,
    poolName: params.poolName,
    nowMs: params.nowMs,
    resuming: false,
    identityIdOf: identityIdResolver(params.paths.identitiesDir, params.fs),
    ...(params.providerOf === undefined ? {} : { providerOf: params.providerOf }),
    ...(sticky.sticky === undefined ? {} : { sticky: sticky.sticky }),
  });
  return {
    pool: params.poolName,
    directory: params.directory,
    ...(ranking.pick === undefined ? {} : { pick: ranking.pick.identity }),
    candidates: ranking.candidates.map(candidateView),
    missing: missing.map(({ identity }) => identity),
    ...(ranking.earliestReturn === undefined ? {} : { earliestReturn: { identity: ranking.earliestReturn.identity, at: new Date(ranking.earliestReturn.atMs).toISOString() } }),
    ...(ranking.movedOff === undefined ? {} : { movedOff: ranking.movedOff }),
    ...(sticky.problem === undefined ? {} : { stickyProblem: sticky.problem }),
  };
}

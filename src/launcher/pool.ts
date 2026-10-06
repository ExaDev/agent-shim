import type { Pool } from "../config/schema";
import { loadIdentity } from "./identity";
import type { LayoutPaths } from "../paths";
import { formatAge } from "../usage/preflight";
import { PoolGraphError, rankPoolGraph, readStickyPick, recordStickyPick, type PoolPickFs } from "../usage/poolPick";
import type { FarmFs, FsPort, LogPort } from "./ports";

/** The flags that continue or resume an earlier conversation, which belongs on the account it started on. */
const RESUME_FLAGS: ReadonlySet<string> = new Set(["--continue", "-c", "--resume", "-r"]);

/** The token that ends agent-shim's own flag recognition and begins what claude (or a command it runs) receives. */
const TERMINATOR = "--";

/** How many of the chosen member's reasons the launch's log line carries. */
const REASONS_LOGGED = 3;

/** Everything one pool pick needs, injected so it runs against the same fakes as the rest of the launcher. */
export interface ResolvePoolParams {
  readonly poolName: string;
  /** Which precedence rule selected the pool, for the refusal messages. */
  readonly selectedVia: string;
  readonly pools: Readonly<Record<string, Pool>> | undefined;
  readonly paths: LayoutPaths;
  readonly fs: FsPort;
  readonly usageFs: PoolPickFs & Pick<FarmFs, "writeFilePrivate" | "mkdirPrivate">;
  /** The launch directory: the key of the last-pick record. */
  readonly cwd: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  /** The arguments claude itself will receive. */
  readonly passthrough: readonly string[];
  /** Sleep until the earliest member returns, instead of refusing, when every member is refused. */
  readonly wait: boolean;
  readonly log: LogPort;
}

/** The pick, or why none could be made. */
export type PoolResolution =
  | {
      readonly ok: true;
      readonly identity: string;
      /** The pool and the chosen member's leading reasons, for the launch's decision line. */
      readonly explanation: string;
    }
  | { readonly ok: false; readonly message: string };

/** Whether the arguments claude will receive continue or resume a conversation. Only tokens before a `--` terminator count: after it they belong to a command claude runs. */
function isResuming(passthrough: readonly string[]): boolean {
  const end = passthrough.indexOf(TERMINATOR);
  return (end === -1 ? passthrough : passthrough.slice(0, end)).some((token) => RESUME_FLAGS.has(token));
}

/**
 * Picks the identity a launch of pool `poolName` runs as.
 *
 * The pool is ranked with everything it nests, each pool under its own preference. Members without an `identity.json` are skipped with a warning, since a pool may outlive an identity it names; a nested member naming an undefined pool or a cycle (config edited since it was written) refuses the launch. When every remaining member is refused right now the launch is refused, naming the earliest return, unless `wait` is set, which sleeps until then and ranks again. The chosen member is recorded as this directory's last pick so the next launch here keeps its warm prompt cache.
 */
export function resolvePoolLaunch(params: ResolvePoolParams): PoolResolution {
  const { poolName, log } = params;
  const pool = params.pools?.[poolName];
  if (pool === undefined) {
    return { ok: false, message: `agent-shim: no pool named "${poolName}" (selected via ${params.selectedVia}). Run \`agent-shim pool add ${poolName} --identity <name>...\` first.` };
  }

  const resuming = isResuming(params.passthrough);
  const stickyRead = readStickyPick(params.usageFs, params.paths.usagePicksFile, params.cwd);
  if (stickyRead.problem !== undefined) {
    log.warn(`agent-shim: ${stickyRead.problem}; ignoring the last-pick record`);
  }

  const warned = new Set<string>();
  for (;;) {
    const nowMs = params.now();
    let graph;
    try {
      graph = rankPoolGraph({
        fs: params.usageFs,
        paths: params.paths,
        pools: params.pools ?? {},
        poolName,
        nowMs,
        resuming,
        identityExists: (name) => loadIdentity(params.paths.identitiesDir, name, params.fs) !== undefined,
        ...(stickyRead.sticky === undefined ? {} : { sticky: stickyRead.sticky }),
      });
    } catch (error) {
      if (error instanceof PoolGraphError) {
        return { ok: false, message: `agent-shim: ${error.message}` };
      }
      throw error;
    }
    for (const gone of graph.missing) {
      const key = `${gone.pool}:${gone.identity}`;
      if (!warned.has(key)) {
        warned.add(key);
        log.warn(`agent-shim: pool "${gone.pool}" names identity "${gone.identity}", which does not exist; skipping it`);
      }
    }
    // Only identity entries can fail to contribute (a nested entry always contributes a pick or a refusal), so an empty ranking means every member named an identity that does not exist.
    if (graph.ranking.candidates.length === 0) {
      return { ok: false, message: `agent-shim: no member of pool "${poolName}" is an existing identity.` };
    }
    const { pick, earliestReturn } = graph.ranking;
    if (pick !== undefined) {
      recordStickyPick(params.usageFs, params.paths.usagePicksFile, params.cwd, pick.identity, nowMs);
      return { ok: true, identity: pick.identity, explanation: `pool ${poolName}: ${pick.reasons.slice(0, REASONS_LOGGED).join("; ")}` };
    }
    if (earliestReturn === undefined) {
      return { ok: false, message: `agent-shim: no member of pool "${poolName}" can be picked.` };
    }
    const until = new Date(earliestReturn.atMs).toISOString();
    if (!params.wait) {
      return {
        ok: false,
        message: `agent-shim: every member of pool "${poolName}" is refused right now; the earliest, ${earliestReturn.identity}, returns at ${until} (in ${formatAge(earliestReturn.atMs - nowMs)}). Pass --wait to sleep until then.`,
      };
    }
    log.info(`agent-shim: every member of pool "${poolName}" is refused; waiting until ${until} for ${earliestReturn.identity}`);
    params.sleep(Math.max(earliestReturn.atMs - nowMs, 0));
  }
}

import type { Pool } from "../config/schema";
import type { LayoutPaths } from "../paths";
import { formatAge } from "../usage/preflight";
import { rankPoolFromStore, readStickyPick, recordStickyPick, type PoolPickFs } from "../usage/poolPick";
import type { FarmFs, FsPort, LogPort } from "./ports";
import { loadIdentity } from "./identity";

/** The flags that continue or resume an earlier conversation, which belongs on the account it started on. */
const RESUME_FLAGS: ReadonlySet<string> = new Set(["--continue", "-c", "--resume", "-r"]);

/** The token that ends claude-use's own flag recognition and begins what claude (or a command it runs) receives. */
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

/** A pool's members split by whether each is an identity that exists: a pool may outlive an identity it names, since removing an identity does not rewrite the pools that list it. */
export function splitMembers(pool: Pool, paths: Pick<LayoutPaths, "identitiesDir">, fs: FsPort): { readonly present: readonly string[]; readonly missing: readonly string[] } {
  const exists = (name: string): boolean => loadIdentity(paths.identitiesDir, name, fs) !== undefined;
  return { present: pool.identities.filter(exists), missing: pool.identities.filter((name) => !exists(name)) };
}

/** Whether the arguments claude will receive continue or resume a conversation. Only tokens before a `--` terminator count: after it they belong to a command claude runs. */
function isResuming(passthrough: readonly string[]): boolean {
  const end = passthrough.indexOf(TERMINATOR);
  return (end === -1 ? passthrough : passthrough.slice(0, end)).some((token) => RESUME_FLAGS.has(token));
}

/**
 * Picks the identity a launch of pool `poolName` runs as.
 *
 * Members without an `identity.json` are skipped with a warning, since a pool may outlive an identity it names. When every remaining member is refused right now the launch is refused, naming the earliest return, unless `wait` is set, which sleeps until then and ranks again. The chosen member is recorded as this directory's last pick so the next launch here keeps its warm prompt cache.
 */
export function resolvePoolLaunch(params: ResolvePoolParams): PoolResolution {
  const { poolName, log } = params;
  const pool = params.pools?.[poolName];
  if (pool === undefined) {
    return { ok: false, message: `claude-use: no pool named "${poolName}" (selected via ${params.selectedVia}). Run \`claude-use pool add ${poolName} --identity <name>...\` first.` };
  }
  const { present: identities, missing } = splitMembers(pool, params.paths, params.fs);
  for (const name of missing) {
    log.warn(`claude-use: pool "${poolName}" names identity "${name}", which does not exist; skipping it`);
  }
  if (identities.length === 0) {
    return { ok: false, message: `claude-use: no member of pool "${poolName}" is an existing identity.` };
  }

  const resuming = isResuming(params.passthrough);
  const stickyRead = readStickyPick(params.usageFs, params.paths.usagePicksFile, params.cwd);
  if (stickyRead.problem !== undefined) {
    log.warn(`claude-use: ${stickyRead.problem}; ignoring the last-pick record`);
  }

  for (;;) {
    const nowMs = params.now();
    const ranking = rankPoolFromStore({ fs: params.usageFs, paths: params.paths, identities, nowMs, resuming, ...(stickyRead.sticky === undefined ? {} : { sticky: stickyRead.sticky }) });
    const { pick, earliestReturn } = ranking;
    if (pick !== undefined) {
      recordStickyPick(params.usageFs, params.paths.usagePicksFile, params.cwd, pick.identity, nowMs);
      return { ok: true, identity: pick.identity, explanation: `pool ${poolName}: ${pick.reasons.slice(0, REASONS_LOGGED).join("; ")}` };
    }
    if (earliestReturn === undefined) {
      return { ok: false, message: `claude-use: no member of pool "${poolName}" can be picked.` };
    }
    const until = new Date(earliestReturn.atMs).toISOString();
    if (!params.wait) {
      return {
        ok: false,
        message: `claude-use: every member of pool "${poolName}" is refused right now; the earliest, ${earliestReturn.identity}, returns at ${until} (in ${formatAge(earliestReturn.atMs - nowMs)}). Pass --wait to sleep until then.`,
      };
    }
    log.info(`claude-use: every member of pool "${poolName}" is refused; waiting until ${until} for ${earliestReturn.identity}`);
    params.sleep(Math.max(earliestReturn.atMs - nowMs, 0));
  }
}

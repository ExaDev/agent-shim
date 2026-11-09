import { poolMemberIdentity, type Job, type Pool, type WhenCondition } from "./config/schema";
import { poolNameOf } from "./launcher/identity";
import { referencesFact } from "./resolve/conditions";
import { ANTHROPIC_PROVIDER } from "./usage/middleware";
import { soleOverageWindow } from "./usage/rateLimit";
import type { UsageSnapshot } from "./usage/schema";

/** A quota window a condition, compaction trigger or job can read, named as the condition facts name it. */
type QuotaWindowName = "fiveHour" | "sevenDay" | "extraUsage";

const WINDOW_NAMES: readonly QuotaWindowName[] = ["fiveHour", "sevenDay", "extraUsage"];

/** How each window is written in a finding. */
const WINDOW_PROSE: Readonly<Record<QuotaWindowName, string>> = { fiveHour: "five-hour", sevenDay: "seven-day", extraUsage: "extra-usage" };

/** The facts a member condition can read under each window, which are exactly what `quotaFactsOf` answers for it. */
const WINDOW_FACTS = ["remaining", "utilization", "hoursUntilReset"] as const;

/** A fact that is not under a window's own name but is measured from one: the observed pace is read from the five-hour window's readings, so a member without that window never has it. */
const DERIVED_FACTS: readonly { readonly key: string; readonly window: QuotaWindowName }[] = [{ key: "quota.burnPerHour", window: "fiveHour" }];

/**
 * The windows an identity's last recorded Anthropic state holds, or undefined when no rate-limit state has been recorded, so what it receives is unknown. A window counts as received when the state holds it at all, whether or not it has reset or reported a utilisation: a lapsed window is a transient state of a window the account has, while an absent one is the account's plan. The extra-usage allowance counts only when it is the account's sole budget, as it is the only case in which a condition can read it.
 */
export function receivedWindows(snapshot: UsageSnapshot | undefined): ReadonlySet<QuotaWindowName> | undefined {
  const unified = snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified;
  if (unified === undefined) {
    return undefined;
  }
  return new Set<QuotaWindowName>([...(unified.fiveHour === undefined ? [] : ["fiveHour" as const]), ...(unified.sevenDay === undefined ? [] : ["sevenDay" as const]), ...(soleOverageWindow(unified) === undefined ? [] : ["extraUsage" as const])]);
}

/** The window reads a condition makes, each with the reference that makes it, in the order the windows are listed. */
function conditionReads(when: WhenCondition): readonly { readonly window: QuotaWindowName; readonly reference: string }[] {
  const direct = WINDOW_NAMES.flatMap((window) => (WINDOW_FACTS.some((fact) => referencesFact(when, `quota.${window}.${fact}`)) ? [{ window, reference: `quota.${window}` }] : []));
  const derived = DERIVED_FACTS.flatMap(({ key, window }) => (referencesFact(when, key) ? [{ window, reference: key }] : []));
  return [...direct, ...derived];
}

/** One warning, with the pool or job it is about. */
interface WindowReadFinding {
  readonly subject: string;
  readonly message: string;
}

/** `windowsOf` asked once for each identity however many selectors reach it. */
function askedOnce(windowsOf: (identity: string) => ReadonlySet<QuotaWindowName> | undefined): (identity: string) => ReadonlySet<QuotaWindowName> | undefined {
  const received = new Map<string, ReadonlySet<QuotaWindowName> | undefined>();
  return (identity) => {
    if (!received.has(identity)) {
      received.set(identity, windowsOf(identity));
    }
    return received.get(identity);
  };
}

/** What makes an identity worth listing for a selector: it is known to lack any one of `windows`, or all of them. */
interface Lacking {
  readonly kind: "any" | "all";
  readonly windows: readonly QuotaWindowName[];
}

/**
 * For each selector asked about, the identities it can run as that satisfy a `Lacking` (known to lack the windows), in the order `identitiesOf` meets them. The windows of an identity are read once, however many selectors reach it. Whether a pool reaches any such identity is worked out once for each pool, so a walk enters only pools that reach one: a chain of pools that each nest the next costs a lookup for each pool where none does. A pool that reaches such identities only through one nested pool has that pool's list, which is shared and not walked again, so the chain costs one walk. Any other pool is walked once for each selector asked, bounded by the pools below it that reach such an identity. A pool whose search meets a pool already on its path (a cycle, which the doctor reports on its own) is neither pruned nor shared, and is walked as `identitiesOf` walks it, since which pools a walk skips then depends on where it began.
 */
function lackingReader(pools: Readonly<Record<string, Pool>>, receivedBy: (identity: string) => ReadonlySet<QuotaWindowName> | undefined): (selector: string, lacking: Lacking) => readonly string[] {
  const lacks = (identity: string, { kind, windows }: Lacking): boolean => {
    const has = receivedBy(identity);
    return has !== undefined && (kind === "any" ? windows.some((window) => !has.has(window)) : windows.every((window) => !has.has(window)));
  };
  const keyOf = (name: string, { kind, windows }: Lacking): string => `${kind}\u0000${windows.join(",")}\u0000${name}`;
  /** Whether each pool reaches a lacking identity, for pools whose search met no cycle. */
  const reaches = new Map<string, boolean>();
  const reachesLacking = (name: string, lacking: Lacking, path: Set<string>): { readonly has: boolean; readonly cyclic: boolean } => {
    const known = reaches.get(keyOf(name, lacking));
    if (known !== undefined) {
      return { has: known, cyclic: false };
    }
    const pool = pools[name];
    if (pool === undefined) {
      return { has: false, cyclic: false };
    }
    if (path.has(name)) {
      return { has: false, cyclic: true };
    }
    path.add(name);
    let has = false;
    let cyclic = false;
    for (const member of pool.identities) {
      const identity = poolMemberIdentity(member);
      const nested = poolNameOf(identity);
      if (nested === undefined) {
        has ||= lacks(identity, lacking);
      } else {
        const below = reachesLacking(nested, lacking, path);
        has ||= below.has;
        cyclic ||= below.cyclic;
      }
    }
    path.delete(name);
    if (!cyclic) {
      reaches.set(keyOf(name, lacking), has);
    }
    return { has, cyclic };
  };
  const answers = new Map<string, readonly string[]>();
  const lackingOfPool = (name: string, lacking: Lacking): readonly string[] => {
    const answered = answers.get(keyOf(name, lacking));
    if (answered !== undefined) {
      return answered;
    }
    const prune = !reachesLacking(name, lacking, new Set()).cyclic;
    const members = (pools[name]?.identities ?? []).map(poolMemberIdentity);
    const direct = members.filter((identity) => poolNameOf(identity) === undefined && lacks(identity, lacking));
    const sources = members.flatMap((identity) => {
      const nested = poolNameOf(identity);
      return nested === undefined || pools[nested] === undefined || !reachesLacking(nested, lacking, new Set()).has ? [] : [nested];
    });
    let found: readonly string[];
    if (prune && direct.length === 0 && new Set(sources).size === 1 && sources[0] !== undefined) {
      found = lackingOfPool(sources[0], lacking);
    } else {
      const walked = new Set<string>([name]);
      const out = new Set<string>();
      const walk = (current: string): void => {
        for (const identity of (pools[current]?.identities ?? []).map(poolMemberIdentity)) {
          const nested = poolNameOf(identity);
          if (nested === undefined) {
            if (lacks(identity, lacking)) {
              out.add(identity);
            }
          } else if (pools[nested] !== undefined && !walked.has(nested) && (!prune || reachesLacking(nested, lacking, new Set()).has)) {
            walked.add(nested);
            walk(nested);
          }
        }
      };
      walk(name);
      found = [...out];
    }
    if (prune) {
      answers.set(keyOf(name, lacking), found);
    }
    return found;
  };
  return (selector, lacking) => {
    const nested = poolNameOf(selector);
    return nested === undefined ? (lacks(selector, lacking) ? [selector] : []) : lackingOfPool(nested, lacking);
  };
}

/**
 * The pools whose configuration reads a quota window that one of the identities it can run as does not currently receive, by what each identity's recorded state holds (`receivedWindows`): a member condition naming a window the member lacks is undecided for it, so the member is always ranked last within its class; a pool that compacts before the limit cannot measure a member that reports neither plan window. An identity whose windows are unknown is never reported. The findings name identities by their configured names only.
 */
export function poolWindowReadFindings(pools: Readonly<Record<string, Pool>>, windowsOf: (identity: string) => ReadonlySet<QuotaWindowName> | undefined): readonly WindowReadFinding[] {
  const findings: WindowReadFinding[] = [];
  const windowsOnce = askedOnce(windowsOf);
  const lackingOf = lackingReader(pools, windowsOnce);
  for (const [poolName, pool] of Object.entries(pools)) {
    for (const member of pool.identities) {
      if (typeof member === "string") {
        continue;
      }
      const reads = conditionReads(member.when);
      const windows = [...new Set(reads.map((read) => read.window))];
      for (const identity of lackingOf(member.identity, { kind: "any", windows })) {
        const received = windowsOnce(identity);
        for (const { window, reference } of reads) {
          if (received !== undefined && !received.has(window)) {
            findings.push({ subject: poolName, message: `Pool "${poolName}" guards ${member.identity} with a condition that reads ${reference}, but ${identity} reports no ${WINDOW_PROSE[window]} window, so the condition is undecided for it and it always ranks last within its class.` });
          }
        }
      }
    }
    if (pool.compactBeforeLimit === true) {
      for (const identity of lackingOf(`pool:${poolName}`, { kind: "all", windows: ["fiveHour", "sevenDay"] })) {
        findings.push({ subject: poolName, message: `Pool "${poolName}" compacts before the limit, but ${identity} reports no five-hour or seven-day window, so its sessions are never compacted before the limit.` });
      }
    }
  }
  return findings;
}

/** The before-reset jobs whose window one of the identities they can run as does not currently receive: the job keeper skips the job whenever its identity is one of those. An identity whose windows are unknown is never reported. */
export function jobWindowReadFindings(jobs: Readonly<Record<string, Job>>, pools: Readonly<Record<string, Pool>>, windowsOf: (identity: string) => ReadonlySet<QuotaWindowName> | undefined): readonly WindowReadFinding[] {
  const lackingOf = lackingReader(pools, askedOnce(windowsOf));
  return Object.entries(jobs).flatMap(([jobName, job]) => {
    const { trigger, target } = job;
    if (!("beforeReset" in trigger)) {
      return [];
    }
    return lackingOf("pool" in target ? `pool:${target.pool}` : target.identity, { kind: "any", windows: [trigger.beforeReset] }).map((identity) => ({ subject: jobName, message: `Job "${jobName}" runs before the ${WINDOW_PROSE[trigger.beforeReset]} window resets, but ${identity} reports no ${WINDOW_PROSE[trigger.beforeReset]} window, so the job is skipped whenever it runs as ${identity}.` }));
  });
}

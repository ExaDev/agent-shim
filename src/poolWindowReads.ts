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

/** The identities a selector can run as: itself, or every identity a nested pool can pick, through any depth of nesting, each once in the order the walk meets them. A pool is walked once, so a cycle (which the doctor reports on its own) ends the walk and a pool nested by several others adds nothing the second time. */
function identitiesOf(selector: string, pools: Readonly<Record<string, Pool>>): readonly string[] {
  const found = new Set<string>();
  const walked = new Set<string>();
  const walk = (current: string): void => {
    const nested = poolNameOf(current);
    if (nested === undefined) {
      found.add(current);
      return;
    }
    const pool = pools[nested];
    if (pool === undefined || walked.has(nested)) {
      return;
    }
    walked.add(nested);
    for (const member of pool.identities) {
      walk(poolMemberIdentity(member));
    }
  };
  walk(selector);
  return [...found];
}

/** One warning, with the pool or job it is about. */
interface WindowReadFinding {
  readonly subject: string;
  readonly message: string;
}

/**
 * The pools whose configuration reads a quota window that one of the identities it can run as does not currently receive, by what each identity's recorded state holds (`receivedWindows`): a member condition naming a window the member lacks is undecided for it, so the member is always ranked last within its class; a pool that compacts before the limit cannot measure a member that reports neither plan window. An identity whose windows are unknown is never reported. The findings name identities by their configured names only.
 */
export function poolWindowReadFindings(pools: Readonly<Record<string, Pool>>, windowsOf: (identity: string) => ReadonlySet<QuotaWindowName> | undefined): readonly WindowReadFinding[] {
  const findings: WindowReadFinding[] = [];
  for (const [poolName, pool] of Object.entries(pools)) {
    for (const member of pool.identities) {
      if (typeof member === "string") {
        continue;
      }
      const reads = conditionReads(member.when);
      for (const identity of identitiesOf(member.identity, pools)) {
        const received = windowsOf(identity);
        for (const { window, reference } of reads) {
          if (received !== undefined && !received.has(window)) {
            findings.push({ subject: poolName, message: `Pool "${poolName}" guards ${member.identity} with a condition that reads ${reference}, but ${identity} reports no ${WINDOW_PROSE[window]} window, so the condition is undecided for it and it always ranks last within its class.` });
          }
        }
      }
    }
    if (pool.compactBeforeLimit === true) {
      for (const identity of identitiesOf(`pool:${poolName}`, pools)) {
        const received = windowsOf(identity);
        if (received !== undefined && !received.has("fiveHour") && !received.has("sevenDay")) {
          findings.push({ subject: poolName, message: `Pool "${poolName}" compacts before the limit, but ${identity} reports no five-hour or seven-day window, so its sessions are never compacted before the limit.` });
        }
      }
    }
  }
  return findings;
}

/** The before-reset jobs whose window one of the identities they can run as does not currently receive: the job keeper skips the job whenever its identity is one of those. An identity whose windows are unknown is never reported. */
export function jobWindowReadFindings(jobs: Readonly<Record<string, Job>>, pools: Readonly<Record<string, Pool>>, windowsOf: (identity: string) => ReadonlySet<QuotaWindowName> | undefined): readonly WindowReadFinding[] {
  return Object.entries(jobs).flatMap(([jobName, job]) => {
    const { trigger, target } = job;
    if (!("beforeReset" in trigger)) {
      return [];
    }
    const identities = "pool" in target ? identitiesOf(`pool:${target.pool}`, pools) : identitiesOf(target.identity, pools);
    return identities.flatMap((identity) => {
      const received = windowsOf(identity);
      return received === undefined || received.has(trigger.beforeReset) ? [] : [{ subject: jobName, message: `Job "${jobName}" runs before the ${WINDOW_PROSE[trigger.beforeReset]} window resets, but ${identity} reports no ${WINDOW_PROSE[trigger.beforeReset]} window, so the job is skipped whenever it runs as ${identity}.` }];
    });
  });
}

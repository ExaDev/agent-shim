/** What one picker entry says about an identity, each part present only when something is recorded for it. */
export interface PickerRowFacts {
  readonly identity: string;
  /** Its place in a pool pick's ranking, from 1. */
  readonly rank?: number;
  /** The ranking's own description of the member (`pool pick` words it), such as its class and score. */
  readonly heading?: string;
  /** True for the member the pool pick chose. */
  readonly picked?: boolean;
  /** What qualifies the entry ahead of its account: why the identity cannot be used right now, or which members a pool has. */
  readonly detail?: string;
  /** Who the identity's login is: email, organisation with role, plan, as the launch banner's account row words it. */
  readonly account?: string;
  /** How much of its quota is used, as the launch banner's quota row words it. */
  readonly quota?: string;
}

/** The separator between what a picker entry says about an identity. */
const PART_SEPARATOR = " | ";

/**
 * The one line a picker entry shows: the identity (numbered, described and marked when it is part of a ranking), then what qualifies it, its account and its quota, each only when known.
 */
export function pickerLabel(facts: Readonly<PickerRowFacts>): string {
  const name = [facts.rank === undefined ? undefined : `${String(facts.rank)}.`, facts.identity, facts.heading, facts.picked === true ? "(picked)" : undefined].filter((part) => part !== undefined).join(" ");
  return [name, facts.detail, facts.account, facts.quota].filter((part) => part !== undefined).join(PART_SEPARATOR);
}

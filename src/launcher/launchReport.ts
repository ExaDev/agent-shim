import type { LaunchPoolDecision } from "../launcher";
import { candidateHeading, describeWindow } from "../usage/candidateText";
import { ANTHROPIC_PROVIDER } from "../usage/middleware";
import type { Candidate } from "../usage/pick";
import { planOf } from "../usage/plan";
import { effectiveWindow, formatAge } from "../usage/preflight";
import { formatPeriod } from "../usage/resets";
import type { AccountMetadata, QuotaWindow, UsageSnapshot } from "../usage/schema";
import type { ReportRow } from "./ports";

/** What a launch reads to say which account it bills and how much of that account's quota is left, as recorded: nothing here is fetched at launch. */
export interface BillingFacts {
  /** The identity's stored login (`oauthAccount` in its `.claude.json`), when it has one. */
  readonly login: AccountMetadata | undefined;
  /** The identity's usage snapshot, when the front door has recorded one; its `account` is the login's fallback. */
  readonly snapshot: UsageSnapshot | undefined;
  /** The provider the launch routes through, when it does; the launch then bills the provider's account, not the identity's login. */
  readonly provider: string | undefined;
  /** The instant the windows are read at. */
  readonly nowMs: number;
}

/** The identity a directory's launches last ran as, before this one. */
export interface LastRanAs {
  readonly identity: string;
  /** How long before this launch that was. */
  readonly agoMs: number;
}

/** What a launch decided about who it runs as, as data. */
interface DecisionFacts {
  readonly identity: string | undefined;
  /** Which precedence rule selected the identity. */
  readonly identitySource: string;
  /** The pool pick behind the identity, when the launch selected a pool. */
  readonly pool: LaunchPoolDecision | undefined;
  /** Every member the pool pick ranked, best first, when the launch asks for its pick explained. */
  readonly ranking: readonly Candidate[] | undefined;
  /** The configuration profile that applied, when one did. */
  readonly profile: { readonly name: string; readonly source: string } | undefined;
  /** The provider the launch routes through, with where its credential comes from. */
  readonly provider: { readonly name: string; readonly credential: string } | undefined;
  /** Where the identity's own credential comes from, when the launch applies one. */
  readonly identityCredential: string | undefined;
  /** What the account and quota rows read, when the launch runs as an identity with a farm. */
  readonly billing: Readonly<BillingFacts> | undefined;
  /** The identity this directory's last pool pick ran as, read before this launch's pick replaced it. */
  readonly lastRanAs: Readonly<LastRanAs> | undefined;
  /** The pool member a resume-on-limit relaunch leaves, when the launch is that relaunch. */
  readonly limitRelaunchFrom: string | undefined;
}

/** What the pool row says beside the pool's name: the pick's decisive reason, the first the ranking gave. The ranking's other reasons are scoring caveats, left to `agent-shim pool pick`; a resumed conversation's move off a member has its own `moved` row. */
function poolDetail(pool: LaunchPoolDecision): Pick<ReportRow, "detail"> {
  const [reason] = pool.reasons;
  return reason === undefined ? {} : { detail: reason };
}

/** The lines that explain a pool pick: every member in rank order with its class and score, the one picked marked, and the facts behind each, in the words `pool pick` uses. */
function rankingNotes(ranking: readonly Candidate[], picked: string | undefined): readonly string[] {
  return ranking.flatMap((candidate, index) => [
    `${String(index + 1)}. ${candidate.identity} ${candidateHeading(candidate)}${candidate.identity === picked ? " (picked)" : ""}`,
    `   ${candidate.reasons.join("; ")}`,
  ]);
}

/** The organisation types whose name identifies a shared plan; a personal plan's `organizationName` is only the account holder's own name, redundant beside the email (the statusline's account segment draws the same line). */
const NAMED_ORGANISATION_TYPES: ReadonlySet<string> = new Set(["claude_team", "claude_enterprise"]);

/** The plan as the pool ranking classifies it: its multiple of the smallest paid tier, or that it bills by use. Absent for a tier the classification does not recognise, rather than a multiplier it only guessed. */
function planText(account: Readonly<AccountMetadata>): string | undefined {
  const plan = planOf(account);
  if (plan.kind === "pay-per-use") {
    return "pay-per-use";
  }
  return plan.recognised ? `${String(plan.capacity)}x` : undefined;
}

/** The email, the organisation with the account's role in it, and the plan, each when the login records it. */
function loginAccountText(account: Readonly<AccountMetadata>): string | undefined {
  const organisation =
    account.organizationName !== undefined && account.organizationType !== undefined && NAMED_ORGANISATION_TYPES.has(account.organizationType)
      ? account.organizationRole === undefined
        ? account.organizationName
        : `${account.organizationName} (${account.organizationRole})`
      : undefined;
  const parts = [account.emailAddress, organisation, planText(account)].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** The account row: the login's account (the stored login, else the usage snapshot's copy of it, as the pool pick reads it) for an OAuth launch, or the account and level the provider's usage endpoint reported for a provider launch, whose billing the identity's login has no part in. Nothing when none is recorded. */
export function accountRows(billing: Readonly<BillingFacts> | undefined): readonly ReportRow[] {
  if (billing === undefined) {
    return [];
  }
  if (billing.provider !== undefined) {
    const quota = billing.snapshot?.providers[billing.provider]?.quota;
    const parts = [quota?.account?.email, quota?.level].filter((part) => part !== undefined);
    return parts.length === 0 ? [] : [{ label: "account", value: parts.join(", "), detail: `provider ${billing.provider}` }];
  }
  const account = billing.login ?? billing.snapshot?.account;
  const text = account === undefined ? undefined : loginAccountText(account);
  return text === undefined ? [] : [{ label: "account", value: text }];
}

/** Whether a recorded window says anything: a usage, a reset instant, or that its reset has passed. */
function isInformative(window: Readonly<QuotaWindow>, nowMs: number): boolean {
  const effective = effectiveWindow(window, nowMs);
  return effective.reset || effective.utilization !== undefined || effective.resetsAtMs !== undefined;
}

/** The quota row: the windows the launch's provider last reported, worded as the pool pick words them, with how long ago that was recorded (a snapshot only changes when a request goes through the front door). Anthropic's five-hour and seven-day windows for an OAuth launch, the provider's own usage endpoint's windows for a provider launch. Nothing when no window is recorded. */
export function quotaRows(billing: Readonly<BillingFacts> | undefined): readonly ReportRow[] {
  if (billing === undefined) {
    return [];
  }
  const { nowMs } = billing;
  const state = billing.snapshot?.providers[billing.provider ?? ANTHROPIC_PROVIDER];
  const recorded =
    billing.provider === undefined
      ? {
          observedAt: state?.rateLimit?.observedAt,
          windows: [
            { label: "5h", window: state?.rateLimit?.unified?.fiveHour },
            { label: "7d", window: state?.rateLimit?.unified?.sevenDay },
          ],
        }
      : { observedAt: state?.quota?.observedAt, windows: (state?.quota?.windows ?? []).map((window) => ({ label: `${formatPeriod(window)} ${window.measures}`, window })) };
  const described = recorded.windows.flatMap(({ label, window }) => (window !== undefined && isInformative(window, nowMs) ? [describeWindow(label, window, effectiveWindow(window, nowMs), nowMs)] : []));
  return recorded.observedAt === undefined || described.length === 0 ? [] : [{ label: "quota", value: described.join("; "), detail: `recorded ${formatAge(nowMs - Date.parse(recorded.observedAt))} ago` }];
}

/** The notice that the launch runs on a different account from the one the session or directory was on: a resume-on-limit relaunch names the member that ran out; a resumed conversation names why the ranking could not keep it; any other pool pick names the identity the directory last ran as and how long ago. Nothing when the account is unchanged or there is no record of an earlier one. */
function movedRows(facts: Readonly<DecisionFacts>): readonly ReportRow[] {
  const { identity } = facts;
  if (identity === undefined) {
    return [];
  }
  const moved = (from: string, detail: string): readonly ReportRow[] => [{ label: "moved", value: `${from} -> ${identity}`, detail, notice: true }];
  if (facts.limitRelaunchFrom !== undefined) {
    return moved(facts.limitRelaunchFrom, `${facts.limitRelaunchFrom} ran out of quota; the session resumed here`);
  }
  if (facts.pool?.movedOff !== undefined) {
    return moved(facts.pool.movedOff.identity, `the resumed conversation could not stay: ${facts.pool.movedOff.reason}`);
  }
  if (facts.lastRanAs !== undefined && facts.lastRanAs.identity !== identity) {
    return moved(facts.lastRanAs.identity, `this directory last ran as ${facts.lastRanAs.identity} ${formatAge(facts.lastRanAs.agoMs)} ago`);
  }
  return [];
}

/**
 * The rows that say who a launch runs as: the identity and where it was chosen, the pool it was picked from and the reason for the pick, a `moved` notice when the pick or a resume-on-limit relaunch changed the account, the account the session bills and its recorded quota, the configuration profile and the provider when there are any, and the identity's own credential. A launch with no profile or provider says nothing about them rather than that they are absent, and the account, quota and moved rows are left out when nothing is recorded for them.
 */
export function decisionRows(facts: Readonly<DecisionFacts>): readonly ReportRow[] {
  return [
    { label: "identity", value: facts.identity ?? "(none)", detail: facts.identitySource },
    ...(facts.pool === undefined
      ? []
      : [
          {
            label: "pool",
            value: facts.pool.name,
            ...poolDetail(facts.pool),
            ...(facts.ranking === undefined ? {} : { notes: rankingNotes(facts.ranking, facts.identity) }),
          },
        ]),
    ...movedRows(facts),
    ...accountRows(facts.billing),
    ...quotaRows(facts.billing),
    ...(facts.profile === undefined ? [] : [{ label: "profile", value: facts.profile.name, detail: facts.profile.source }]),
    ...(facts.provider === undefined ? [] : [{ label: "provider", value: facts.provider.name, detail: `credential ${facts.provider.credential}` }]),
    ...(facts.identityCredential === undefined ? [] : [{ label: "credential", value: facts.identityCredential, detail: "the identity's own" }]),
  ];
}

/** The row for a Claude Code version the launch pins. */
export function pinnedVersionRow(version: string, source: string): ReportRow {
  return { label: "claude", value: version, detail: `pinned by ${source}` };
}

/** What a launch routed through, as data. */
interface RoutingFacts {
  readonly frontDoor: { readonly port: number; readonly connectPort: number } | undefined;
  readonly headroom: { readonly projectId: string } | undefined;
  /** Whether a provider's own endpoint is behind the door, which then needs no word on how an OAuth session reaches it. */
  readonly provider: boolean;
}

/** The rows that say what a launch's traffic goes through: the front door and, when on, headroom. Nothing for a launch routed through neither. */
export function routingRows(facts: Readonly<RoutingFacts>): readonly ReportRow[] {
  if (facts.frontDoor === undefined) {
    return [];
  }
  return [
    {
      label: "routing",
      value: `front door 127.0.0.1:${String(facts.frontDoor.port)}`,
      ...(facts.provider ? {} : { detail: `OAuth via CONNECT 127.0.0.1:${String(facts.frontDoor.connectPort)}` }),
    },
    ...(facts.headroom === undefined ? [] : [{ label: "headroom", value: "on", detail: `project ${facts.headroom.projectId}` }]),
  ];
}

/** The row for a farm the launch changed. */
export function farmRow(links: number, builtDirectories: number, adopted: number): ReportRow {
  const counted = (count: number, singular: string, plural: string): string => `${String(count)} ${count === 1 ? singular : plural}`;
  const parts = [counted(links, "link", "links"), counted(builtDirectories, "built directory", "built directories"), ...(adopted === 0 ? [] : [`${String(adopted)} adopted`])];
  return { label: "farm", value: "resynced", detail: parts.join(", ") };
}

/** A row for something about the launch that a person should know but that is not a decision of it. */
export function noteRow(text: string): ReportRow {
  return { label: "note", value: text };
}

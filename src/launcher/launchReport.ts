import type { LaunchPoolDecision } from "../launcher";
import { candidateHeading } from "../usage/candidateText";
import type { Candidate } from "../usage/pick";
import type { ReportRow } from "./ports";

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
}

/** What the pool row says beside the pool's name: the pick's decisive reason, the first the ranking gave, and for a resumed conversation that left a member, which one and why, with that reason under it. The ranking's other reasons are scoring caveats, left to `agent-shim pool pick`. */
function poolDetail(pool: LaunchPoolDecision): Pick<ReportRow, "detail" | "notes"> {
  const [reason] = pool.reasons;
  if (pool.movedOff !== undefined) {
    return { detail: `moved off ${pool.movedOff.identity}: ${pool.movedOff.reason}`, ...(reason === undefined ? {} : { notes: [reason] }) };
  }
  return reason === undefined ? {} : { detail: reason };
}

/** The lines that explain a pool pick: every member in rank order with its class and score, the one picked marked, and the facts behind each, in the words `pool pick` uses. */
function rankingNotes(ranking: readonly Candidate[], picked: string | undefined): readonly string[] {
  return ranking.flatMap((candidate, index) => [
    `${String(index + 1)}. ${candidate.identity} ${candidateHeading(candidate)}${candidate.identity === picked ? " (picked)" : ""}`,
    `   ${candidate.reasons.join("; ")}`,
  ]);
}

/**
 * The rows that say who a launch runs as: the identity and where it was chosen, the pool it was picked from and the reason for the pick, the configuration profile and the provider when there are any, and the identity's own credential. A launch with no profile or provider says nothing about them rather than that they are absent.
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

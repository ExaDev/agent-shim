import { CliError } from "../cliError";
import { poolMemberIdentity, type Pool } from "../config/schema";
import { loginKeyOf } from "../identityAccounts";
import type { LayoutPaths } from "../paths";
import { isIdentityName } from "../usage/account";
import { candidateHeading } from "../usage/candidateText";
import { rankPool, type Candidate, type PoolMember, type StickyPick } from "../usage/pick";
import { loadPoolMembers, rankPoolGraph, readStickyPick, recordStickyPick, type PoolPickFs, type ProviderOf } from "../usage/poolPick";
import type { ParsedLauncherArgv } from "./argv";
import { identityIdResolver, poolNameOf, type IdentityDecision } from "./identity";
import { accountRows, quotaRows } from "./launchReport";
import { LAUNCH_CANCELLED_EXIT } from "./hold";
import { pickerLabel } from "./pickerEntries";
import { decidePicker, isUnattendedLaunch, type PickerReason, type PickerSelection } from "./pickerDecision";
import { isResuming } from "./pool";
import type { FarmFs, FsPort, IdentityPickerPort, PickerEntry, PickerRequest } from "./ports";

/** Raised when the person cancels the identity picker (Ctrl-C): the launch has no identity to run as, so it ends, with the interrupt's exit status. */
export class IdentityPickerCancelledError extends CliError {
  override readonly exitCode: number = LAUNCH_CANCELLED_EXIT;

  constructor() {
    super("launch cancelled at the identity picker: no identity was chosen.");
    this.name = "IdentityPickerCancelledError";
  }
}

/** What the picker decided about a launch's identity. */
export type PickerOutcome =
  /** Nothing was asked, or the person accepted what the launch had already resolved. */
  | { readonly kind: "unchanged" }
  /** The person chose another identity (or a pool, as `pool:<name>`) for this launch. */
  | { readonly kind: "selected"; readonly selector: string }
  /** The person cancelled. */
  | { readonly kind: "cancelled" };

/** Everything the picker reads and asks, injected so it runs against the fakes of the rest of the launcher. */
export interface RunIdentityPickerParams {
  /** The launch's own arguments: `--pick`, `--wait`, and the arguments claude will receive. */
  readonly parsed: ParsedLauncherArgv;
  /** The identity (or pool) the launch resolved before any question. */
  readonly decision: IdentityDecision;
  /** Standard input and standard output are both terminals. */
  readonly interactive: boolean;
  readonly paths: LayoutPaths;
  readonly fs: FsPort;
  /** The usage store: snapshots, log, logins and the directory's last-pick record, which a choice of another pool member is written to. */
  readonly usageFs: PoolPickFs & Pick<FarmFs, "writeFilePrivate" | "mkdirPrivate">;
  readonly pools: Readonly<Record<string, Pool>> | undefined;
  /** The launch directory: the key of the last-pick record. */
  readonly cwd: string;
  readonly now: () => number;
  /** Every identity that exists, in the order the picker lists them. */
  readonly identityNames: () => readonly string[];
  /** The provider a launch of each identity routes through, so the picker ranks and describes each on the quota the launch would spend. Absent when every identity is the Claude account's. */
  readonly providerOf?: ProviderOf;
  readonly picker: IdentityPickerPort;
}

/** What asking needs beyond the decision to ask: the entries, the highlighted one and the sentence that says why. */
interface PickerContext {
  readonly selection: PickerSelection;
  readonly entries: readonly PickerEntry[];
  readonly initial: string | undefined;
  readonly message: (reason: PickerReason) => string;
  /** The member a pool pick chose, which accepting leaves to the pool. */
  readonly poolPick: string | undefined;
}

/** The account and quota the launch banner would state for a member, in the banner's words. */
function memberTexts(member: Readonly<PoolMember> | undefined, nowMs: number): { readonly account?: string; readonly quota?: string } {
  if (member === undefined) {
    return {};
  }
  const billing = { login: member.account, snapshot: member.snapshot, provider: member.provider, nowMs };
  const account = accountRows(billing)[0]?.value;
  const quotaRow = quotaRows(billing)[0];
  return {
    ...(account === undefined ? {} : { account }),
    ...(quotaRow === undefined ? {} : { quota: quotaRow.detail === undefined ? quotaRow.value : `${quotaRow.value} (${quotaRow.detail})` }),
  };
}

/** The refusal a ranked candidate carries when it cannot be used right now, in the ranking's words. */
function refusalOf(candidate: Readonly<Candidate>): string | undefined {
  return candidate.class === "ineligible" ? candidate.reasons[0] : undefined;
}

/** Whether two identities hold different logins: both are recorded and name different accounts or organisations. An identity whose login is not recorded settles nothing. */
function accountsDiffer(members: readonly PoolMember[], left: string, right: string): boolean {
  const keyOf = (identity: string): string | undefined => {
    const account = members.find((member) => member.identity === identity)?.account;
    return account === undefined ? undefined : loginKeyOf(account);
  };
  const leftKey = keyOf(left);
  const rightKey = keyOf(right);
  return leftKey !== undefined && rightKey !== undefined && leftKey !== rightKey;
}

/** The pool picker's context: the pool's ranking as `pool pick` prints it, with what the pick does to the account. */
function poolContext(params: Readonly<RunIdentityPickerParams>, poolName: string, resuming: boolean, nowMs: number): PickerContext {
  const { paths, usageFs } = params;
  const { sticky } = readStickyPick(usageFs, paths.usagePicksFile, params.cwd);
  // One read of the identity records serves the ranking and the members' rows.
  const identityIdOf = identityIdResolver(paths.identitiesDir, params.fs);
  const { ranking } = rankPoolGraph({
    fs: usageFs,
    paths,
    pools: params.pools ?? {},
    poolName,
    nowMs,
    resuming,
    identityIdOf,
    ...(params.providerOf === undefined ? {} : { providerOf: params.providerOf }),
    ...(sticky === undefined ? {} : { sticky }),
  });
  const pick = ranking.pick?.identity;
  const named = [...new Set([...ranking.candidates.map((candidate) => candidate.identity), ...(sticky === undefined ? [] : [sticky.identity])])].filter(isIdentityName);
  const members = loadPoolMembers(usageFs, paths, named, nowMs, identityIdOf, params.providerOf);
  const changes = pick !== undefined && sticky !== undefined && sticky.identity !== pick && accountsDiffer(members, sticky.identity, pick);
  return {
    selection: { kind: "pool", outcome: pick === undefined ? "none-eligible" : changes ? "changes-account" : "keeps-account" },
    entries: ranking.candidates.map((candidate, index) => ({
      value: candidate.identity,
      label: pickerLabel({
        identity: candidate.identity,
        rank: index + 1,
        heading: candidateHeading(candidate),
        picked: candidate.identity === pick,
        detail: refusalOf(candidate),
        ...memberTexts(members.find((member) => member.identity === candidate.identity), nowMs),
      }),
    })),
    initial: pick,
    poolPick: pick,
    message: (reason) => poolMessage(reason, poolName, pick, sticky),
  };
}

/** The question a pool launch asks, by why it asks. */
function poolMessage(reason: PickerReason, poolName: string, pick: string | undefined, sticky: StickyPick | undefined): string {
  switch (reason) {
    case "account-change":
      return `Pool "${poolName}" would run this launch as ${pick ?? "(none)"}, a different account from ${sticky?.identity ?? "(none)"}, which this directory last ran as. Which identity should it run as?`;
    case "no-eligible-identity":
      return `Every member of pool "${poolName}" is refused right now. Which identity should this launch run as?`;
    case "requested":
    case "no-identity":
      return `Pool "${poolName}" is selected for this launch. Which identity should it run as?`;
    default:
      return reason satisfies never;
  }
}

/** The context of a launch that is not a pool launch: every identity (ranked in listed order, which marks the refused ones) and every pool, with the named identity highlighted. */
function identityContext(params: Readonly<RunIdentityPickerParams>, resuming: boolean, nowMs: number): PickerContext {
  const { paths, usageFs } = params;
  const members = loadPoolMembers(usageFs, paths, params.identityNames(), nowMs, identityIdResolver(paths.identitiesDir, params.fs), params.providerOf);
  const { candidates } = rankPool({ members, nowMs, resuming, preference: "listed" });
  const named = params.decision.name;
  const limited = named !== undefined && candidates.some((candidate) => candidate.identity === named && candidate.class === "ineligible");
  const identityEntries = candidates.map((candidate): PickerEntry => ({
    value: candidate.identity,
    label: pickerLabel({ identity: candidate.identity, detail: refusalOf(candidate), ...memberTexts(members.find((member) => member.identity === candidate.identity), nowMs) }),
  }));
  const poolEntries = Object.entries(params.pools ?? {}).map(([name, pool]): PickerEntry => ({
    value: `pool:${name}`,
    label: pickerLabel({ identity: `pool:${name}`, detail: `members ${pool.identities.map(poolMemberIdentity).join(", ")}` }),
  }));
  return {
    selection: named === undefined ? { kind: "none" } : { kind: "identity", limited },
    entries: [...identityEntries, ...poolEntries],
    initial: named,
    poolPick: undefined,
    message: (reason) => {
      switch (reason) {
        case "no-identity":
          return "No identity is selected for this launch. Which identity should it run as?";
        case "no-eligible-identity":
          return `${named ?? "The selected identity"} is refused right now. Which identity should this launch run as?`;
        case "requested":
        case "account-change":
          return "Which identity should this launch run as?";
        default:
          return reason satisfies never;
      }
    },
  };
}

/**
 * Asks the person which identity a launch runs as, when it is a real choice: no identity resolved, a pool pick would change the account the directory last ran as, or the identity (or every pool member) is refused right now. `--pick` asks whatever the launch resolved to.
 *
 * Nothing is asked, and nothing read, without a terminal. The usage store is read only to rank and describe; the one write is the directory's last-pick record, when the person runs a pool launch as a member other than the pool's pick. Accepting the pool's own pick leaves the launch selecting the pool, so the pick is made and recorded as it always is, and a supervising launcher still supervises it. The picker waits for the answer for as long as the person takes.
 */
export async function runIdentityPicker(params: Readonly<RunIdentityPickerParams>): Promise<PickerOutcome> {
  // Decided again below with the full facts; this early exit only keeps a launch nobody watches from reading the usage store.
  if (!params.interactive) {
    return { kind: "unchanged" };
  }
  const nowMs = params.now();
  const resuming = isResuming(params.parsed.rest);
  const context = params.decision.pool === undefined ? identityContext(params, resuming, nowMs) : poolContext(params, params.decision.pool, resuming, nowMs);
  const reason = decidePicker({
    interactive: params.interactive,
    unattended: isUnattendedLaunch(params.parsed.rest),
    pick: params.parsed.pick,
    configDirEscapeHatch: params.decision.configDirEscapeHatch,
    waiting: params.parsed.wait === true,
    selection: context.selection,
  });
  if (reason === undefined) {
    return { kind: "unchanged" };
  }
  const request: PickerRequest = { message: context.message(reason), entries: context.entries, ...(context.initial === undefined ? {} : { initial: context.initial }) };
  const answer = await params.picker.pick(request);
  if (answer.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  const chosen = answer.value;
  if (chosen === (params.decision.pool === undefined ? params.decision.name : context.poolPick)) {
    return { kind: "unchanged" };
  }
  // A member chosen over the pool's pick is this directory's last run, as a pick the pool made would have been, so the next launch here keeps its warm prompt cache and notices a move.
  if (params.decision.pool !== undefined && poolNameOf(chosen) === undefined) {
    recordStickyPick(params.usageFs, params.paths.usagePicksFile, params.cwd, chosen, nowMs);
  }
  return { kind: "selected", selector: chosen };
}

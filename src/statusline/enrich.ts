import type { UsageSnapshot } from "../usage/schema";

/** What the door knows about the session whose statusline this is: the one source a renderer can trust for whose quota the windows describe. The `Used` fields are whole percentages (0 to 100); the door's own records carry fractions, the form the real API's headers use. */
const FULL_PERCENT = 100;

export interface StatuslineSummary {
  readonly identity: string | undefined;
  readonly provider: string | undefined;
  readonly providerAccountEmail: string | undefined;
  readonly providerAccountSub: string | undefined;
  readonly providerPlan: string | undefined;
  readonly fiveHourUsed: number | undefined;
  readonly fiveHourResetAt: string | undefined;
  readonly sevenDayUsed: number | undefined;
  readonly sevenDayResetAt: string | undefined;
}

/** The identity name this tool's own launcher hands the session, inside its custom-header environment entry (`x-agent-shim-identity: <name>`), or derived from the config directory the launch pinned (`<root>/identities/<name>`). */
export function identityOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const headers = env.ANTHROPIC_CUSTOM_HEADERS;
  if (headers !== undefined) {
    const match = /x-agent-shim-identity:\s*([A-Za-z0-9@._-]+)/i.exec(headers);
    if (match !== null) {
      return match[1];
    }
  }
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined) {
    const slash = configDir.lastIndexOf("/");
    const name = slash === -1 ? "" : configDir.slice(slash + 1);
    const parent = slash === -1 ? "" : configDir.slice(0, slash);
    const parentSlash = parent.lastIndexOf("/");
    if (parentSlash !== -1 && parent.slice(parentSlash + 1) === "identities" && name !== "") {
      return name;
    }
  }
  return undefined;
}

/** The binding windows across the states given: the window furthest spent is the one that bites first, which is what a statusline should show. */
type ProviderState = UsageSnapshot["providers"][string];

function windowsOf(states: readonly ProviderState[]): Pick<StatuslineSummary, "fiveHourUsed" | "fiveHourResetAt" | "sevenDayUsed" | "sevenDayResetAt"> {
  let fiveHourUsed: number | undefined;
  let fiveHourResetAt: string | undefined;
  let sevenDayUsed: number | undefined;
  let sevenDayResetAt: string | undefined;
  for (const state of states) {
    const unified = state.rateLimit?.unified;
    if (unified === undefined) {
      continue;
    }
    const fiveWindow = unified.fiveHour === undefined ? undefined : unified.fiveHour.utilization;
    const five = typeof fiveWindow === "number" && Number.isFinite(fiveWindow) ? Math.round(Math.min(1, Math.max(0, fiveWindow)) * FULL_PERCENT) : undefined;
    if (five !== undefined && (fiveHourUsed === undefined || five > fiveHourUsed)) {
      fiveHourUsed = five;
      fiveHourResetAt = unified.fiveHour?.resetsAt;
    }
    const sevenWindow = unified.sevenDay === undefined ? undefined : unified.sevenDay.utilization;
    const seven = typeof sevenWindow === "number" && Number.isFinite(sevenWindow) ? Math.round(Math.min(1, Math.max(0, sevenWindow)) * FULL_PERCENT) : undefined;
    if (seven !== undefined && (sevenDayUsed === undefined || seven > sevenDayUsed)) {
      sevenDayUsed = seven;
      sevenDayResetAt = unified.sevenDay?.resetsAt;
    }
  }
  return { fiveHourUsed, fiveHourResetAt, sevenDayUsed, sevenDayResetAt };
}

export interface EnrichParams {
  /** The client's statusline payload, already parsed. */
  readonly payload: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The identity's usage snapshot, or undefined when there is none. */
  readonly snapshot: UsageSnapshot | undefined;
}

/**
 * Adds what the door knows to the client's statusline payload, under one `agent_shim` key a renderer reads instead of reopening the door's files or guessing from filtered environment: the identity, the provider the session's launch selected, the account that provider's own credential belongs to, and that provider's usage windows. A session whose launch named a provider spends that provider's quota, so its windows are that provider's alone; a session that named none (plain OAuth) shows the binding windows across every provider the identity has used. A payload that is not a JSON object passes through unchanged.
 */
export function enrichStatuslinePayload(params: EnrichParams): { readonly payload: unknown; readonly summary: StatuslineSummary } {
  const identity = identityOf(params.env);
  let summary: StatuslineSummary = {
    identity,
    provider: params.env.AGENT_SHIM_PROVIDER === undefined || params.env.AGENT_SHIM_PROVIDER === "" ? undefined : params.env.AGENT_SHIM_PROVIDER,
    providerAccountEmail: undefined,
    providerAccountSub: undefined,
    providerPlan: undefined,
    fiveHourUsed: undefined,
    fiveHourResetAt: undefined,
    sevenDayUsed: undefined,
    sevenDayResetAt: undefined,
  };
  if (params.snapshot !== undefined) {
    const scopedName = providerScopedState(params.snapshot, params.env.AGENT_SHIM_PROVIDER);
    const scopedState = scopedName === undefined ? undefined : params.snapshot.providers[scopedName];
    const states = scopedState === undefined ? Object.values(params.snapshot.providers) : [scopedState];
    let email: string | undefined;
    let sub: string | undefined;
    let plan: string | undefined;
    for (const state of states) {
      const account = state.quota?.account;
      const candidateEmail = account?.email;
      if (email === undefined && typeof candidateEmail === "string" && candidateEmail !== "") {
        email = candidateEmail;
      }
      const candidateSub = account?.accountId;
      if (sub === undefined && typeof candidateSub === "string" && candidateSub !== "") {
        sub = candidateSub;
      }
      const candidatePlan = state.quota?.level;
      if (plan === undefined && typeof candidatePlan === "string" && candidatePlan !== "") {
        plan = candidatePlan;
      }
    }
    summary = { ...summary, ...windowsOf(states), providerAccountEmail: email, providerAccountSub: sub, providerPlan: plan };
  }
  if (typeof params.payload !== "object" || params.payload === null || Array.isArray(params.payload)) {
    return { payload: params.payload, summary };
  }
  const enriched: Record<string, unknown> = { agent_shim: summary };
  for (const [key, value] of Object.entries(params.payload)) {
    enriched[key] = value;
  }
  return { payload: enriched, summary };
}

/** The snapshot's provider entry for the session's launch-selected provider, when the environment names one whose state the snapshot holds. */
function providerScopedState(snapshot: UsageSnapshot, providerDisplayName: string | undefined): string | undefined {
  if (providerDisplayName === undefined || providerDisplayName === "") {
    return undefined;
  }
  const wanted = providerDisplayName.toLowerCase();
  for (const name of Object.keys(snapshot.providers)) {
    if (name.toLowerCase() === wanted) {
      return name;
    }
  }
  return undefined;
}

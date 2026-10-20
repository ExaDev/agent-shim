import { antigravityFamilyBuckets, selectAntigravityBuckets, type AntigravityQuotaBucket, type AntigravityQuotaMap } from "../antigravity/quota";
import type { AccountMetadata, QuotaWindow, UsageSnapshot } from "../usage/schema";
import type { HeadroomStats } from "./headroom";

/** What the door knows about the session whose statusline this is: the one source a renderer can trust for whose quota the windows describe. The `Used` fields are whole percentages (0 to 100); the door's own records carry fractions, the form the real API's headers use. */
const FULL_PERCENT = 100;
const MS_PER_SECOND = 1000;

export interface StatuslineSummary {
  readonly identity: string | undefined;
  readonly provider: string | undefined;
  readonly providerAccountEmail: string | undefined;
  readonly providerAccountSub: string | undefined;
  readonly providerPlan: string | undefined;
  readonly loginAccountEmail: string | undefined;
  readonly loginRateLimitTier: string | undefined;
  readonly loginOrganizationName: string | undefined;
  readonly loginOrganizationType: string | undefined;
  readonly loginSeatTier: string | undefined;
  /** The plan a client states for its own signed-in account (the Antigravity CLI's `plan_tier`), shown as given rather than derived from Anthropic's tiers. */
  readonly loginPlan: string | undefined;
  readonly fiveHourUsed: number | undefined;
  readonly fiveHourResetAt: string | undefined;
  readonly sevenDayUsed: number | undefined;
  readonly sevenDayResetAt: string | undefined;
  /** The scoped provider's own quota windows, as its usage endpoint reports them: a provider outside Anthropic's unified rate-limit family (z.ai's five-hour token window, its monthly tool-call window) carries its usage only here. */
  readonly providerQuotaWindows: readonly ProviderQuotaWindowView[];
  /** An Antigravity account's windows for every model family at once (Gemini, third party, Argon), labelled by family. Present only when the session's quota source is an Antigravity account's bucket map, and drawn in place of the single pair of windows the active model draws on. */
  readonly quotaFamilies: readonly ProviderQuotaWindowView[];
  /** What headroom's proxy reports having saved this session, when the session is routed through one that answered. */
  readonly headroom: HeadroomStats | undefined;
  /** The target the session's last request was served by, `provider/model`, when routing by name sent it somewhere other than the launch's own provider or under another name; what makes a virtual model's choice visible where the person is looking. Absent when the caller cannot read the usage log. */
  readonly routedTarget?: string | undefined;
  /** The model choice the session's last request was served by, when a routing layer chose among alternatives for its model name (a virtual model's or a tier alias's selection): the name the session asked for, the model and provider that answered, and the distinct providers the choice could have landed on. Absent when the last request named its model explicitly. */
  readonly modelChoice?: { readonly requested: string; readonly served: string; readonly provider: string; readonly providers: readonly string[] };
  /** What the requests the door served for this session cost, priced from the configured model prices; absent when the caller did not read the usage log or no price covers every request. */
  readonly doorCostUsd?: number | undefined;
}

/** One of a provider's quota windows, in the form the statusline draws. */
interface ProviderQuotaWindowView {
  readonly measures: string;
  readonly utilization: number;
  readonly resetsAt: string | undefined;
  /** The window's length in milliseconds, when the provider's unit is one this project knows. */
  readonly periodMs?: number | undefined;
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

/** A window's whole percentage used, or undefined when it reports no figure or has already reset: a window past its reset describes a period that is over, so its figure no longer says anything about what the account has left. */
function livePercentOf(window: QuotaWindow | undefined, nowMs: number): number | undefined {
  if (window?.utilization === undefined || !Number.isFinite(window.utilization)) {
    return undefined;
  }
  if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs) {
    return undefined;
  }
  return Math.round(Math.min(1, Math.max(0, window.utilization)) * FULL_PERCENT);
}

/** The binding windows across the states given: the window furthest spent is the one that bites first, which is what a statusline should show. */
type ProviderState = UsageSnapshot["providers"][string];

function windowsOf(states: readonly ProviderState[], nowMs: number): Pick<StatuslineSummary, "fiveHourUsed" | "fiveHourResetAt" | "sevenDayUsed" | "sevenDayResetAt"> {
  let fiveHourUsed: number | undefined;
  let fiveHourResetAt: string | undefined;
  let sevenDayUsed: number | undefined;
  let sevenDayResetAt: string | undefined;
  for (const state of states) {
    const unified = state.rateLimit?.unified;
    if (unified === undefined) {
      continue;
    }
    const five = livePercentOf(unified.fiveHour, nowMs);
    if (five !== undefined && (fiveHourUsed === undefined || five > fiveHourUsed)) {
      fiveHourUsed = five;
      fiveHourResetAt = unified.fiveHour?.resetsAt;
    }
    const seven = livePercentOf(unified.sevenDay, nowMs);
    if (seven !== undefined && (sevenDayUsed === undefined || seven > sevenDayUsed)) {
      sevenDayUsed = seven;
      sevenDayResetAt = unified.sevenDay?.resetsAt;
    }
  }
  return { fiveHourUsed, fiveHourResetAt, sevenDayUsed, sevenDayResetAt };
}

/** A plain JSON object, narrowed so its fields can be read with `in`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One subscription window from the client's own payload: `used_percentage` is already a whole 0 to 100 percentage and `resets_at` epoch seconds. */
function payloadWindow(rateLimits: Record<string, unknown>, key: "five_hour" | "seven_day"): { used: number; resetAt: string | undefined } | undefined {
  const window = rateLimits[key];
  if (!isObject(window) || typeof window.used_percentage !== "number" || !Number.isFinite(window.used_percentage)) {
    return undefined;
  }
  const resetsAt = window.resets_at;
  return {
    used: Math.min(FULL_PERCENT, Math.max(0, window.used_percentage)),
    resetAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? new Date(resetsAt * MS_PER_SECOND).toISOString() : undefined,
  };
}

/**
 * The subscription windows Claude Code itself puts in the statusline payload (`rate_limits.five_hour` and `rate_limits.seven_day`, present for claude.ai Pro and Max accounts after the session's first API response, each window independently absent). They describe the account the session is signed in as, which is the quota a session with no provider spends, and they arrive with no agent-shim door or usage snapshot behind them.
 */
function payloadWindowsOf(payload: unknown): Pick<StatuslineSummary, "fiveHourUsed" | "fiveHourResetAt" | "sevenDayUsed" | "sevenDayResetAt"> {
  const rateLimits = isObject(payload) ? payload.rate_limits : undefined;
  const five = isObject(rateLimits) ? payloadWindow(rateLimits, "five_hour") : undefined;
  const seven = isObject(rateLimits) ? payloadWindow(rateLimits, "seven_day") : undefined;
  return { fiveHourUsed: five?.used, fiveHourResetAt: five?.resetAt, sevenDayUsed: seven?.used, sevenDayResetAt: seven?.resetAt };
}

/** The Antigravity CLI's `quota` map from its statusline payload, keyed by bucket id with each bucket's remaining fraction and seconds to reset; undefined when the payload carries none. */
function antigravityQuotaMapOf(payload: unknown): AntigravityQuotaMap | undefined {
  const quota = isObject(payload) ? payload.quota : undefined;
  if (!isObject(quota)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(quota).flatMap(([key, bucket]) => {
      if (!isObject(bucket)) {
        return [];
      }
      const remaining = bucket.remaining_fraction;
      const resetIn = bucket.reset_in_seconds;
      return [[key, { ...(typeof remaining === "number" ? { remaining_fraction: remaining } : {}), ...(typeof resetIn === "number" ? { reset_in_seconds: resetIn } : {}) }]];
    }),
  );
}

/** A bucket's use as a fraction and the instant it resets, as the statusline draws a window. */
function bucketView(bucket: AntigravityQuotaBucket | undefined, nowMs: number): { used: number | undefined; resetAt: string | undefined } {
  return {
    used: bucket?.remaining_fraction === undefined || !Number.isFinite(bucket.remaining_fraction) ? undefined : (1 - Math.min(1, Math.max(0, bucket.remaining_fraction))) * FULL_PERCENT,
    resetAt: bucket?.reset_in_seconds === undefined || !Number.isFinite(bucket.reset_in_seconds) ? undefined : new Date(nowMs + bucket.reset_in_seconds * MS_PER_SECOND).toISOString(),
  };
}

/**
 * The windows the Antigravity CLI puts in its statusline payload: from the `quota` map, the model's five-hour and weekly buckets, picked exactly as the door picks them. A window is drawn as the fraction used.
 */
function antigravityWindowsOf(payload: unknown, nowMs: number): Pick<StatuslineSummary, "fiveHourUsed" | "fiveHourResetAt" | "sevenDayUsed" | "sevenDayResetAt"> {
  const buckets = antigravityQuotaMapOf(payload);
  if (buckets === undefined) {
    return { fiveHourUsed: undefined, fiveHourResetAt: undefined, sevenDayUsed: undefined, sevenDayResetAt: undefined };
  }
  const model = isObject(payload) && isObject(payload.model) && typeof payload.model.id === "string" ? payload.model.id : undefined;
  const { fiveHour, weekly } = selectAntigravityBuckets(buckets, model);
  const five = bucketView(fiveHour, nowMs);
  const seven = bucketView(weekly, nowMs);
  return { fiveHourUsed: five.used, fiveHourResetAt: five.resetAt, sevenDayUsed: seven.used, sevenDayResetAt: seven.resetAt };
}

/** Every family's window in a bucket map, each as the view a renderer draws. */
function quotaFamiliesOf(buckets: AntigravityQuotaMap, nowMs: number): readonly ProviderQuotaWindowView[] {
  return antigravityFamilyBuckets(buckets).flatMap(({ label, bucket }) => {
    const { used, resetAt } = bucketView(bucket, nowMs);
    return used === undefined ? [] : [{ measures: label, utilization: used / FULL_PERCENT, resetsAt: resetAt }];
  });
}

export interface EnrichParams {
  /** The client's statusline payload, already parsed. */
  readonly payload: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The identity's usage snapshot, or undefined when there is none. */
  readonly snapshot: UsageSnapshot | undefined;
  /** The identity's own OAuth account metadata, or undefined when the identity never logged in. */
  readonly account: AccountMetadata | undefined;
  /** The launch-selected provider's registered name, when the environment's display name resolves to one; the snapshot keys providers by this name, which can differ from the display name a session's environment carries. */
  readonly providerName: string | undefined;
  /** The current time in epoch milliseconds, which turns a window's seconds-to-reset into the instant it resets. */
  readonly nowMs: number;
  /** The session's headroom savings as the proxy reported them, or undefined when there are none to show. */
  readonly headroom: HeadroomStats | undefined;
  /** The target the session's last request was served by, `provider/model`, when routing by name sent it somewhere other than the launch's own provider or under another name; what makes a virtual model's choice visible where the person is looking. Absent when the caller cannot read the usage log. */
  readonly routedTarget?: string | undefined;
  /** The model choice the session's last request was served by, when a routing layer chose among alternatives for its model name: see `StatuslineSummary.modelChoice`. */
  readonly modelChoice?: { readonly requested: string; readonly served: string; readonly provider: string; readonly providers: readonly string[] };
  /** What the requests the door served for this session cost: see `StatuslineSummary.doorCostUsd`. */
  readonly doorCostUsd?: number | undefined;
}

/**
 * Adds what the door knows to the client's statusline payload, under one `agent_shim` key a renderer reads instead of reopening the door's files or guessing from filtered environment: the identity, the provider the session's launch selected, the account that provider's own credential belongs to, and that provider's usage windows. A session whose launch named a provider spends that provider's quota, so its windows are that provider's alone; a session that named none (plain OAuth) shows the binding windows across every provider the identity has used. A payload that is not a JSON object passes through unchanged.
 */
export function enrichStatuslinePayload(params: EnrichParams): { readonly payload: unknown; readonly summary: StatuslineSummary } {
  const identity = identityOf(params.env);
  // A client that states its own signed-in account (the Antigravity CLI's `email` and `plan_tier`) is the authority on it; the Claude profile file read for a session outside agent-shim describes a different client's login and is not shown beside it.
  const clientEmail = isObject(params.payload) && typeof params.payload.email === "string" && params.payload.email !== "" ? params.payload.email : undefined;
  const clientPlan = clientEmail !== undefined && isObject(params.payload) && typeof params.payload.plan_tier === "string" && params.payload.plan_tier !== "" ? params.payload.plan_tier : undefined;
  const account = clientEmail === undefined ? params.account : undefined;
  let summary: StatuslineSummary = {
    identity,
    provider: params.env.AGENT_SHIM_PROVIDER === undefined || params.env.AGENT_SHIM_PROVIDER === "" ? undefined : params.env.AGENT_SHIM_PROVIDER,
    providerAccountEmail: undefined,
    providerAccountSub: undefined,
    providerPlan: undefined,
    loginAccountEmail: clientEmail ?? account?.emailAddress,
    loginPlan: clientPlan,
    loginRateLimitTier: account?.userRateLimitTier ?? account?.organizationRateLimitTier,
    loginOrganizationName: account?.organizationName,
    loginOrganizationType: account?.organizationType,
    loginSeatTier: account?.seatTier === "none" ? undefined : account?.seatTier,
    fiveHourUsed: undefined,
    fiveHourResetAt: undefined,
    sevenDayUsed: undefined,
    sevenDayResetAt: undefined,
    providerQuotaWindows: [],
    quotaFamilies: [],
    headroom: params.headroom,
    routedTarget: params.routedTarget,
    ...(params.modelChoice === undefined ? {} : { modelChoice: params.modelChoice }),
    ...(params.doorCostUsd === undefined ? {} : { doorCostUsd: params.doorCostUsd }),
  };
  if (params.snapshot !== undefined) {
    const scopedName = providerScopedState(params.snapshot, params.providerName, params.env.AGENT_SHIM_PROVIDER);
    const scopedState = scopedName === undefined ? undefined : params.snapshot.providers[scopedName];
    // A session that selected a provider spends that provider's quota alone: when its state is not in the snapshot yet there are no windows to show, never another provider's (an exhausted login week was drawn as a z.ai session's usage). Only a session with no provider shows the binding windows across every provider the identity has used.
    const states = summary.provider === undefined ? Object.values(params.snapshot.providers) : scopedState === undefined ? [] : [scopedState];
    let email: string | undefined;
    let sub: string | undefined;
    let plan: string | undefined;
    for (const state of states) {
      const providerAccount = state.quota?.account;
      const candidateEmail = providerAccount?.email;
      if (email === undefined && typeof candidateEmail === "string" && candidateEmail !== "") {
        email = candidateEmail;
      }
      const candidateSub = providerAccount?.accountId;
      if (sub === undefined && typeof candidateSub === "string" && candidateSub !== "") {
        sub = candidateSub;
      }
      const candidatePlan = state.quota?.level;
      if (plan === undefined && typeof candidatePlan === "string" && candidatePlan !== "") {
        plan = candidatePlan;
      }
    }
    // Shortest window first, as the five-hour window leads the weekly one; a window of unknown length sorts last.
    const providerQuotaWindows = [...(scopedState?.quota?.windows ?? [])]
      .sort((a, b) => (a.periodMs ?? Number.POSITIVE_INFINITY) - (b.periodMs ?? Number.POSITIVE_INFINITY))
      .map((window) => ({ measures: window.measures, utilization: window.utilization, resetsAt: window.resetsAt, periodMs: window.periodMs }));
    // An Antigravity account's windows are keyed by the bucket ids its quota endpoint names, and the session's own provider is the only source whose windows describe the account the session spends.
    const providerBuckets: AntigravityQuotaMap = Object.fromEntries(
      (scopedState?.quota?.windows ?? []).map((window) => [
        window.measures,
        {
          remaining_fraction: 1 - window.utilization,
          ...(window.resetsAt === undefined ? {} : { reset_in_seconds: (Date.parse(window.resetsAt) - params.nowMs) / MS_PER_SECOND }),
        },
      ]),
    );
    summary = { ...summary, ...windowsOf(states, params.nowMs), providerAccountEmail: email, providerAccountSub: sub, providerPlan: plan, providerQuotaWindows, quotaFamilies: quotaFamiliesOf(providerBuckets, params.nowMs) };
  }
  if (summary.provider === undefined) {
    // The client's own windows (Claude Code's rate_limits, the Antigravity CLI's quota map) describe exactly the account a providerless session spends, so each present one replaces the snapshot's binding window; a window the payload lacks keeps the snapshot's.
    const agyBuckets = antigravityQuotaMapOf(params.payload);
    if (agyBuckets !== undefined) {
      summary = { ...summary, quotaFamilies: quotaFamiliesOf(agyBuckets, params.nowMs) };
    }
    for (const own of [antigravityWindowsOf(params.payload, params.nowMs), payloadWindowsOf(params.payload)]) {
      summary = {
        ...summary,
        ...(own.fiveHourUsed === undefined ? {} : { fiveHourUsed: own.fiveHourUsed, fiveHourResetAt: own.fiveHourResetAt }),
        ...(own.sevenDayUsed === undefined ? {} : { sevenDayUsed: own.sevenDayUsed, sevenDayResetAt: own.sevenDayResetAt }),
      };
    }
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

/** The snapshot's provider entry for the session's launch-selected provider. The snapshot keys providers by their registered name; the launch environment carries only the display name, which can differ (`z` against `z.ai`), so the registered name resolved from the provider store wins and the display name is matched case-insensitively only as a fallback. */
function providerScopedState(snapshot: UsageSnapshot, providerName: string | undefined, providerDisplayName: string | undefined): string | undefined {
  if (providerName !== undefined && providerName in snapshot.providers) {
    return providerName;
  }
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

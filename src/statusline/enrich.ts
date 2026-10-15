import type { UsageSnapshot } from "../usage/schema";

/** What the door knows about the session whose statusline this is: the one source a renderer can trust for whose quota the windows describe. */
export interface StatuslineSummary {
  readonly identity: string | undefined;
  readonly provider: string | undefined;
  readonly providerAccountEmail: string | undefined;
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

/** The binding windows across the identity's providers: the window furthest spent is the one that bites first, which is what a statusline should show. */
function windowsOf(snapshot: UsageSnapshot): Pick<StatuslineSummary, "fiveHourUsed" | "fiveHourResetAt" | "sevenDayUsed" | "sevenDayResetAt"> {
  let fiveHourUsed: number | undefined;
  let fiveHourResetAt: string | undefined;
  let sevenDayUsed: number | undefined;
  let sevenDayResetAt: string | undefined;
  for (const state of Object.values(snapshot.providers)) {
    const unified = state.rateLimit?.unified;
    if (unified === undefined) {
      continue;
    }
    const fiveWindow = unified.fiveHour === undefined ? undefined : unified.fiveHour.utilization;
    const five = typeof fiveWindow === "number" ? fiveWindow : undefined;
    if (five !== undefined && (fiveHourUsed === undefined || five > fiveHourUsed)) {
      fiveHourUsed = five;
      fiveHourResetAt = unified.fiveHour?.resetsAt;
    }
    const sevenWindow = unified.sevenDay === undefined ? undefined : unified.sevenDay.utilization;
    const seven = typeof sevenWindow === "number" ? sevenWindow : undefined;
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
 * Adds what the door knows to the client's statusline payload, under one `agent_shim` key a renderer reads instead of reopening the door's files or guessing from filtered environment: the identity, the provider the session's launch selected, the account that provider's own credential belongs to, and the binding usage windows. A payload that is not a JSON object passes through unchanged.
 */
export function enrichStatuslinePayload(params: EnrichParams): { readonly payload: unknown; readonly summary: StatuslineSummary } {
  const identity = identityOf(params.env);
  let summary: StatuslineSummary = {
    identity,
    provider: params.env.AGENT_SHIM_PROVIDER === undefined || params.env.AGENT_SHIM_PROVIDER === "" ? undefined : params.env.AGENT_SHIM_PROVIDER,
    providerAccountEmail: undefined,
    fiveHourUsed: undefined,
    fiveHourResetAt: undefined,
    sevenDayUsed: undefined,
    sevenDayResetAt: undefined,
  };
  if (params.snapshot !== undefined) {
    let email: string | undefined;
    for (const state of Object.values(params.snapshot.providers)) {
      const candidate = state.quota?.account?.email;
      if (email === undefined && typeof candidate === "string" && candidate !== "") {
        email = candidate;
      }
    }
    summary = { ...summary, ...windowsOf(params.snapshot), providerAccountEmail: email };
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

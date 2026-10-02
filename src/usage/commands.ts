import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { parseDurationOption } from "../cli/parsers";
import { IdentityNotFoundError, listIdentities } from "../identityManager";
import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { readAccountMetadata } from "./account";
import { listUsageSnapshots, readUsageLog, readUsageSnapshot, summariseUsage, type UsageSummary } from "./read";
import type { AccountMetadata, LimitEvent, QuotaWindow, RateLimitState, UsageSnapshot } from "./schema";
import { USAGE_RETENTION_MS } from "./store";

const DAY_MS = 86_400_000;

/** The reads the `usage` and `account` commands make. */
type ReportFs = Pick<FarmFs, "readFileUtf8" | "readdir">;

/** What `claude-use usage` reports. */
export interface UsageReport {
  /** The start of the reported period, when `--since` narrowed it; otherwise the whole retained log. */
  readonly since: string | undefined;
  readonly logDir: string;
  /** Totals per identity and provider over the period. */
  readonly summaries: readonly UsageSummary[];
  /** The latest snapshots, narrowed to the same identity and provider. */
  readonly snapshots: readonly UsageSnapshot[];
  /** Log lines that could not be read as records: reported so a corrupted or newer-format log never reads as "no usage". */
  readonly invalidLines: number;
}

/** Filters for `claude-use usage`. */
export interface UsageFilters {
  readonly identity?: string;
  readonly provider?: string;
  readonly sinceMs?: number;
}

/** Fails with the identity command's own error when `name` is not an identity: a mistyped `--identity` must not read as "no usage". */
function requireIdentity(paths: LayoutPaths, name: string): void {
  if (!listIdentities(paths).some((entry) => entry.name === name)) {
    throw new IdentityNotFoundError(name);
  }
}

/** Collects `claude-use usage`, read-only. */
export function collectUsageReport(fs: ReportFs, paths: LayoutPaths, filters: UsageFilters): UsageReport {
  const { identity, provider, sinceMs } = filters;
  if (identity !== undefined) {
    requireIdentity(paths, identity);
  }
  const log = readUsageLog(fs, paths.usageLogDir, sinceMs === undefined ? {} : { sinceMs });
  const records = log.records.filter((record) => (identity === undefined || record.identity === identity) && (provider === undefined || record.provider === provider));
  const snapshots = (identity === undefined ? listUsageSnapshots(fs, paths.usageSnapshotsDir) : [readUsageSnapshot(fs, paths.usageSnapshotsDir, identity)].flatMap((snapshot) => (snapshot === undefined ? [] : [snapshot])))
    .map((snapshot) => (provider === undefined ? snapshot : { ...snapshot, providers: Object.fromEntries(Object.entries(snapshot.providers).filter(([name]) => name === provider)) }))
    .filter((snapshot) => Object.keys(snapshot.providers).length > 0);
  return {
    since: sinceMs === undefined ? undefined : new Date(sinceMs).toISOString(),
    logDir: paths.usageLogDir,
    summaries: summariseUsage(records),
    snapshots,
    invalidLines: log.invalidLines,
  };
}

const PERCENT = 100;

/** One quota window as `5h 83% used, resets <time>`. */
function formatWindow(label: string, window: QuotaWindow | undefined): string | undefined {
  if (window === undefined) {
    return undefined;
  }
  const used = window.utilization === undefined ? "usage unknown" : `${String(Math.round(window.utilization * PERCENT))}% used`;
  return `${label} ${used}${window.resetsAt === undefined ? "" : `, resets ${window.resetsAt}`}${window.status === undefined ? "" : ` (${window.status})`}`;
}

/** A rate-limit state as one line: the unified windows when the upstream sent them, otherwise the raw header names it did send. */
function formatRateLimit(state: RateLimitState): string {
  const { unified } = state;
  if (unified === undefined) {
    return `rate-limit headers (as of ${state.observedAt}): ${Object.entries(state.headers)
      .map(([name, value]) => `${name}=${value}`)
      .join(", ")}`;
  }
  const parts = [formatWindow("5h", unified.fiveHour), formatWindow("7d", unified.sevenDay)].filter((part) => part !== undefined);
  return `quota (as of ${state.observedAt}): ${[...parts, `status ${unified.status ?? "unknown"}`, ...(unified.overageStatus === undefined ? [] : [`extra usage ${unified.overageStatus}`])].join("; ")}`;
}

/** A classified refusal as one line. */
function formatLimit(limit: LimitEvent): string {
  const wait = [
    ...(limit.resetAt === undefined ? [] : [`resets ${limit.resetAt}`]),
    ...(limit.retryAfterSeconds === undefined ? [] : [`retry after ${String(limit.retryAfterSeconds)}s`]),
  ];
  return `last limit: ${limit.kind} (${String(limit.status)}) at ${limit.observedAt}${limit.window === undefined ? "" : ` on the ${limit.window} window`}${wait.length === 0 ? "" : `, ${wait.join(", ")}`}`;
}

/** The latest-state lines for one identity's provider. */
function snapshotLines(snapshot: UsageSnapshot | undefined, provider: string): string[] {
  const state = snapshot?.providers[provider];
  if (state === undefined) {
    return [];
  }
  return [...(state.rateLimit === undefined ? [] : [`  ${formatRateLimit(state.rateLimit)}`]), ...(state.lastLimit === undefined ? [] : [`  ${formatLimit(state.lastLimit)}`])];
}

/** Formats `claude-use usage`, one block per identity and provider. */
export function formatUsageReport(report: UsageReport): string[] {
  const lines = [`usage ${report.since === undefined ? "over the retained log" : `since ${report.since}`} (${report.logDir})`];
  const snapshotFor = (identity: string | undefined): UsageSnapshot | undefined => report.snapshots.find((snapshot) => snapshot.identity === identity);
  const reported = new Set<string>();
  for (const summary of report.summaries) {
    const { tokens, limits } = summary;
    reported.add(`${summary.identity ?? ""}\u0000${summary.provider}`);
    lines.push(
      `${summary.identity ?? "(no identity)"} / ${summary.provider}: ${String(summary.requests)} request(s), ${String(summary.failed)} failed, ` +
        `${String(limits["rate-limited"])} rate-limited, ${String(limits["quota-exhausted"])} quota-exhausted`,
      `  tokens: ${String(tokens.inputTokens)} in, ${String(tokens.outputTokens)} out, ${String(tokens.cacheReadInputTokens)} cache read, ${String(tokens.cacheCreationInputTokens)} cache write`,
      ...(summary.models.length === 0 ? [] : [`  models: ${summary.models.join(", ")}`]),
      ...snapshotLines(snapshotFor(summary.identity), summary.provider),
    );
  }
  // A snapshot whose provider has no request in the period still says what the quota stood at last.
  for (const snapshot of report.snapshots) {
    for (const provider of Object.keys(snapshot.providers).sort()) {
      if (!reported.has(`${snapshot.identity}\u0000${provider}`)) {
        const latest = snapshotLines(snapshot, provider);
        if (latest.length > 0) {
          lines.push(`${snapshot.identity} / ${provider}: no requests in this period`, ...latest);
        }
      }
    }
  }
  if (lines.length === 1) {
    lines.push("no usage recorded (only sessions routed through the front door are recorded: provider launches and --headroom launches)");
  }
  if (report.invalidLines > 0) {
    lines.push(`warning: ${String(report.invalidLines)} log line(s) could not be read as usage records and were skipped`);
  }
  return lines;
}

/** One identity's `claude-use account show` view. */
export interface AccountView {
  readonly identity: string;
  /** Read live from the identity's stored login. */
  readonly account: AccountMetadata | undefined;
  /** The identity's latest usage snapshot, when the front door has recorded any request for it. */
  readonly usage: UsageSnapshot | undefined;
}

/** Collects `claude-use account show`, read-only: one identity, or every identity when none is named. Throws `IdentityNotFoundError` for a named identity that does not exist. */
export function collectAccounts(fs: ReportFs, paths: LayoutPaths, identity: string | undefined): readonly AccountView[] {
  if (identity !== undefined) {
    requireIdentity(paths, identity);
  }
  const names = identity === undefined ? listIdentities(paths).map((entry) => entry.name) : [identity];
  return names.map((name) => ({
    identity: name,
    account: readAccountMetadata(fs, paths.identitiesDir, name),
    usage: readUsageSnapshot(fs, paths.usageSnapshotsDir, name),
  }));
}

/** Formats `claude-use account show`, one block per identity. */
export function formatAccounts(views: readonly AccountView[]): string[] {
  if (views.length === 0) {
    return ["no identities"];
  }
  return views.flatMap((view, index) => {
    const { account } = view;
    const lines = [...(index === 0 ? [] : [""]), `Identity: ${view.identity}`];
    if (account === undefined) {
      lines.push("Account: (no stored login profile: never logged in, or a setup-token identity, which has no profile scope)");
    } else {
      const organisation = [account.organizationName, account.organizationType].filter((part) => part !== undefined).join(", ");
      lines.push(
        `Account: ${account.emailAddress ?? "(no email)"}${organisation === "" ? "" : ` (${organisation})`}`,
        `Plan: billing ${account.billingType ?? "unknown"}, seat tier ${account.seatTier ?? "none"}`,
        `Rate-limit tier: organisation ${account.organizationRateLimitTier ?? "unknown"}, user ${account.userRateLimitTier ?? "unknown"}`,
        `Extra usage: ${account.hasExtraUsageEnabled === undefined ? "unknown" : account.hasExtraUsageEnabled ? "enabled" : "disabled"}`,
      );
    }
    const providers = Object.entries(view.usage?.providers ?? {}).sort(([left], [right]) => left.localeCompare(right));
    if (providers.length === 0) {
      lines.push("Usage: nothing recorded yet");
    }
    for (const [provider, state] of providers) {
      lines.push(`Usage via ${provider}: last request ${state.lastRequestAt} (${String(state.lastStatus)})`, ...snapshotLines(view.usage, provider));
    }
    return lines;
  });
}

/** Registers `claude-use usage` and `claude-use account show`. */
export function registerUsageCommands(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  withExamples(
    program
      .command("usage")
      .description(
        `Report recorded requests, token usage and the latest quota state per identity and provider, from the usage log the front door writes (the last ${String(USAGE_RETENTION_MS / DAY_MS)} days). Read-only.`,
      )
      .option("--identity <name>", "Only this identity's requests and snapshot.")
      .option("--provider <name>", "Only this provider's requests (anthropic for OAuth sessions).")
      .option("--since <duration>", "Only requests from this long ago on: a count followed by m, h, d or w, such as 5h or 7d.", parseDurationOption)
      .option("--json", "Print the report as JSON.")
      .action((options: Readonly<{ identity?: string; provider?: string; since?: number; json?: boolean }>) => {
        const report = collectUsageReport(realFarmFs, paths, {
          ...(options.identity === undefined ? {} : { identity: options.identity }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.since === undefined ? {} : { sinceMs: Date.now() - options.since }),
        });
        if (options.json === true) {
          printJson(report);
          return;
        }
        for (const line of formatUsageReport(report)) {
          console.log(line);
        }
      }),
    ["claude-use usage", "claude-use usage --identity work --since 5h", "claude-use usage --provider z --json"],
  );

  const account = withExamples(program.command("account").description("Inspect the Claude account behind each identity: plan, tier and latest quota."), [
    "claude-use account show work",
  ]);
  withExamples(
    account
      .command("show [identity]")
      .description("Show an identity's account metadata (read live from its stored login) and its latest recorded quota; every identity when none is named. Read-only.")
      .option("--json", "Print the accounts as JSON.")
      .action((identity: string | undefined, options: Readonly<{ json?: boolean }>) => {
        const views = collectAccounts(realFarmFs, paths, identity);
        if (options.json === true) {
          printJson(identity === undefined ? views : views[0]);
          return;
        }
        for (const line of formatAccounts(views)) {
          console.log(line);
        }
      }),
    ["claude-use account show", "claude-use account show work", "claude-use account show work --json"],
  );
}

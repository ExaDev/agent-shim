import os from "node:os";
import { UsageError } from "./cliError";
import { CODEX_CATEGORIES } from "./codex/categories";
import { canonicalCodexHome, codexCredentialGuard, type CodexCredentialGuardResult } from "./codex/identity";
import { loadClassification } from "./config/classify";
import { cosmiconfigReader } from "./config/load";
import { selectLaunch } from "./launchSelection";
import { loadCascadeInput } from "./launcher/cascade";
import { resolveClaudeHome } from "./paths";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { cascadeProviderName } from "./providersStore";
import { claudeCodeKeychainService } from "./usage/signIn";
import { realFarmFs, realFsPort, realInstalledClaudeVersions, realRunPort, resolveGitBranch } from "./realPorts";
import path from "node:path";
import { z } from "zod";
import { parseEnvBool } from "./cli/envBool";
import type { CHECK_CREDENTIAL_APPLIES, CheckReportJson } from "./checkReportSchema";
import { ConfigFileNotJsonError, ConfigValidationError } from "./config/load";
import { SHIPPED_CATEGORY_DEFAULTS, isHttpProvider, isRouterProvider, type CategoryClassification, type CategoryClassificationOverlay, type Credential, type Identity, type Provider } from "./config/schema";
import { probeProviderReachability, realBaseUrlProbe, type BaseUrlProbe } from "./providerReachability";
import { identityIdOf } from "./identityStore";
import { formatCredentialSummary, identityCacheKey, summariseCredential, type CredentialCacheEnv, type CredentialSummary } from "./credential";
import { resolveClaudeVersion, type PinnedClaudeVersion } from "./launcher/claudeVersion";
import { describeCachedCredential, formatCachedCredentialState, type CachedCredentialState } from "./credentialCache";
import { buildEntryFacts } from "./launcher/farm";
import { AMBIENT_CREDENTIAL_VARS, evaluateAmbientCredentialGuard, type AmbientCredentialGuardResult } from "./launcher/guard";
import type { ConfigProfileDecisionSource, IdentityDecisionSource } from "./launcher/identity";
import type { FarmFs, RunPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";
import type { PoolPickReport } from "./usage/pickReportSchema";
import { LegacyProviderFileError, readProvider } from "./providersStore";
import { detectEncodingAmbiguity, type EncodingAmbiguity } from "./resolve/projects";
import { launchEnvironment } from "./launcher/injected";
import { descendPolicyFor, resolveDecisions, type ResolvedState } from "./resolve/pipeline";
import type { CascadeInput } from "./resolve/walk";
import type { Decision, EntryFacts, FlattenedCascade } from "./resolve/types";

/** The literal key prefix a `history/projects/` entries key always carries — see `src/resolve/match.ts`'s own `PROJECTS_PREFIX`, which is the canonical (category-stripped) form of this same prefix. */
const HISTORY_PROJECTS_KEY_PREFIX = "history/projects/";

/**
 * Recovers the path fragment a `history/projects/` entries key was written with, from its `rawKey` — the only place the as-written fragment survives past canonicalisation. Undefined for any rule not written under this prefix.
 */
function projectFragmentOf(rawKey: string): string | undefined {
  return rawKey.startsWith(HISTORY_PROJECTS_KEY_PREFIX) ? rawKey.slice(HISTORY_PROJECTS_KEY_PREFIX.length) : undefined;
}

/** The immediate child names actually present under `~/.claude/projects/` in a fact manifest — Claude Code's own real, encoded directory names, used to report how many an ambiguous pattern actually matches today. */
function existingProjectNames(facts: EntryFacts): string[] {
  const names = new Set<string>();
  const prefix = "projects/";
  for (const rel of facts.entries.keys()) {
    if (!rel.startsWith(prefix)) {
      continue;
    }
    const rest = rel.slice(prefix.length);
    const head = rest.split("/")[0];
    if (head !== undefined && head !== "") {
      names.add(head);
    }
  }
  return [...names];
}

/**
 * Flags every `history/projects/` entries rule in scope whose encoded form could plausibly correspond to more than one real path.
 *
 * Reuses `src/resolve/projects.ts`'s own `detectEncodingAmbiguity` rather than reimplementing the detection — this function's whole job is recovering the as-written fragments from the flattened cascade's compiled rules and handing them to that function, plus the real project directory names already present in the fact manifest so the report can say how many a pattern actually matches today.
 */
export function flagAmbiguousEncodings(flattened: FlattenedCascade, facts: EntryFacts): EncodingAmbiguity[] {
  const fragments: string[] = [];
  for (const rule of flattened.rules.values()) {
    const fragment = projectFragmentOf(rule.rawKey);
    if (fragment !== undefined) {
      fragments.push(fragment);
    }
  }
  if (fragments.length === 0) {
    return [];
  }
  return detectEncodingAmbiguity(fragments, { home: facts.home, existingNames: existingProjectNames(facts) });
}

/** Renders one entry's resolved decision as a single explanatory line, for `agent-shim check`'s printout. */
export function formatDecision(decision: Decision): string {
  const status = decision.shared ? "shared" : "hidden";
  let reason: string;
  switch (decision.via) {
    case "secret-floor":
      reason = "secret (never shared, cannot be overridden by any layer)";
      break;
    case "unclassified":
      reason = "unclassified entry (no category recognises it)";
      break;
    case "entry-rule":
      reason =
        decision.rule === undefined
          ? "an entries rule"
          : `entries rule "${decision.rule.rawKey}" from layer ${String(decision.rule.layer)}`;
      break;
    case "category-override":
      reason = `category "${decision.category ?? "?"}" overridden by a layer`;
      break;
    case "category-default":
      reason = `category "${decision.category ?? "?"}" shipped default`;
      break;
  }
  const eliminatedNote =
    decision.eliminated !== undefined && decision.eliminated.length > 0
      ? ` [${String(decision.eliminated.length)} more specific rule(s) eliminated by a failing when-condition]`
      : "";
  return `${decision.relPath}: ${status} — ${reason}${eliminatedNote}`;
}

/** The result of looking up the macOS Keychain service name Claude Code is actually using for one identity's farm. */
export interface KeychainLookupResult {
  readonly checked: true;
  readonly found: boolean;
  readonly serviceName?: string;
  readonly note: string;
}

/**
 * Looks up the macOS Keychain entry Claude Code is using for one identity's configuration directory, via `security find-generic-password`, run through the injected `RunPort` so no test ever shells out for real.
 *
 * This is real OS state: the exact account/service naming Claude Code uses in the Keychain is empirically observed (per this project's README), not a documented contract, so genuinely exercising this against a real Keychain is a manual/integration check on a macOS runner, never something a unit test fakes convincingly — a unit test here can only prove that this function parses `security`'s own output shape correctly, not that the shape matches what a real installation produces.
 */
export function lookupKeychainService(run: RunPort, farmRoot: string): KeychainLookupResult {
  const serviceName = claudeCodeKeychainService(farmRoot);
  const result = run.run("security", ["find-generic-password", "-s", serviceName]);
  if (result.status !== 0) {
    return {
      checked: true,
      found: false,
      serviceName,
      note: `No Keychain entry found for service "${serviceName}" (security exited ${result.status === null ? "with no status" : String(result.status)}).`,
    };
  }
  return { checked: true, found: true, serviceName, note: `Keychain service name for this identity: "${serviceName}".` };
}

/** The loose shape of `settings.json`/`settings.local.json` this diagnostic actually reads. Deliberately not a full schema for the file — nothing else in this project needs to validate the rest of it, and being loose here means an unrelated field never breaks this one advisory. */
const SettingsSecretsShapeSchema = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional(),
  hooks: z.record(z.string(), z.array(z.unknown())).optional(),
});

/** Counts the `hooks` command entries nested inside one hook-group object, without ever reading a command's own value. */
function hookCommandCountOf(group: unknown): number {
  if (typeof group !== "object" || group === null) {
    return 0;
  }
  if (!("hooks" in group)) {
    return 0;
  }
  return Array.isArray(group.hooks) ? group.hooks.length : 0;
}

function countHookCommands(hooks: Readonly<Record<string, readonly unknown[]>> | undefined): number {
  if (hooks === undefined) {
    return 0;
  }
  let total = 0;
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      total += hookCommandCountOf(group);
    }
  }
  return total;
}

/** One file's reported settings exposure: names and counts only, never the underlying values. */
export interface SettingsExposureReport {
  readonly file: string;
  readonly envKeyNames: readonly string[];
  readonly hookEventNames: readonly string[];
  readonly hookCommandCount: number;
}

/** Inputs to `inspectSettingsExposure`. */
export interface InspectSettingsExposureParams {
  /** Whether the `settings` category resolves shared for this launch — the advisory only has anything to report when it does. */
  readonly settingsShared: boolean;
  /** Raw file contents keyed by filename (`settings.json`, `settings.local.json`), undefined when the file does not exist. */
  readonly files: Readonly<Record<string, string | undefined>>;
}

/**
 * Reports how many `env` keys and `hooks` commands `settings.json`/`settings.local.json` would share, by name and count only — never a value, per the README's own warning that a hook command or an `env` entry there can easily hold a real secret with nothing in Claude Code's own documentation warning against it.
 *
 * Returns nothing at all when `settingsShared` is false, and nothing for a file whose `env`/`hooks` fields are both empty or absent — the whole point of this advisory is to be silent unless there is something worth a second look.
 */
export function inspectSettingsExposure(params: InspectSettingsExposureParams): SettingsExposureReport[] {
  if (!params.settingsShared) {
    return [];
  }
  const reports: SettingsExposureReport[] = [];
  for (const [file, raw] of Object.entries(params.files)) {
    if (raw === undefined) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = SettingsSecretsShapeSchema.safeParse(parsed);
    if (!result.success) {
      continue;
    }
    const envKeyNames = Object.keys(result.data.env ?? {});
    const hookEventNames = Object.keys(result.data.hooks ?? {});
    const hookCommandCount = countHookCommands(result.data.hooks);
    if (envKeyNames.length === 0 && hookCommandCount === 0) {
      continue;
    }
    reports.push({ file, envKeyNames, hookEventNames, hookCommandCount });
  }
  return reports;
}

/** The provider the cascade selects for this directory, as the wiring layer loaded it: its definition, or why it could not be used (no such provider, an invalid or old-format file). */
type CheckProviderInput =
  | { readonly name: string; readonly definition: Provider; readonly problem?: never }
  | { readonly name: string; readonly definition?: never; readonly problem: string };

/**
 * Which credential a launch here would use, by source kind and target only: a selected provider's credential block always wins; otherwise the identity's own credential block; otherwise the login stored in the identity's directory.
 */
interface CredentialReport {
  readonly applies: (typeof CHECK_CREDENTIAL_APPLIES)[number];
  /** The selected provider's usable block (with what its cache holds), or why it could not be used; the two never appear together, exactly as `CheckProviderInput` states it. */
  readonly provider?: { readonly name: string; readonly credential?: CredentialSummary; readonly cached?: CachedCredentialState; readonly problem?: never } | { readonly name: string; readonly problem: string; readonly credential?: never; readonly cached?: never };
  readonly identity?: CredentialSummary;
  /** What the identity's own credential cache holds, when its block caches and the cache could be read. */
  readonly identityCached?: CachedCredentialState;
}

/** The cache state for one credential block that asks for caching, or undefined when it does not or no cache port was given. Never carries the token. */
function cachedState(cacheEnv: CredentialCacheEnv | undefined, owner: string, block: Credential): CachedCredentialState | undefined {
  if (cacheEnv === undefined || block.cache === undefined) {
    return undefined;
  }
  return describeCachedCredential({ port: cacheEnv.port, platform: cacheEnv.platform, owner, cache: block.cache, nowMs: cacheEnv.now() });
}

function buildCredentialReport(provider: CheckProviderInput | undefined, identity: Identity | undefined, identityId: string | undefined, cacheEnv: CredentialCacheEnv | undefined): CredentialReport {
  const identityCredential = identity?.credential === undefined ? undefined : summariseCredential(identity.credential);
  const identityCached = identity?.credential === undefined || identityId === undefined ? undefined : cachedState(cacheEnv, identityCacheKey(identityId), identity.credential);
  const providerCredential = provider?.definition !== undefined && !isRouterProvider(provider.definition) ? provider.definition.credential : undefined;
  const providerCached = providerCredential === undefined || provider === undefined ? undefined : cachedState(cacheEnv, `provider ${provider.name}`, providerCredential);
  return {
    applies: provider !== undefined ? "provider" : identityCredential !== undefined ? "identity" : "stored-login",
    ...(provider === undefined
      ? {}
      : {
          provider:
            provider.problem === undefined
              ? { name: provider.name, ...(providerCredential === undefined ? {} : { credential: summariseCredential(providerCredential), ...(providerCached === undefined ? {} : { cached: providerCached }) }) }
              : { name: provider.name, problem: provider.problem },
        }),
    ...(identityCredential === undefined ? {} : { identity: identityCredential }),
    ...(identityCached === undefined ? {} : { identityCached }),
  };
}

/** Inputs to `runCheck` — everything already loaded/injected, exactly like the resolver core and the launcher: nothing in this function touches a real filesystem, git repository, clock, or environment itself. */
export interface RunCheckParams {
  readonly agent?: "claude" | "codex";
  readonly cwd: string;
  readonly home: string;
  readonly claudeHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a launch here would take the `CLAUDE_CONFIG_DIR` escape hatch (the selection says so). It decides whether the ambient-credential guard is judged over `env` as it is or without what a parent launcher injected, as the launch itself does. */
  readonly configDirEscapeHatch: boolean;
  readonly branch?: string;
  readonly branchDetached?: boolean;
  readonly nowMs: number;
  /** Used only to build the fact manifest by reading the canonical `~/.claude` tree — `runCheck` never mutates the farm and never spawns anything. */
  readonly farmFs: FarmFs;
  readonly cascade: CascadeInput;
  readonly classification: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
  readonly identityName?: string;
  /** The id the resolved identity is stored under, which keys its cached credential (see `identityCacheKey`). */
  readonly identityId?: string;
  readonly identitySource: IdentityDecisionSource;
  /** The pool the launch selected and how it ranks right now, when it named a pool instead of an identity; `identityName` is then the member it would pick. */
  readonly poolPick?: PoolPickReport;
  readonly configProfileName?: string;
  readonly configProfileSource: ConfigProfileDecisionSource;
  /** The resolved identity's own `identity.json`, when one was found. */
  readonly identity?: Identity;
  /** Raw `settings.json`/`settings.local.json` contents, keyed by filename, undefined when a file does not exist. */
  readonly settingsFiles: Readonly<Record<string, string | undefined>>;
  /** Runs `security find-generic-password` for the Keychain diagnostic. Omit to skip that diagnostic entirely (e.g. off macOS, or when no identity/farm root is known). */
  readonly run?: RunPort;
  /** The identity's own farm root — `security`'s lookup account. Required alongside `run` for the Keychain diagnostic to run at all. */
  readonly farmRoot?: string;
  /** `process.platform` in real use; the Keychain diagnostic only ever runs when this is `"darwin"`. */
  readonly platform: string;
  /** The provider a launch here would route through (`launch.provider` in the cascade), when one is selected. */
  readonly provider?: CheckProviderInput;
  /** The Claude Code versions installed here, oldest first. Omit to leave the Claude Code version out of the report; with it, `check` says which version a launch here runs and whether a pin is installed. */
  readonly installedClaudeVersions?: readonly string[];
  /** Where cached credentials live. Omit to skip reporting a credential cache's age; with it, a block that caches reports whether it holds an entry, how old it is and whether it has expired, never the token. */
  readonly credentialCache?: CredentialCacheEnv;
  /** Opens one connection to the selected http provider's base URL, bounded by its connect timeout. Omit to leave reachability out of the report. */
  readonly probeBaseUrl?: BaseUrlProbe;
}

/** Whether the selected http provider's base URL accepted a connection, as `check` reports it. */
type ProviderReachabilityReport = { readonly name: string; readonly baseUrl: string; readonly ok: true } | { readonly name: string; readonly baseUrl: string; readonly ok: false; readonly message: string };

/** Everything `agent-shim check` reports about one directory/identity, without touching the farm or spawning anything. */
export interface CheckReport {
  readonly identityName?: string;
  readonly identitySource: IdentityDecisionSource;
  readonly poolPick?: PoolPickReport;
  readonly configProfileName?: string;
  readonly configProfileSource: ConfigProfileDecisionSource;
  readonly resolved: ResolvedState;
  readonly decisionLines: readonly string[];
  readonly projectEncodingAmbiguities: readonly EncodingAmbiguity[];
  readonly ambientCredential: AmbientCredentialGuardResult | CodexCredentialGuardResult;
  readonly keychain?: KeychainLookupResult;
  readonly settingsExposure: readonly SettingsExposureReport[];
  readonly credential: CredentialReport;
  /** The Claude Code version a launch here would run, when the installed versions were given. */
  readonly claudeVersion?: ClaudeVersionReport;
  /** Whether the selected provider's base URL accepts a connection, when an http provider is selected and a probe was given. */
  readonly providerReachability?: ProviderReachabilityReport;
}

/** Which Claude Code version a launch would run: the pin and where it comes from, with whether it is installed, or the highest installed version when nothing pins one. */
interface ClaudeVersionReport {
  readonly pinned?: PinnedClaudeVersion & { readonly installed: boolean };
  readonly highestInstalled?: string;
  readonly installed: readonly string[];
}

function buildClaudeVersionReport(params: Pick<RunCheckParams, "env" | "installedClaudeVersions">, cascadePin: string | undefined): ClaudeVersionReport | undefined {
  const installed = params.installedClaudeVersions;
  if (installed === undefined) {
    return undefined;
  }
  const pin = resolveClaudeVersion({ env: params.env, ...(cascadePin === undefined ? {} : { cascade: cascadePin }) });
  const highestInstalled = installed.at(-1);
  return {
    ...(pin === undefined ? {} : { pinned: { ...pin, installed: installed.includes(pin.version) } }),
    ...(highestInstalled === undefined ? {} : { highestInstalled }),
    installed,
  };
}

/**
 * Resolves the full cascade for one directory/identity and reports everything `agent-shim check` documents: every entry's resolved state and which layer/condition decided it, any ambiguous `history/projects/` encoding in scope, and the three always-on diagnostics (ambient-credential exposure, macOS Keychain service name, settings-secrets exposure).
 *
 * Deliberately reuses the same cascade machinery a real launch uses — `resolveDecisions` and `buildEntryFacts` — rather than reimplementing any part of resolution. The one thing this function never does that a launch does is touch the farm or spawn anything: it only reads the canonical `~/.claude` tree to build the fact manifest resolution needs, and every other input (cascade, classification, settings file contents, the Keychain lookup) is handed in already loaded.
 */
export function runCheck(params: RunCheckParams): CheckReport {
  const isCodex = params.agent === "codex" || params.identity?.agent === "codex";
  const facts = buildEntryFacts({
    fs: params.farmFs,
    claudeHome: params.claudeHome,
    home: params.home,
    cwd: params.cwd,
    nowMs: params.nowMs,
    env: params.env,
    ...(params.branch === undefined ? {} : { branch: params.branch }),
    ...(params.branchDetached === undefined ? {} : { branchDetached: params.branchDetached }),
    descend: descendPolicyFor(params.cascade, params.home),
  });

  const resolved = resolveDecisions({ facts, cascade: params.cascade, classification: params.classification });

  const decisionLines = [...resolved.decisions.values()]
    .slice()
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map(formatDecision);

  const projectEncodingAmbiguities = flagAmbiguousEncodings(resolved.flattened, facts);

  const guardEnv = launchEnvironment(params.env, params.configDirEscapeHatch);
  // Codex reads its own credential variables, which no Claude launcher injects, so the Codex guard reads the environment as it is.
  const ambientCredential = isCodex ? codexCredentialGuard(params.env, params.identity?.allowAmbientCredential ?? false) : evaluateAmbientCredentialGuard({
    env: guardEnv,
    allowAmbientCredential: params.identity?.allowAmbientCredential ?? false,
    allowAmbientCredentialOverride: parseEnvBool("AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL", guardEnv.AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL) === true,
    ...(params.identityName === undefined ? {} : { identityName: params.identityName }),
  });

  const settingsShared = resolved.flattened.categories.get("settings") ?? SHIPPED_CATEGORY_DEFAULTS.settings;
  const settingsExposure = inspectSettingsExposure({ settingsShared, files: params.settingsFiles });

  const keychain =
    !isCodex && params.platform === "darwin" && params.run !== undefined && params.farmRoot !== undefined
      ? lookupKeychainService(params.run, params.farmRoot)
      : undefined;

  const claudeVersion = isCodex ? undefined : buildClaudeVersionReport(params, resolved.flattened.launch.claudeVersion);

  const providerReachability = buildProviderReachability(params.provider, params.probeBaseUrl);
  return {
    ...(params.identityName === undefined ? {} : { identityName: params.identityName }),
    identitySource: params.identitySource,
    ...(params.poolPick === undefined ? {} : { poolPick: params.poolPick }),
    ...(params.configProfileName === undefined ? {} : { configProfileName: params.configProfileName }),
    configProfileSource: params.configProfileSource,
    resolved,
    decisionLines,
    projectEncodingAmbiguities,
    ambientCredential,
    ...(keychain === undefined ? {} : { keychain }),
    settingsExposure,
    credential: buildCredentialReport(params.provider, params.identity, params.identityId, params.credentialCache),
    ...(claudeVersion === undefined ? {} : { claudeVersion }),
    ...(providerReachability === undefined ? {} : { providerReachability }),
  };
}

/** Probes the selected provider's base URL, when it is an http provider and a probe was given. */
function buildProviderReachability(provider: CheckProviderInput | undefined, probe: BaseUrlProbe | undefined): ProviderReachabilityReport | undefined {
  if (provider?.definition === undefined || probe === undefined || !isHttpProvider(provider.definition)) {
    return undefined;
  }
  const { baseUrl } = provider.definition;
  const reachability = probeProviderReachability(provider.name, provider.definition, probe);
  return reachability.ok ? { name: provider.name, baseUrl, ok: true } : { name: provider.name, baseUrl, ok: false, message: reachability.message };
}

/** Renders a full `CheckReport` as plain text lines, in the order `agent-shim check` prints them. */
export function formatCheckReport(report: CheckReport): string[] {
  const lines: string[] = [];
  lines.push(`Identity: ${report.identityName ?? "(none)"} (${report.identitySource})`);
  if (report.poolPick !== undefined) {
    const top = report.poolPick.candidates.find((candidate) => candidate.identity === report.poolPick?.pick);
    lines.push(`Pool: ${report.poolPick.pool}${top === undefined ? ", every member is refused right now" : `, would pick ${top.identity} (${top.reasons.join("; ")})`}`);
  }
  lines.push(`Configuration profile: ${report.configProfileName ?? "(none)"} (${report.configProfileSource})`);

  lines.push("", "Layers (shallowest/earliest first):");
  for (const layer of report.resolved.assembled.layers) {
    lines.push(`  [${String(layer.id)}] ${layer.kind}: ${layer.source}`);
  }

  lines.push("", "Resolved entries:");
  if (report.decisionLines.length === 0) {
    lines.push("  (nothing in the canonical home to report)");
  }
  for (const line of report.decisionLines) {
    lines.push(`  ${line}`);
  }

  if (report.projectEncodingAmbiguities.length > 0) {
    lines.push("", "Ambiguous history/projects/ encodings:");
    for (const ambiguity of report.projectEncodingAmbiguities) {
      lines.push(`  "${ambiguity.fragment}" -> "${ambiguity.encoded}" (${ambiguity.reason}): ${ambiguity.detail}`);
    }
  }

  if (report.resolved.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of report.resolved.diagnostics) {
      lines.push(`  [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  lines.push("", "Credential (source kinds and targets only, never values):");
  const { credential } = report;
  if (credential.provider !== undefined) {
    lines.push(
      `  Provider ${credential.provider.name}: ${credential.provider.credential === undefined ? `unusable: ${credential.provider.problem ?? ""}` : formatCredentialSummary(credential.provider.credential)}${credential.provider.cached === undefined ? "" : `; ${formatCachedCredentialState(credential.provider.cached)}`}`,
    );
  }
  if (credential.identity !== undefined) {
    lines.push(
      `  Identity ${report.identityName ?? "(none)"}: ${formatCredentialSummary(credential.identity)}${credential.identityCached === undefined ? "" : `; ${formatCachedCredentialState(credential.identityCached)}`}${credential.applies === "provider" ? " (not used: the provider's credential applies)" : ""}`,
    );
  }
  if (credential.applies === "stored-login") {
    lines.push("  The identity's stored login (no credential block applies).");
  }

  if (report.providerReachability !== undefined) {
    lines.push("", "Provider reachability:");
    const reachability = report.providerReachability;
    lines.push(reachability.ok ? `  Provider ${reachability.name}: ${reachability.baseUrl} accepts connections` : `  [FAIL] ${reachability.message}`);
  }

  if (report.claudeVersion !== undefined) {
    lines.push("", "Claude Code version:");
    const { pinned, highestInstalled, installed } = report.claudeVersion;
    if (pinned !== undefined) {
      lines.push(
        pinned.installed
          ? `  ${pinned.version}, pinned by the ${pinned.source} (installed)`
          : `  ${pinned.version}, pinned by the ${pinned.source}, but NOT installed; a launch here fails. Installed: ${installed.length === 0 ? "none" : installed.join(", ")}`,
      );
    } else {
      lines.push(highestInstalled === undefined ? "  none installed in the versions directory (a launch falls back to a claude on PATH)" : `  ${highestInstalled} (the highest installed; nothing pins a version)`);
    }
  }

  lines.push("", "Ambient-credential exposure:");
  lines.push(
    report.ambientCredential.ok
      ? `  OK — none of ${AMBIENT_CREDENTIAL_VARS.join(", ")} is set to a non-empty value.`
      : report.ambientCredential.message
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
  );

  if (report.keychain !== undefined) {
    lines.push("", "macOS Keychain:");
    lines.push(`  ${report.keychain.note}`);
  }

  if (report.settingsExposure.length > 0) {
    lines.push("", "Settings exposure (names and counts only, never values):");
    for (const exposure of report.settingsExposure) {
      lines.push(
        `  ${exposure.file}: ${String(exposure.envKeyNames.length)} env key(s) [${exposure.envKeyNames.join(", ")}], ` +
          `${String(exposure.hookEventNames.length)} hook event(s) [${exposure.hookEventNames.join(", ")}], ` +
          `${String(exposure.hookCommandCount)} hook command(s)`,
      );
    }
  }

  return lines;
}

/**
 * The `check --json` form of a report: every field the text form prints, as plain data (no `Map`s, no compiled matchers), so a script can read the same verdicts a person would.
 */
export function checkReportToJson(report: CheckReport): CheckReportJson {
  const decisions = [...report.resolved.decisions.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return {
    identity: { name: report.identityName ?? null, source: report.identitySource },
    ...(report.poolPick === undefined ? {} : { pool: report.poolPick }),
    configProfile: { name: report.configProfileName ?? null, source: report.configProfileSource },
    layers: report.resolved.assembled.layers.map((layer) => ({ id: layer.id, kind: layer.kind, source: layer.source })),
    entries: decisions.map((decision) => ({
      path: decision.relPath,
      shared: decision.shared,
      via: decision.via,
      category: decision.category,
      ...(decision.rule === undefined ? {} : { rule: { key: decision.rule.rawKey, layer: decision.rule.layer } }),
      ...(decision.eliminated === undefined || decision.eliminated.length === 0
        ? {}
        : { eliminated: decision.eliminated.map((eliminated) => ({ key: eliminated.rule.rawKey, failed: eliminated.failed })) }),
    })),
    projectEncodingAmbiguities: report.projectEncodingAmbiguities,
    diagnostics: report.resolved.diagnostics,
    ambientCredential: report.ambientCredential.ok
      ? { ok: true }
      : { ok: false, variable: report.ambientCredential.variable, message: report.ambientCredential.message },
    ...(report.keychain === undefined ? {} : { keychain: report.keychain }),
    settingsExposure: report.settingsExposure,
    credential: report.credential,
    ...(report.claudeVersion === undefined ? {} : { claudeVersion: report.claudeVersion }),
    ...(report.providerReachability === undefined ? {} : { providerReachability: report.providerReachability }),
  };
}

/**
 * Whether a report carries anything `check --strict` fails on: a resolver diagnostic of warning or error severity, an ambiguous `history/projects/` encoding, an ambient credential a launch would refuse, a selected provider a launch could not use, or one whose base URL accepts no connection. Informational diagnostics and the settings-exposure advisory (names and counts only, for a person to review) never fail it.
 */
export function checkReportHasWarnings(report: CheckReport): boolean {
  return (
    report.resolved.diagnostics.some((diagnostic) => diagnostic.severity !== "info") ||
    report.projectEncodingAmbiguities.length > 0 ||
    !report.ambientCredential.ok ||
    report.credential.provider?.problem !== undefined ||
    report.providerReachability?.ok === false ||
    report.claudeVersion?.pinned?.installed === false
  );
}

/** Loads the cascade's selected provider for `check`, turning a missing, invalid or old-format file into a reported problem rather than an aborted report. */
function loadCheckProvider(paths: LayoutPaths, name: string): CheckProviderInput {
  let definition: Provider | undefined;
  try {
    definition = readProvider(paths, name);
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof LegacyProviderFileError || error instanceof ConfigFileNotJsonError) {
      return { name, problem: error.message };
    }
    throw error;
  }
  return definition === undefined ? { name, problem: `no provider named "${name}"` } : { name, definition };
}

/** What `collectCheckReport` needs from its caller. */
export interface CollectCheckReportParams {
  readonly agent?: "claude" | "codex";
  readonly paths: LayoutPaths;
  /** The directory a launch would run in; resolved against the working directory by the caller. */
  readonly cwd: string;
  /** The identity to check, as `--identity` names it; absent means the identity a launch there would resolve. */
  readonly identity?: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Resolves what a launch in `params.cwd` would share or hide, and why, against this machine: the edge adapter that reads the real filesystem, clock, git and keychain, resolves the identity, configuration profile and cascade exactly as a launch does, and hands the facts to the pure `runCheck`. Never touches the farm or spawns claude.
 */
export function collectCheckReport(params: CollectCheckReportParams): CheckReport {
  const { paths, cwd } = params;
  const home = os.homedir();
  const read = cosmiconfigReader();

  const loaded = loadCascadeInput({ paths, home, cwd, read });
  const git = resolveGitBranch(realRunPort, cwd);

  const { selection, identityConfig } = selectLaunch({ paths, cwd, env: params.agent === "codex" ? { ...params.env, CLAUDE_CONFIG_DIR: undefined } : params.env, ...(params.identity === undefined ? {} : { identity: params.identity }) }, loaded);
  const { identity: identityDecision, poolPick, configProfile: configProfileDecision } = selection;
  const isCodex = identityConfig?.agent === "codex" || params.agent === "codex";
  if (identityConfig !== undefined && params.agent !== undefined && (identityConfig.agent ?? "claude") !== params.agent) throw new UsageError("The selected identity belongs to a different agent.");
  const claudeHome = isCodex ? canonicalCodexHome(params.env, home) : resolveClaudeHome();
  const classification = isCodex ? { defaults: CODEX_CATEGORIES } : loadClassification(paths);

  const cascade = loadCascadeInput({
    paths,
    home,
    cwd,
    read,
    ...(configProfileDecision.name === undefined ? {} : { baseConfigProfile: configProfileDecision.name }),
  }).input;

  const providerName = cascadeProviderName(cascade, identityConfig?.provider);
  const provider = providerName === undefined ? undefined : loadCheckProvider(paths, providerName);

  const identityId = identityDecision.name === undefined ? undefined : identityIdOf(paths, identityDecision.name);
  const farmRoot = identityId === undefined ? undefined : path.join(paths.identitiesDir, identityId);
  const settingsFiles = isCodex ? {} : {
    "settings.json": realFsPort.readFileUtf8(path.join(claudeHome, "settings.json")),
    "settings.local.json": realFsPort.readFileUtf8(path.join(claudeHome, "settings.local.json")),
  };

  const report = runCheck({
    ...(isCodex ? { agent: "codex" } : {}),
    cwd,
    home,
    claudeHome,
    env: params.env,
    configDirEscapeHatch: identityDecision.configDirEscapeHatch,
    ...(git.branch === undefined ? {} : { branch: git.branch }),
    ...(git.branchDetached === undefined ? {} : { branchDetached: git.branchDetached }),
    nowMs: Date.now(),
    farmFs: realFarmFs,
    cascade,
    classification,
    ...(identityDecision.name === undefined ? {} : { identityName: identityDecision.name }),
    ...(identityId === undefined ? {} : { identityId }),
    identitySource: identityDecision.source,
    ...(poolPick === undefined ? {} : { poolPick }),
    ...(configProfileDecision.name === undefined ? {} : { configProfileName: configProfileDecision.name }),
    configProfileSource: configProfileDecision.source,
    ...(identityConfig === undefined ? {} : { identity: identityConfig }),
    settingsFiles,
    run: realRunPort,
    credentialCache: realCredentialCacheEnv(paths),
    ...(isCodex ? {} : { installedClaudeVersions: realInstalledClaudeVersions() }),
    ...(farmRoot === undefined ? {} : { farmRoot }),
    platform: process.platform,
    ...(provider === undefined ? {} : { provider }),
    probeBaseUrl: realBaseUrlProbe,
  });
  return report;
}

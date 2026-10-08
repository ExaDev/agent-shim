import { ClaudeShimStateSchema, commandFilename, findPathShadow, resolveOwnBinaryCheck, type ClaudeShimState, type PathShadowStatus } from "./claudeShim";
import type { LayoutPaths } from "./paths";
import { readJson } from "./config/store";
import { isIdentityDirectoryName } from "./identityStore";
import { findExecutableInDir, realContentSourcePath, realFarmFs, realFsPort, realInstalledClaudeVersions, realIsProcessRunning, realOwnExecutablePath, realResolveClaudeBinary, realRunPort } from "./realPorts";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { lookupKeychainService } from "./checkReport";
import { parseSiwcFile } from "./codex/siwcStore";
import { SIWC_PLAN_SCOPE } from "./codex/siwc";
import { ConfigValidationError } from "./config/load";
import { CategoryClassificationOverlaySchema, ConfigProfileSchema, DirectoryRulesSchema, GlobalConfigSchema, IdentitySchema, isCodexProvider, poolMemberIdentity, ProviderSchema, type Credential } from "./config/schema";
import { describeCredential, type CredentialCacheEnv } from "./credential";
import { describeCachedCredential, formatCachedCredentialState } from "./credentialCache";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { isMovingGitSource } from "./headroom/source";
import { HeadroomStateSchema, resolveServingHeadroomState } from "./headroom/state";
import { ENV_PREFIX, LEGACY_ENV_PREFIX, LEGACY_HOME_DIRNAME } from "./legacy";
import { describeProviderEndpoint, legacyProviderConversion, LegacyProviderFileError } from "./providersStore";
import { detectAmbientCredential, formatAmbientCredentialGuardMessage } from "./launcher/guard";
import { poolNameOf } from "./launcher/identity";
import { poolCycleOf } from "./poolStore";
import type { RunPort } from "./launcher/ports";
import { lineariseProfile, type ProfileLoader, type ProfileSource } from "./resolve/extends";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

export const DOCTOR_SEVERITIES = ["pass", "warn", "fail"] as const;
type DoctorSeverity = (typeof DOCTOR_SEVERITIES)[number];

export const DOCTOR_SECTIONS = [
  "ambient-credential",
  "binary-discovery",
  "claude-shim",
  "path-resolution",
  "legacy-name",
  "config-profile",
  "identity",
  "pool",
  "provider",
  "keychain",
  "directory-rules",
  "global-config",
  "categories-local",
  "active-identity",
  "headroom",
] as const;
type DoctorSection = (typeof DOCTOR_SECTIONS)[number];

/** One line of `agent-shim doctor`'s report. `subject` names the identity/profile/rule the finding is about, when the section has more than one of those. */
interface DoctorFinding {
  readonly section: DoctorSection;
  readonly subject?: string;
  readonly severity: DoctorSeverity;
  readonly message: string;
}

/** The full result of `runDoctor`. `ok` is false iff any finding is a `fail` — a `warn` never fails the report on its own. */
export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly ok: boolean;
}

/** One identity's raw `identity.json`, unparsed — `runDoctor` does its own JSON.parse/schema validation so one malformed file never aborts the rest of the report. */
export interface DoctorIdentityInput {
  readonly name: string;
  readonly path: string;
  readonly raw: string | undefined;
  /** The identity's own farm root (`identitiesDir/<name>`) — the account name the Keychain lookup uses. */
  readonly farmRoot: string;
}

/** One configuration profile's raw `<name>.json`, unparsed. */
export interface DoctorConfigProfileInput {
  readonly name: string;
  readonly path: string;
  readonly raw: string | undefined;
}

/** One provider's raw `<name>.json`, unparsed. */
export interface DoctorProviderInput {
  readonly name: string;
  readonly path: string;
  readonly raw: string | undefined;
}

/** A single optional top-level file `runDoctor` validates against a schema when present — absent is a legitimate, unconfigured state, not a failure. */
interface DoctorFileInput {
  readonly path: string;
  readonly raw: string | undefined;
}

/** The outcome of resolving the real Claude Code binary, pre-resolved by the wiring layer since `discoverClaudeBinary` is not itself a parse-shaped pure operation and already has its own dedicated test coverage. */
type DoctorBinaryDiscovery =
  | { readonly ok: true; readonly binary: DiscoveredClaudeBinary }
  | { readonly ok: false; readonly message: string };

/**
 * Where a bare command name resolves for the two names this tool owns.
 *
 * `ownExecutablePath` is this process's own PATH-visible location (`realOwnExecutablePath()`); `agentShim` is `findPathShadow`'s verdict for a bare `agent-shim` against the directory that executable lives in. `claude` is only populated when a shim is actually enabled — without one, a `claude` on PATH is Claude Code's own binary, which is not a shadow of anything.
 */
interface DoctorPathResolution {
  readonly ownExecutablePath: string;
  readonly agentShim: PathShadowStatus;
  readonly claude?: PathShadowStatus;
}

/**
 * Collapses a `shadowed` verdict back to `ok` when the shadowing entry and this executable are literally the same file reached by two names — `findPathShadow` compares *directories*, so a symlink on PATH pointing at the running executable's own real location otherwise reads as a shadow of itself.
 *
 * `realpath` must resolve symlinks, and must return its argument unchanged rather than throwing when the path cannot be resolved (a broken symlink, a race with an uninstall), so an unresolvable path simply stays unequal and the shadow verdict stands.
 */
export function refinePathShadow(
  status: PathShadowStatus,
  ownExecutablePath: string,
  realpath: (target: string) => string,
): PathShadowStatus {
  if (status.status !== "shadowed") {
    return status;
  }
  return realpath(status.by) === realpath(ownExecutablePath) ? { status: "ok" } : status;
}

/** Everything `runDoctor` needs, all of it already loaded/injected — nothing in `runDoctor` itself reads a file, shells out, or touches the farm. */
export interface RunDoctorParams {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The Claude Code versions installed here, oldest first. Omit to skip checking that a pinned version (`launch.claudeVersion`) is installed; with it, a profile, directory rule or global config pinning a version that is not installed is a warning. */
  readonly installedClaudeVersions?: readonly string[];
  /** Where cached credentials live. Omit to leave a credential cache's age out of the identity and provider findings; with it, a block that caches reports whether it holds an entry, how old it is and whether it has expired, never the token. */
  readonly credentialCache?: CredentialCacheEnv;
  /** The Sign in with ChatGPT file. Omit to leave it out of the findings; with it, a codex provider whose `codex.login` is `chatgpt-sign-in` warns when there is no usable sign-in to spend. */
  readonly chatgptSignIn?: { readonly path: string; readonly raw: string | undefined };
  readonly identities: readonly DoctorIdentityInput[];
  readonly configProfiles: readonly DoctorConfigProfileInput[];
  readonly providers: readonly DoctorProviderInput[];
  readonly directoryRules: DoctorFileInput;
  readonly globalConfig: DoctorFileInput;
  readonly categoriesLocal: DoctorFileInput;
  readonly activeIdentity: DoctorFileInput;
  readonly binaryDiscovery: DoctorBinaryDiscovery;
  /** Whether `agent-shim shim enable` has been run, and whether its recorded target still exists on disk — pre-resolved by the wiring layer, since checking a file's existence is real I/O, not a parse-shaped pure operation. */
  readonly claudeShim: { readonly state: ClaudeShimState | undefined; readonly targetExists: boolean };
  /** Which executables a bare `agent-shim` (and, when the shim is enabled, a bare `claude`) would actually run — pre-resolved by the wiring layer, since scanning PATH is real I/O. */
  readonly pathResolution: DoctorPathResolution;
  /** The resolved state root (`paths.root`), whose directory name says whether this installation still lives under the former `.claude-use` name. */
  readonly rootPath: string;
  /** Runs `security find-generic-password` for the per-identity Keychain check. Omit to skip that check entirely (e.g. off macOS). */
  readonly run?: RunPort;
  /** `process.platform` in real use; the Keychain check only ever runs when this is `"darwin"`. */
  readonly platform: string;
  /** The headroom daemon's state.json plus a zombie-aware liveness predicate for the pids it names (a defunct daemon serves nothing but still answers signal 0). Omit the raw text when the daemon has never run; that is a pass, not a failure. */
  readonly headroom: {
    readonly state: DoctorFileInput;
    readonly isRunning: (pid: number) => boolean;
  };
}

/** Parses and validates one optional JSON file's raw text against `schema`, without ever throwing — a missing file, invalid JSON, and a schema violation are each reported as their own failure message rather than aborting the caller. */
function validateJson<S extends z.ZodType>(
  schema: S,
  input: DoctorFileInput,
): { readonly ok: true; readonly data: z.infer<S> } | { readonly ok: false; readonly message: string } {
  if (input.raw === undefined) {
    return { ok: false, message: `${input.path} is missing.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch (error) {
    return { ok: false, message: `${input.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: new ConfigValidationError(input.path, result.error.issues).message };
  }
  return { ok: true, data: result.data };
}

/** Whether `raw` is the TCP-port era's state record (a `port` or `lastPort` key and no `socketPath`): content this release cannot parse but deliberately treats as claimable, so the doctor reports it as expected rather than malformed. */
function tcpPortEraRecord(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const has = (key: string): boolean => typeof parsed === "object" && parsed !== null && key in parsed;
  return (has("port") || has("lastPort")) && !has("socketPath");
}


/**
 * Reports which `agent-shim` a bare command name actually runs, and — when a `claude` shim is enabled — the same for `claude`.
 *
 * A shadowed `agent-shim` is a `fail`, not a `warn`, because it invalidates the rest of the report rather than merely sitting alongside it: every other finding here describes the binary that produced them, which by definition is not the binary the user's own commands reach. It is also a silent failure in every other respect, since the shadowing install keeps working, just at whatever version it was frozen at. Confirmed in the wild: a hand-written wrapper script from an earlier install channel sat ahead of `~/.local/bin` on PATH and kept re-execing a month-old binary, so a naming rule that had since widened kept rejecting an `identity.json` a current agent-shim had written — with nothing anywhere reporting that the running binary was not the installed one.
 *
 * `not-on-path` is a `warn` rather than a `fail`: invoking this tool by an absolute path, or through `npx`, is a legitimate one-off, and nothing about it is inconsistent.
 */
function pushPathResolution(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  resolution: DoctorPathResolution,
): void {
  const ownDir = path.dirname(resolution.ownExecutablePath);
  switch (resolution.agentShim.status) {
    case "ok":
      push("path-resolution", "pass", `\`agent-shim\` on PATH resolves to this running executable, ${resolution.ownExecutablePath}.`, "agent-shim");
      break;
    case "not-on-path":
      push(
        "path-resolution",
        "warn",
        `${ownDir} is not on PATH, so a bare \`agent-shim\` does not reach ${resolution.ownExecutablePath}. ` +
          "Add it to PATH, or keep invoking this executable by its full path.",
        "agent-shim",
      );
      break;
    case "shadowed":
      push(
        "path-resolution",
        "fail",
        `\`agent-shim\` on PATH resolves to ${resolution.agentShim.by}, not this running executable, ${resolution.ownExecutablePath}. ` +
          "Every command you type runs that one instead, at whatever version it happens to be — including the checks in this report, which describe this executable. " +
          `Remove ${resolution.agentShim.by}, repoint it at ${resolution.ownExecutablePath}, or put ${ownDir} ahead of it on PATH.`,
        "agent-shim",
      );
      break;
  }

  if (resolution.claude === undefined) {
    return;
  }
  switch (resolution.claude.status) {
    case "ok":
      push("path-resolution", "pass", "`claude` on PATH resolves to the enabled shim.", "claude");
      break;
    case "not-on-path":
      push("path-resolution", "warn", "The enabled `claude` shim's directory is not on PATH — add it, or use `agent-shim run` instead.", "claude");
      break;
    case "shadowed":
      push(
        "path-resolution",
        "warn",
        `\`claude\` on PATH resolves to ${resolution.claude.by}, not the enabled shim. ` +
          "Put the shim's directory ahead of it on PATH, or run `agent-shim shim disable` if you meant to launch that one directly.",
        "claude",
      );
      break;
  }
}

/**
 * What a credential block's cache holds, as a clause for a finding and whether it should fail the check: a block that does not cache, or a run with no cache port, adds nothing, and a store this platform cannot read fails because every launch using the credential would fail the same way.
 */
function cacheClause(cacheEnv: CredentialCacheEnv | undefined, owner: string, block: Credential): { readonly text: string; readonly unreadable: boolean } {
  if (cacheEnv === undefined || block.cache === undefined) {
    return { text: "", unreadable: false };
  }
  const state = describeCachedCredential({ port: cacheEnv.port, platform: cacheEnv.platform, owner, cache: block.cache, nowMs: cacheEnv.now() });
  return { text: `; ${formatCachedCredentialState(state)}`, unreadable: state.status === "unreadable" };
}

/** Why the Sign in with ChatGPT file cannot serve a request, or undefined when it can. */
function signInProblem(signIn: NonNullable<RunDoctorParams["chatgptSignIn"]>): string | undefined {
  if (signIn.raw === undefined) {
    return "nobody is signed in: run `agent-shim codex login`.";
  }
  try {
    const grant = parseSiwcFile(signIn.raw, signIn.path).grant;
    if (grant === undefined) {
      return "nobody is signed in: run `agent-shim codex login`.";
    }
    return grant.scopes.includes(SIWC_PLAN_SCOPE) ? undefined : "the login was not given permission to use your ChatGPT plan: run `agent-shim codex login` again and allow it.";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Reports one provider file: an old-format file (before the credential block) fails with the old fields named and the whole file rewritten in the current format, since that is the one change converting it needs; any other invalid file fails with its validation errors; a valid one passes with its credential described by source kind and target.
 */
function pushProvider(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, entry: DoctorProviderInput, cacheEnv: CredentialCacheEnv | undefined, signIn: RunDoctorParams["chatgptSignIn"]): void {
  if (entry.raw === undefined) {
    push("provider", "fail", `${entry.path} is missing.`, entry.name);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.raw);
  } catch (error) {
    push("provider", "fail", `${entry.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, entry.name);
    return;
  }
  const conversion = legacyProviderConversion(parsed);
  if (conversion !== undefined) {
    push("provider", "fail", new LegacyProviderFileError(entry.path, conversion).message, entry.name);
    return;
  }
  const validated = ProviderSchema.safeParse(parsed);
  if (!validated.success) {
    push("provider", "fail", new ConfigValidationError(entry.path, validated.error.issues).message, entry.name);
    return;
  }
  const cache = cacheClause(cacheEnv, `provider ${entry.name}`, validated.data.credential);
  push("provider", cache.unreadable ? "fail" : "pass", `${entry.name} is valid (${describeProviderEndpoint(validated.data)}, credential ${describeCredential(validated.data.credential)})${cache.text}.`, entry.name);
  // A provider session keeps the OAuth launch's shape (its base URL stays Claude Code's own API), so Claude Code defers MCP tool loading and the tool_reference payloads ride the door to the provider untouched. Naming the env-block lever here keeps the default visible; whether to pull it stays the reader's call, because turning it off only helps when the upstream backend cannot understand tool_reference itself.
  if (validated.data.env?.ENABLE_TOOL_SEARCH === undefined) {
    push("provider", "warn", `${entry.name} does not set ENABLE_TOOL_SEARCH: a session on this provider keeps Claude Code's own API as its base URL, so it defers MCP tool loading and sends tool_reference payloads the upstream backend must understand. Set ENABLE_TOOL_SEARCH=false in the provider's env block to load tools upfront instead, when the backend does not support them.`, entry.name);
  }
  if (signIn !== undefined && isCodexProvider(validated.data) && validated.data.codex?.login === "chatgpt-sign-in") {
    const problem = signInProblem(signIn);
    if (problem !== undefined) {
      push("provider", "warn", `${entry.name} uses the Sign in with ChatGPT login, but ${problem}`, entry.name);
    }
  }
}

/**
 * Reports what an installation still takes from the former `claude-use` name, each as a `warn` naming its replacement: a `CLAUDE_USE_*` variable (the process environment has already had it aliased to `AGENT_SHIM_*` by the time this runs, so the legacy name is still present beside it), and a state root still living at `~/.claude-use`.
 *
 * The root is a note, not something to move: macOS Claude Code names each identity's Keychain login after a hash of its exact `CLAUDE_CONFIG_DIR`, so relocating `~/.claude-use/identities/<name>` would sign that identity out.
 */
function pushLegacyName(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  params: Pick<RunDoctorParams, "env" | "rootPath">,
): void {
  const legacyVariables = Object.keys(params.env).filter((name) => name.startsWith(LEGACY_ENV_PREFIX) && params.env[name] !== undefined).sort();
  if (legacyVariables.length === 0 && path.basename(params.rootPath) !== LEGACY_HOME_DIRNAME) {
    push("legacy-name", "pass", "Nothing here still uses the former `claude-use` name.");
    return;
  }
  for (const name of legacyVariables) {
    push("legacy-name", "warn", `${name} is the former name of ${name.replace(LEGACY_ENV_PREFIX, ENV_PREFIX)}. Rename it; the old name still works but is only a fallback.`, name);
  }
  if (path.basename(params.rootPath) === LEGACY_HOME_DIRNAME) {
    push(
      "legacy-name",
      "warn",
      `The state root is the former ${params.rootPath}, used in place. Leave it where it is: macOS Claude Code keys each identity's Keychain login on its exact configuration directory path, so moving it signs every identity out.`,
    );
  }
}

/**
 * Audits the whole `~/.agent-shim` config graph for internal consistency: every identity, every configuration profile's own `extends` chain, every provider, `directory-rules.json`, `config.json`, `categories.local.json`, `active-identity`, plus real Claude Code binary discoverability and ambient-credential exposure.
 *
 * Deliberately identity/directory-agnostic, unlike `runCheck` — there is no single cascade to resolve `doctor` against, so it never touches settings-exposure (which only means anything relative to one resolved cascade).
 *
 * Every check aggregates rather than throws: a malformed file becomes one `fail` finding for that file, not an aborted report. This is the one place in the codebase that deliberately breaks the "throw a validation error and let it propagate" convention every other command relies on — `doctor`'s whole purpose is to survive a broken file and keep auditing everything else.
 */
export function runDoctor(params: RunDoctorParams): DoctorReport {
  const findings: DoctorFinding[] = [];
  const push = (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string): void => {
    findings.push({ section, severity, message, ...(subject === undefined ? {} : { subject }) });
  };

  /** Warns when `version` is a pin that is not installed: a launch that resolves to it fails rather than falling back, so the pin is worth fixing before it is hit. */
  const checkPin = (section: DoctorSection, subject: string | undefined, where: string, version: string | undefined): void => {
    const installed = params.installedClaudeVersions;
    if (version === undefined || installed === undefined || installed.includes(version)) {
      return;
    }
    push(section, "warn", `${where} pins Claude Code ${version}, which is not installed (installed: ${installed.length === 0 ? "none" : installed.join(", ")}); a launch that resolves to it fails.`, subject);
  };

  const ambient = detectAmbientCredential(params.env);
  if (ambient === undefined) {
    push("ambient-credential", "pass", "No ambient-credential environment variable is set.");
  } else {
    push("ambient-credential", "warn", formatAmbientCredentialGuardMessage(ambient.variable));
  }

  if (params.binaryDiscovery.ok) {
    const { binary } = params.binaryDiscovery;
    const versionNote = binary.version === undefined ? "" : `, version ${binary.version}`;
    push("binary-discovery", "pass", `Found ${binary.path} (${binary.source}${versionNote}).`);
  } else {
    push("binary-discovery", "fail", params.binaryDiscovery.message);
  }

  if (params.claudeShim.state === undefined) {
    push("claude-shim", "pass", "No `claude` command shim enabled (the default). Run `agent-shim shim enable` to add one.");
  } else if (!params.claudeShim.targetExists) {
    push(
      "claude-shim",
      "warn",
      `claude-shim.json records a \`claude\` shim at ${params.claudeShim.state.targetPath}, but nothing is there. ` +
        "Run `agent-shim shim enable` again, or `agent-shim shim disable` to clear the stale record.",
    );
  } else {
    push(
      "claude-shim",
      "pass",
      `\`claude\` is enabled at ${params.claudeShim.state.targetPath} (${params.claudeShim.state.method}). ` +
        "If you've upgraded agent-shim since, re-run `agent-shim shim enable` to refresh it.",
    );
  }

  pushPathResolution(push, params.pathResolution);
  pushLegacyName(push, params);

  const profileSources = new Map<string, ProfileSource>();
  for (const entry of params.configProfiles) {
    const validated = validateJson(ConfigProfileSchema, entry);
    if (!validated.ok) {
      push("config-profile", "fail", validated.message, entry.name);
      continue;
    }
    profileSources.set(entry.name, { name: entry.name, profile: validated.data });
    checkPin("config-profile", entry.name, `Configuration profile "${entry.name}"`, validated.data.launch?.claudeVersion);
  }
  const loadProfile: ProfileLoader = (name) => profileSources.get(name);
  for (const name of profileSources.keys()) {
    const linearised = lineariseProfile(name, loadProfile);
    if (linearised.diagnostics.length === 0) {
      push("config-profile", "pass", `${name} is valid and its extends chain resolves cleanly.`, name);
    } else {
      for (const diagnostic of linearised.diagnostics) {
        push("config-profile", "fail", diagnostic.message, name);
      }
    }
  }
  const validProfileNames = new Set(profileSources.keys());

  const validIdentityNames = new Set<string>();
  for (const entry of params.identities) {
    const validated = validateJson(IdentitySchema, entry);
    if (!validated.ok) {
      push("identity", "fail", validated.message, entry.name);
      continue;
    }
    validIdentityNames.add(entry.name);
    const defaultProfile = validated.data.defaultConfigProfile;
    if (defaultProfile !== undefined && !validProfileNames.has(defaultProfile)) {
      push(
        "identity",
        "fail",
        `Identity "${entry.name}" names configuration profile "${defaultProfile}" as its default, but no such profile exists.`,
        entry.name,
      );
    } else {
      const credential = validated.data.credential;
      const cache = credential === undefined ? { text: "", unreadable: false } : cacheClause(params.credentialCache, `identity ${entry.name}`, credential);
      push(
        "identity",
        cache.unreadable ? "fail" : "pass",
        `${entry.name} is valid and authenticates with ${credential === undefined ? "its stored login" : `credential ${describeCredential(credential)}`}${cache.text}.`,
        entry.name,
      );
    }
  }

  const validatedGlobalConfig = params.globalConfig.raw === undefined ? undefined : validateJson(GlobalConfigSchema, params.globalConfig);
  const pools = validatedGlobalConfig?.ok === true ? (validatedGlobalConfig.data.pools ?? {}) : {};
  for (const [poolName, pool] of Object.entries(pools)) {
    const missing = pool.identities.filter((member) => poolNameOf(poolMemberIdentity(member)) === undefined && !validIdentityNames.has(poolMemberIdentity(member)));
    const undefinedPools = pool.identities.flatMap((member) => {
      const nested = poolNameOf(poolMemberIdentity(member));
      return nested === undefined || nested in pools ? [] : [nested];
    });
    if (missing.length === 0 && undefinedPools.length === 0) {
      push("pool", "pass", `${poolName} is valid (${pool.identities.map(poolMemberIdentity).join(", ")}).`, poolName);
    } else {
      const problems = [
        ...missing.map((member) => `identity "${poolMemberIdentity(member)}", which does not exist`),
        ...undefinedPools.map((nested) => `pool "${nested}", which is not defined`),
      ];
      push("pool", "fail", `Pool "${poolName}" names ${problems.join(" and ")}.`, poolName);
    }
  }
  // A cycle can only appear by editing config.json by hand (add and set refuse one), and every pool on it is reported once.
  const reportedCycles = new Set<string>();
  for (const poolName of Object.keys(pools).sort()) {
    const chain = poolCycleOf(pools, poolName);
    if (chain === undefined) {
      continue;
    }
    const key = [...chain].slice(0, -1).sort().join(">");
    if (reportedCycles.has(key)) {
      continue;
    }
    reportedCycles.add(key);
    push("pool", "fail", `Pool cycle: ${chain.join(" -> ")}. A pool cannot nest itself, directly or through another pool.`, chain[0]);
  }
  /** Whether what a rule or the active-identity file selects (an identity, or `pool:<name>`) exists. */
  const selectionExists = (selector: string): boolean => {
    const poolName = poolNameOf(selector);
    return poolName === undefined ? validIdentityNames.has(selector) : poolName in pools;
  };

  for (const entry of params.providers) {
    pushProvider(push, entry, params.credentialCache, params.chatgptSignIn);
  }

  if (params.platform !== "darwin" || params.run === undefined) {
    push("keychain", "pass", "Skipped (not macOS).");
  } else {
    for (const entry of params.identities) {
      const result = lookupKeychainService(params.run, entry.farmRoot);
      push("keychain", result.found ? "pass" : "warn", result.note, entry.name);
    }
  }

  if (params.directoryRules.raw === undefined) {
    push("directory-rules", "pass", "No directory-rules.json configured.");
  } else {
    const validated = validateJson(DirectoryRulesSchema, params.directoryRules);
    if (!validated.ok) {
      push("directory-rules", "fail", validated.message);
    } else {
      push("directory-rules", "pass", `${params.directoryRules.path} is valid.`);
      for (const rule of validated.data.rules) {
        const badRefs: string[] = [];
        if (rule.identity !== undefined && !selectionExists(rule.identity)) {
          badRefs.push(poolNameOf(rule.identity) === undefined ? `identity "${rule.identity}"` : `pool "${poolNameOf(rule.identity) ?? ""}"`);
        }
        if (rule.configProfile !== undefined && !validProfileNames.has(rule.configProfile)) {
          badRefs.push(`configuration profile "${rule.configProfile}"`);
        }
        checkPin("directory-rules", rule.path, `Rule for "${rule.path}"`, rule.launch?.claudeVersion);
        if (badRefs.length > 0) {
          push("directory-rules", "fail", `Rule for "${rule.path}" names ${badRefs.join(" and ")}, which do not exist.`, rule.path);
        } else {
          push("directory-rules", "pass", `Rule for "${rule.path}" is valid.`, rule.path);
        }
      }
    }
  }

  if (params.globalConfig.raw === undefined) {
    push("global-config", "pass", "No config.json configured.");
  } else {
    const validated = validateJson(GlobalConfigSchema, params.globalConfig);
    if (!validated.ok) {
      push("global-config", "fail", validated.message);
    } else {
      const defaultProfile = validated.data.defaultConfigProfile;
      if (defaultProfile !== undefined && !validProfileNames.has(defaultProfile)) {
        push(
          "global-config",
          "fail",
          `config.json names configuration profile "${defaultProfile}" as its default, but no such profile exists.`,
        );
      } else {
        push("global-config", "pass", `${params.globalConfig.path} is valid.`);
        checkPin("global-config", undefined, "config.json", validated.data.launch?.claudeVersion);
      }
    }
  }

  if (params.categoriesLocal.raw === undefined) {
    push("categories-local", "pass", "No categories.local.json configured.");
  } else {
    const validated = validateJson(CategoryClassificationOverlaySchema, params.categoriesLocal);
    push(
      "categories-local",
      validated.ok ? "pass" : "fail",
      validated.ok ? `${params.categoriesLocal.path} is valid.` : validated.message,
    );
  }

  if (params.headroom.state.raw === undefined) {
    push("headroom", "pass", "No headroom daemon has ever run; nothing to check.");
  } else if (tcpPortEraRecord(params.headroom.state.raw)) {
    // Claimable, not broken: the single-file design treats this content as absent and the next launch through headroom overwrites it, so it must not fail the audit on a machine that never launches with headroom on.
    push("headroom", "pass", `${params.headroom.state.path} holds a previous release's TCP-port state record; the next launch through headroom claims over it.`);
  } else {
    const validated = validateJson(HeadroomStateSchema, params.headroom.state);
    if (!validated.ok) {
      push("headroom", "fail", validated.message);
    } else {
      const state = validated.data;
      const supervisorAlive = state.supervisorPid !== undefined && params.headroom.isRunning(state.supervisorPid);
      const headroomAlive = state.headroomPid !== undefined && params.headroom.isRunning(state.headroomPid);
      if (state.supervisorPid === undefined) {
        if (state.lastError === undefined) {
          push("headroom", "pass", "Headroom daemon is stopped (idle shutdown) with no recorded error.");
        } else {
          push("headroom", "warn", `Headroom supervisor is not running; last error: ${state.lastError}`);
        }
      } else if (!supervisorAlive) {
        push(
          "headroom",
          "warn",
          `Headroom state names supervisor pid ${String(state.supervisorPid)}, which is not running; the next launch through headroom will start a replacement.`,
        );
      } else if (state.headroomPid === undefined || state.socketPath === undefined) {
        push(
          "headroom",
          "warn",
          state.lastError === undefined
            ? "Headroom supervisor is running but the daemon has no healthy process; it should be restarting it."
            : `Headroom supervisor is running but the daemon is down; last error: ${state.lastError}`,
        );
      } else if (!headroomAlive) {
        push(
          "headroom",
          "warn",
          `Headroom state names daemon pid ${String(state.headroomPid)}, which is not running; its supervisor should be restarting it.`,
        );
      } else {
        push(
          "headroom",
          "pass",
          `Headroom daemon is up on unix socket ${state.socketPath} (supervisor ${String(state.supervisorPid)}, daemon ${String(state.headroomPid)}).`,
        );
      }
      if (state.lastError !== undefined && supervisorAlive) {
        push("headroom", "warn", `Headroom recorded a previous error: ${state.lastError}`);
      }
      if (state.installedSource !== undefined && isMovingGitSource(state.installedSource)) {
        push(
          "headroom",
          "warn",
          `Headroom is installed from a git ref that can move (${state.installedSource}); pin headroom.source to a full commit SHA so a rebased or deleted branch cannot change or break the install.`,
        );
      }
    }
  }

  if (params.activeIdentity.raw === undefined) {
    push("active-identity", "pass", "No active identity set.");
  } else {
    const trimmed = params.activeIdentity.raw.trim();
    if (trimmed === "") {
      push("active-identity", "warn", "active-identity is present but empty — treated the same as unset.");
    } else if (!selectionExists(trimmed)) {
      push("active-identity", "fail", `active-identity names "${trimmed}", which does not exist.`);
    } else {
      push("active-identity", "pass", `Active identity "${trimmed}" is valid.`);
    }
  }

  return { findings, ok: !findings.some((finding) => finding.severity === "fail") };
}

const SECTION_TITLES: Readonly<Record<DoctorSection, string>> = {
  "ambient-credential": "Ambient-credential exposure",
  "binary-discovery": "Claude Code binary discovery",
  "claude-shim": "`claude` command shim",
  "path-resolution": "PATH resolution",
  "legacy-name": "Former `claude-use` name",
  "config-profile": "Configuration profiles",
  identity: "Identities",
  pool: "Pools",
  provider: "Providers",
  keychain: "macOS Keychain",
  "directory-rules": "Directory rules",
  "global-config": "Global config",
  headroom: "Headroom daemon",
  "categories-local": "categories.local.json",
  "active-identity": "Active identity",
};

const SECTION_ORDER: readonly DoctorSection[] = [
  "ambient-credential",
  "binary-discovery",
  "claude-shim",
  "path-resolution",
  "config-profile",
  "identity",
  "pool",
  "provider",
  "keychain",
  "directory-rules",
  "global-config",
  "headroom",
  "categories-local",
  "active-identity",
];

function severityPrefix(severity: DoctorSeverity): string {
  switch (severity) {
    case "pass":
      return "[PASS]";
    case "warn":
      return "[WARN]";
    case "fail":
      return "[FAIL]";
    default:
      return severity satisfies never;
  }
}

/** Renders a full `DoctorReport` as plain text lines, one section header at a time, in the order `agent-shim doctor` prints them. */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const section of SECTION_ORDER) {
    const sectionFindings = report.findings.filter((finding) => finding.section === section);
    if (sectionFindings.length === 0) {
      continue;
    }
    lines.push("", `${SECTION_TITLES[section]}:`);
    for (const finding of sectionFindings) {
      const subject = finding.subject === undefined ? "" : `${finding.subject}: `;
      lines.push(`  ${severityPrefix(finding.severity)} ${subject}${finding.message}`);
    }
  }
  const failCount = report.findings.filter((finding) => finding.severity === "fail").length;
  lines.push("", report.ok ? "All checks passed." : `${String(failCount)} check(s) failed.`);
  return lines;
}

/** `fs.realpathSync` with every failure collapsed back to the input path — see `refinePathShadow` for why an unresolvable path must stay unequal rather than abort the audit. */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** What `collectDoctorReport` needs from its caller. */
export interface CollectDoctorReportParams {
  readonly paths: LayoutPaths;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Audits the whole state root against this machine: the edge adapter that enumerates every identity, configuration profile and provider on disk, reads every top-level config file as raw text (never pre-parsing, so one malformed file cannot abort the report), discovers the real Claude Code binary and resolves where a bare command name runs from, and hands the facts to the pure `runDoctor`.
 */
export function collectDoctorReport(params: CollectDoctorReportParams): DoctorReport {
  const { paths } = params;
  const identityNames = fs.existsSync(paths.identitiesDir)
    ? fs
        .readdirSync(paths.identitiesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isIdentityDirectoryName(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];
  const identities: DoctorIdentityInput[] = identityNames.map((name) => {
    const farmRoot = path.join(paths.identitiesDir, name);
    const identityPath = path.join(farmRoot, "identity.json");
    return { name, path: identityPath, raw: realFsPort.readFileUtf8(identityPath), farmRoot };
  });

  const profileNames = fs.existsSync(paths.configProfilesDir)
    ? fs
        .readdirSync(paths.configProfilesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .sort()
    : [];
  const configProfiles: DoctorConfigProfileInput[] = profileNames.map((name) => {
    const profilePath = path.join(paths.configProfilesDir, `${name}.json`);
    return { name, path: profilePath, raw: realFsPort.readFileUtf8(profilePath) };
  });

  const providerNames = fs.existsSync(paths.providersDir)
    ? fs
        .readdirSync(paths.providersDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .sort()
    : [];
  const providers: DoctorProviderInput[] = providerNames.map((name) => {
    const providerPath = path.join(paths.providersDir, `${name}.json`);
    return { name, path: providerPath, raw: realFsPort.readFileUtf8(providerPath) };
  });

  const ownExecutablePath = realOwnExecutablePath();

  let binaryDiscovery: DoctorBinaryDiscovery;
  try {
    const binary = realResolveClaudeBinary(resolveOwnBinaryCheck(paths, realContentSourcePath()))();
    binaryDiscovery = { ok: true, binary };
  } catch (error) {
    binaryDiscovery = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const shimState = readJson(paths.claudeShimFile, ClaudeShimStateSchema);

  const pathDirs = (params.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
  const claudeShimShadow =
    shimState === undefined
      ? undefined
      : refinePathShadow(
          findPathShadow({
            pathDirs,
            targetDir: path.dirname(shimState.targetPath),
            targetFilename: path.basename(shimState.targetPath),
            findExecutableInDir,
          }),
          shimState.targetPath,
          realpathOrSelf,
        );

  const report = runDoctor({
    env: params.env,
    credentialCache: realCredentialCacheEnv(paths),
    chatgptSignIn: { path: paths.chatgptSignInFile, raw: realFsPort.readFileUtf8(paths.chatgptSignInFile) },
    installedClaudeVersions: realInstalledClaudeVersions(),
    identities,
    configProfiles,
    providers,
    directoryRules: { path: paths.directoryRulesFile, raw: realFsPort.readFileUtf8(paths.directoryRulesFile) },
    globalConfig: { path: paths.globalConfigFile, raw: realFsPort.readFileUtf8(paths.globalConfigFile) },
    categoriesLocal: { path: paths.categoriesLocalFile, raw: realFsPort.readFileUtf8(paths.categoriesLocalFile) },
    activeIdentity: { path: paths.activeIdentityFile, raw: realFsPort.readFileUtf8(paths.activeIdentityFile) },
    binaryDiscovery,
    claudeShim: { state: shimState, targetExists: shimState !== undefined && fs.existsSync(shimState.targetPath) },
    rootPath: paths.root,
    pathResolution: {
      ownExecutablePath,
      agentShim: refinePathShadow(
        findPathShadow({
          pathDirs,
          targetDir: path.dirname(ownExecutablePath),
          targetFilename: commandFilename(ownExecutablePath, "agent-shim"),
          findExecutableInDir,
        }),
        ownExecutablePath,
        realpathOrSelf,
      ),
      ...(claudeShimShadow === undefined ? {} : { claude: claudeShimShadow }),
    },
    run: realRunPort,
    platform: process.platform,
    headroom: {
      // Read-only resolution like `headroom status`: the doctor reports whichever record a launch would join, migrating nothing.
      state: (() => {
        const resolved = resolveServingHeadroomState(realFarmFs, { stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile }, realIsProcessRunning);
        const statePath = resolved?.path ?? paths.headroomStateFile;
        return { path: statePath, raw: realFarmFs.readFileUtf8(statePath) };
      })(),
      isRunning: realIsProcessRunning,
    },
  });
  return report;
}

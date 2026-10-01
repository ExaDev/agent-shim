import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { z } from "zod";

import { lookupKeychainService } from "./check";
import { printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import {
  ClaudeShimStateSchema,
  commandFilename,
  findPathShadow,
  resolveOwnInstallDirs,
  type ClaudeShimState,
  type PathShadowStatus,
} from "./claudeShim";
import { ConfigValidationError } from "./config/load";
import { readJson } from "./config/store";
import {
  CategoryClassificationOverlaySchema,
  ConfigProfileSchema,
  DirectoryRulesSchema,
  GlobalConfigSchema,
  IdentitySchema,
  ProviderSchema,
} from "./config/schema";
import { describeCredential } from "./credential";
import { isMovingGitSource } from "./headroom/source";
import { HeadroomStateSchema } from "./headroom/state";
import { isIdentityDirectoryName } from "./identityManager";
import { describeProviderEndpoint, legacyProviderConversion, LegacyProviderFileError } from "./providers";
import { detectAmbientCredential, formatAmbientCredentialGuardMessage } from "./launcher/guard";
import type { RunPort } from "./launcher/ports";
import { findExecutableInDir, realFsPort, realIsProcessRunning, realOwnExecutablePath, realResolveClaudeBinary, realRunPort } from "./realPorts";
import { lineariseProfile, type ProfileLoader, type ProfileSource } from "./resolve/extends";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

type DoctorSeverity = "pass" | "warn" | "fail";

type DoctorSection =
  | "ambient-credential"
  | "binary-discovery"
  | "claude-shim"
  | "path-resolution"
  | "config-profile"
  | "identity"
  | "provider"
  | "keychain"
  | "directory-rules"
  | "global-config"
  | "categories-local"
  | "active-identity"
  | "headroom";

/** One line of `claude-use doctor`'s report. `subject` names the identity/profile/rule the finding is about, when the section has more than one of those. */
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
 * `ownExecutablePath` is this process's own PATH-visible location (`realOwnExecutablePath()`); `claudeUse` is `findPathShadow`'s verdict for a bare `claude-use` against the directory that executable lives in. `claude` is only populated when a shim is actually enabled — without one, a `claude` on PATH is Claude Code's own binary, which is not a shadow of anything.
 */
interface DoctorPathResolution {
  readonly ownExecutablePath: string;
  readonly claudeUse: PathShadowStatus;
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
  readonly identities: readonly DoctorIdentityInput[];
  readonly configProfiles: readonly DoctorConfigProfileInput[];
  readonly providers: readonly DoctorProviderInput[];
  readonly directoryRules: DoctorFileInput;
  readonly globalConfig: DoctorFileInput;
  readonly categoriesLocal: DoctorFileInput;
  readonly activeIdentity: DoctorFileInput;
  readonly binaryDiscovery: DoctorBinaryDiscovery;
  /** Whether `claude-use shim enable` has been run, and whether its recorded target still exists on disk — pre-resolved by the wiring layer, since checking a file's existence is real I/O, not a parse-shaped pure operation. */
  readonly claudeShim: { readonly state: ClaudeShimState | undefined; readonly targetExists: boolean };
  /** Which executables a bare `claude-use` (and, when the shim is enabled, a bare `claude`) would actually run — pre-resolved by the wiring layer, since scanning PATH is real I/O. */
  readonly pathResolution: DoctorPathResolution;
  /** Runs `security find-generic-password` for the per-identity Keychain check. Omit to skip that check entirely (e.g. off macOS). */
  readonly run?: RunPort;
  /** `process.platform` in real use; the Keychain check only ever runs when this is `"darwin"`. */
  readonly platform: string;
  /** The headroom daemon's state.json plus a zombie-aware liveness predicate for the pids it names (a defunct daemon holds no port but still answers signal 0). Omit the raw text when the daemon has never run; that is a pass, not a failure. */
  readonly headroom: {
    readonly state: DoctorFileInput;
    readonly isRunning: (pid: number) => boolean;
    /** The MITM proxy's CA certificate, pre-resolved by the wiring layer (a path plus whether the file exists), like `claudeShim.targetExists`: an OAuth launch points NODE_EXTRA_CA_CERTS at it, so a serving proxy without its CA file is a real finding. */
    readonly caCert: { readonly path: string; readonly exists: boolean };
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

/**
 * Reports which `claude-use` a bare command name actually runs, and — when a `claude` shim is enabled — the same for `claude`.
 *
 * A shadowed `claude-use` is a `fail`, not a `warn`, because it invalidates the rest of the report rather than merely sitting alongside it: every other finding here describes the binary that produced them, which by definition is not the binary the user's own commands reach. It is also a silent failure in every other respect, since the shadowing install keeps working, just at whatever version it was frozen at. Confirmed in the wild: a hand-written wrapper script from an earlier install channel sat ahead of `~/.local/bin` on PATH and kept re-execing a month-old binary, so a naming rule that had since widened kept rejecting an `identity.json` a current claude-use had written — with nothing anywhere reporting that the running binary was not the installed one.
 *
 * `not-on-path` is a `warn` rather than a `fail`: invoking this tool by an absolute path, or through `npx`, is a legitimate one-off, and nothing about it is inconsistent.
 */
function pushPathResolution(
  push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void,
  resolution: DoctorPathResolution,
): void {
  const ownDir = path.dirname(resolution.ownExecutablePath);
  switch (resolution.claudeUse.status) {
    case "ok":
      push("path-resolution", "pass", `\`claude-use\` on PATH resolves to this running executable, ${resolution.ownExecutablePath}.`, "claude-use");
      break;
    case "not-on-path":
      push(
        "path-resolution",
        "warn",
        `${ownDir} is not on PATH, so a bare \`claude-use\` does not reach ${resolution.ownExecutablePath}. ` +
          "Add it to PATH, or keep invoking this executable by its full path.",
        "claude-use",
      );
      break;
    case "shadowed":
      push(
        "path-resolution",
        "fail",
        `\`claude-use\` on PATH resolves to ${resolution.claudeUse.by}, not this running executable, ${resolution.ownExecutablePath}. ` +
          "Every command you type runs that one instead, at whatever version it happens to be — including the checks in this report, which describe this executable. " +
          `Remove ${resolution.claudeUse.by}, repoint it at ${resolution.ownExecutablePath}, or put ${ownDir} ahead of it on PATH.`,
        "claude-use",
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
      push("path-resolution", "warn", "The enabled `claude` shim's directory is not on PATH — add it, or use `claude-use run` instead.", "claude");
      break;
    case "shadowed":
      push(
        "path-resolution",
        "warn",
        `\`claude\` on PATH resolves to ${resolution.claude.by}, not the enabled shim. ` +
          "Put the shim's directory ahead of it on PATH, or run `claude-use shim disable` if you meant to launch that one directly.",
        "claude",
      );
      break;
  }
}

/**
 * Reports one provider file: an old-format file (before the credential block) fails with the old fields named and the whole file rewritten in the current format, since that is the one change converting it needs; any other invalid file fails with its validation errors; a valid one passes with its credential described by source kind and target.
 */
function pushProvider(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, entry: DoctorProviderInput): void {
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
  push("provider", "pass", `${entry.name} is valid (${describeProviderEndpoint(validated.data)}, credential ${describeCredential(validated.data.credential)}).`, entry.name);
}

/**
 * Audits the whole `~/.claude-use` config graph for internal consistency: every identity, every configuration profile's own `extends` chain, every provider, `directory-rules.json`, `config.json`, `categories.local.json`, `active-identity`, plus real Claude Code binary discoverability and ambient-credential exposure.
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
    push("claude-shim", "pass", "No `claude` command shim enabled (the default). Run `claude-use shim enable` to add one.");
  } else if (!params.claudeShim.targetExists) {
    push(
      "claude-shim",
      "warn",
      `claude-shim.json records a \`claude\` shim at ${params.claudeShim.state.targetPath}, but nothing is there. ` +
        "Run `claude-use shim enable` again, or `claude-use shim disable` to clear the stale record.",
    );
  } else {
    push(
      "claude-shim",
      "pass",
      `\`claude\` is enabled at ${params.claudeShim.state.targetPath} (${params.claudeShim.state.method}). ` +
        "If you've upgraded claude-use since, re-run `claude-use shim enable` to refresh it.",
    );
  }

  pushPathResolution(push, params.pathResolution);

  const profileSources = new Map<string, ProfileSource>();
  for (const entry of params.configProfiles) {
    const validated = validateJson(ConfigProfileSchema, entry);
    if (!validated.ok) {
      push("config-profile", "fail", validated.message, entry.name);
      continue;
    }
    profileSources.set(entry.name, { name: entry.name, profile: validated.data });
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
      push(
        "identity",
        "pass",
        `${entry.name} is valid and authenticates with ${credential === undefined ? "its stored login" : `credential ${describeCredential(credential)}`}.`,
        entry.name,
      );
    }
  }

  for (const entry of params.providers) {
    pushProvider(push, entry);
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
        if (rule.identity !== undefined && !validIdentityNames.has(rule.identity)) {
          badRefs.push(`identity "${rule.identity}"`);
        }
        if (rule.configProfile !== undefined && !validProfileNames.has(rule.configProfile)) {
          badRefs.push(`configuration profile "${rule.configProfile}"`);
        }
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
      } else if (state.headroomPid === undefined || state.port === undefined) {
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
        const mitm = state.mitmPort === undefined ? "" : `, MITM proxy on 127.0.0.1:${String(state.mitmPort)} (CA ${params.headroom.caCert.path})`;
        push(
          "headroom",
          "pass",
          `Headroom daemon is up on 127.0.0.1:${String(state.port)}${mitm} (supervisor ${String(state.supervisorPid)}, daemon ${String(state.headroomPid)}).`,
        );
      }
      if (state.mitmPort !== undefined && !params.headroom.caCert.exists) {
        push(
          "headroom",
          "warn",
          `The MITM proxy is serving on 127.0.0.1:${String(state.mitmPort)} but its CA certificate is missing at ${params.headroom.caCert.path}; OAuth launches cannot trust the proxy's TLS until it is regenerated.`,
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
    } else if (!validIdentityNames.has(trimmed)) {
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
  "config-profile": "Configuration profiles",
  identity: "Identities",
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

/** Renders a full `DoctorReport` as plain text lines, one section header at a time, in the order `claude-use doctor` prints them. */
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

/**
 * Registers `claude-use doctor` onto `program`.
 *
 * This is the one place in `src/doctor.ts` that performs real I/O: it enumerates every identity and configuration profile on disk, reads every top-level config file as raw text (never pre-parsing; see `runDoctor`'s own doc comment for why), resolves the real Claude Code binary the same way `runClaude` does, and hands everything already-loaded to `runDoctor`. A report containing failures is not a thrown error: `doctor` succeeds at producing a full report (text, or JSON under `--json`) even when it finds problems, so it sets `process.exitCode` to 1 rather than throwing or calling `process.exit()` (which would truncate the report already printed).
 */
export function registerDoctorCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const command = program
    .command("doctor")
    .description(
      "Audit the whole ~/.claude-use config graph: every identity, every configuration profile's extends " +
        "chain, every provider, directory-rules.json, config.json, categories.local.json, active-identity, and real Claude " +
        "Code binary discoverability. Identity/directory-agnostic, unlike `check`. Exits 1 when any check fails.",
    )
    .option("--json", "Print the report as JSON.")
    .action((options: Readonly<{ json?: boolean }>) => {
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
        const binary = realResolveClaudeBinary(resolveOwnInstallDirs(paths, ownExecutablePath))();
        binaryDiscovery = { ok: true, binary };
      } catch (error) {
        binaryDiscovery = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }

      const shimState = readJson(paths.claudeShimFile, ClaudeShimStateSchema);

      const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
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
        env: process.env,
        identities,
        configProfiles,
        providers,
        directoryRules: { path: paths.directoryRulesFile, raw: realFsPort.readFileUtf8(paths.directoryRulesFile) },
        globalConfig: { path: paths.globalConfigFile, raw: realFsPort.readFileUtf8(paths.globalConfigFile) },
        categoriesLocal: { path: paths.categoriesLocalFile, raw: realFsPort.readFileUtf8(paths.categoriesLocalFile) },
        activeIdentity: { path: paths.activeIdentityFile, raw: realFsPort.readFileUtf8(paths.activeIdentityFile) },
        binaryDiscovery,
        claudeShim: { state: shimState, targetExists: shimState !== undefined && fs.existsSync(shimState.targetPath) },
        pathResolution: {
          ownExecutablePath,
          claudeUse: refinePathShadow(
            findPathShadow({
              pathDirs,
              targetDir: path.dirname(ownExecutablePath),
              targetFilename: commandFilename(ownExecutablePath, "claude-use"),
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
          state: { path: paths.headroomStateFile, raw: realFsPort.readFileUtf8(paths.headroomStateFile) },
          isRunning: realIsProcessRunning,
          caCert: { path: paths.headroomCaCertFile, exists: realFsPort.readFileUtf8(paths.headroomCaCertFile) !== undefined },
        },
      });

      if (options.json === true) {
        printJson(report);
      } else {
        for (const line of formatDoctorReport(report)) {
          console.log(line);
        }
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
  withExamples(command, ["claude-use doctor", "claude-use doctor --json"]);
}
